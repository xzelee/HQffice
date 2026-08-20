#!/usr/bin/env python
"""Rotate AGENT-CHANNEL.md: archive old messages, keep the channel cheap to read.

Every agent reads the channel at session start, so its size is a per-session context cost paid by every
lane. The full history is not load-bearing (decisions also live in handoffs/, execution-log/, STATE.md),
so old threads move to a dated archive and the live file keeps only recent ones.

The dangerous part is the cursors. channel_hook.py tracks each session's read position as a *count* of
messages. Dropping N messages off the front shifts every index by N, so cursors must be migrated in the
same operation -- otherwise every agent either gets the whole channel re-delivered (cursor too high is
clamped) or silently skips unread messages. Rotation and cursor migration are one atomic step here.

Safety:
  - the preamble (participants table, how-to) is never archived; it is the contract for using the channel
  - the live file is rewritten via a temp file + os.replace, so a crash cannot leave it half-written
  - a .bak copy is kept alongside
  - dry-run by default; --apply to actually write

Usage:
  python channel_rotate.py               # dry run: report what would happen
  python channel_rotate.py --apply       # rotate
  python channel_rotate.py --apply --keep 20 --threshold 40
"""
import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL = os.path.join(HERE, "AGENT-CHANNEL.md")
STATE_DIR = os.path.join(HERE, ".channel-state")

sys.path.insert(0, HERE)
import channel_parse  # noqa: E402  (path must be set first)

HEADER_RE = channel_parse.HEADER_RE  # one definition of the format, shared
ARCHIVE_POINTER_RE = re.compile(r"^> \*\*Archived:\*\*", re.M)

DEFAULT_THRESHOLD = 40  # rotate once the channel exceeds this many messages
DEFAULT_KEEP = 20  # how many recent messages stay live


def split_channel(text):
    """-> (preamble, [(header_line, body_text), ...]) preserving exact original text.

    Uses the shared fence-aware header scan: a `### a — b → c` inside a code fence is documentation, and
    splitting on it would slice a real message in half and archive the pieces separately.
    """
    lines = text.splitlines(keepends=True)
    starts = channel_parse.header_lines(text)
    if not starts:
        return text, []
    preamble = "".join(lines[: starts[0]])
    blocks = []
    for n, s in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        blocks.append((lines[s].rstrip("\n"), "".join(lines[s:end])))
    return preamble, blocks


def archive_name(blocks_to_archive):
    """Dated by the newest archived message, so the filename says what is inside."""
    stamp = None
    for header, _ in reversed(blocks_to_archive):
        m = HEADER_RE.match(header)
        if m:
            d = re.match(r"(\d{4}-\d{2})", m.group(1).strip())
            if d:
                stamp = d.group(1)
                break
    return f"AGENT-CHANNEL-archive-{stamp or 'undated'}.md"


def migrate_cursors(dropped, apply):
    """Shift every session's read position left by the number of archived messages.

    Clamped at 0. A session that had read nothing stays at nothing; a session that was current stays
    current. Without this, rotation would silently re-deliver or skip for every live agent.
    """
    moved = []
    if not os.path.isdir(STATE_DIR):
        return moved
    for name in sorted(os.listdir(STATE_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(STATE_DIR, name)
        try:
            with open(path, encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            continue
        before = state.get("seen_count", 0)
        after = max(0, before - dropped)
        moved.append((name[:8], before, after))
        if apply and after != before:
            state["seen_count"] = after
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(state, fh)
            os.replace(tmp, path)
    return moved


def rotate(threshold=DEFAULT_THRESHOLD, keep=DEFAULT_KEEP, apply=False):
    with open(CHANNEL, encoding="utf-8") as fh:
        text = fh.read()

    preamble, blocks = split_channel(text)
    total = len(blocks)
    result = {
        "total": total,
        "threshold": threshold,
        "keep": keep,
        "rotated": False,
        "archived": 0,
        "archive_file": None,
        "cursors": [],
    }
    if total <= threshold:
        result["reason"] = f"{total} messages, threshold {threshold} — nothing to do"
        return result
    if keep >= total:
        result["reason"] = "keep >= total — nothing to do"
        return result

    old, live = blocks[: total - keep], blocks[total - keep :]
    fname = archive_name(old)
    apath = os.path.join(HERE, fname)

    body = "".join(b for _, b in old)
    header = (
        f"# Agent channel archive — {fname.replace('AGENT-CHANNEL-archive-', '').replace('.md', '')}\n\n"
        "> Rotated out of `AGENT-CHANNEL.md` to keep the live channel cheap for every agent to read at\n"
        "> session start. Nothing here is lost; decisions also live in `handoffs/`, `execution-log/`, and\n"
        "> `STATE.md`. Append-only, same format as the live channel.\n\n"
    )

    pointer = (
        f"> **Archived:** older messages live in [`{fname}`]({fname}) — "
        f"rotated at {total} messages, {len(live)} kept live.\n"
    )
    # Replace any previous pointer rather than stacking one per rotation.
    clean_preamble = ARCHIVE_POINTER_RE.sub("", preamble).rstrip("\n") + "\n\n" + pointer + "\n"
    new_text = clean_preamble + "".join(b for _, b in live)

    result.update(
        {
            "rotated": True,
            "archived": len(old),
            "archive_file": fname,
            "kept": len(live),
        }
    )
    result["cursors"] = migrate_cursors(len(old), apply)

    if not apply:
        result["reason"] = "dry run — pass --apply to write"
        return result

    # Archive first: appending is additive, so a failure here leaves the live file untouched.
    with open(apath, "a", encoding="utf-8") as fh:
        if fh.tell() == 0:
            fh.write(header)
        fh.write(body)

    shutil.copyfile(CHANNEL, CHANNEL + ".bak")
    tmp = CHANNEL + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(new_text)
    os.replace(tmp, CHANNEL)  # atomic on Windows and POSIX

    result["reason"] = "rotated"
    return result


def main():
    ap = argparse.ArgumentParser(description="Rotate the agent channel.")
    ap.add_argument("--apply", action="store_true", help="actually write (default is a dry run)")
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    ap.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    args = ap.parse_args()

    r = rotate(threshold=args.threshold, keep=args.keep, apply=args.apply)
    print(json.dumps({k: v for k, v in r.items() if k != "cursors"}, indent=2))
    if r["cursors"]:
        print("cursors:")
        for short, before, after in r["cursors"]:
            print(f"  {short}  {before} -> {after}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
