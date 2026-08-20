#!/usr/bin/env python
"""Deterministic delivery of AGENT-CHANNEL.md messages into every agent session.

Claude Code runs this as a hook, so it does not depend on any agent remembering to read the
channel. Stan should never have to tell agent B that agent A left a message.

Modes (argv[1]):
  deliver  -- SessionStart / UserPromptSubmit: inject messages this session has not seen yet,
              then advance this session's cursor.
  remind   -- Stop: if the session changed the repo but never posted to the channel, say so.

Per-session cursor lives in .channel-state/<session_id>.json (gitignored). Keying on session_id
rather than a lane name keeps this zero-config: no agent has to declare who it is, and every
session sees everything new -- which is the point ("para aware yung all agents").

Reads hook JSON on stdin, writes hook JSON on stdout. Never fails the session: any unexpected
error exits 0 silently, because a broken hook must not be able to block an agent from working.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL = os.path.join(HERE, "AGENT-CHANNEL.md")
STATE_DIR = os.path.join(HERE, ".channel-state")
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

sys.path.insert(0, HERE)  # this hook runs from any cwd; the parser lives beside it
from channel_parse import parse_messages  # noqa: E402  (path must be set first)
from channel_personas import persona_for  # noqa: E402

MAX_MESSAGES = 6      # newest N unread; older ones are pointed at, not pasted
MAX_BODY_CHARS = 900  # per message, so one long post can't blow up everyone's context

# Valid lane names a session may declare. Substring-matched against message TO fields, same rule the
# lab uses, so "DevOps agent" addresses lane "devops".
KNOWN_LANES = ("backend", "designer", "reviewer", "ops")


def emit(event, context=None, system_message=None):
    out = {"suppressOutput": True}
    if context:
        out["hookSpecificOutput"] = {
            "hookEventName": event,
            "additionalContext": context,
        }
    if system_message:
        out["systemMessage"] = system_message
    sys.stdout.write(json.dumps(out))
    sys.exit(0)


def state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "unknown")
    return os.path.join(STATE_DIR, safe + ".json")


def load_state(session_id):
    try:
        with open(state_path(session_id), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(session_id, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(state_path(session_id), "w", encoding="utf-8") as fh:
        json.dump(state, fh)


def do_set_lane(argv):
    """CLI: `channel_hook.py set-lane <session_id> <lane>` — a session declares who it is, once.

    Sessions are anonymous to the harness (the hook only sees a session id), so lane identity is
    self-declared. The delivery text tells an undeclared session its own id and the exact command to run.
    After this, telemetry shows the lane name instead of a hex id, and deliveries flag messages that are
    addressed to this lane specifically.
    """
    if len(argv) != 2:
        print("usage: channel_hook.py set-lane <session_id> <lane>", file=sys.stderr)
        return 1
    session_id, lane = argv[0], argv[1].strip().lower()
    if lane not in KNOWN_LANES:
        print(f"unknown lane {lane!r}; one of: {', '.join(KNOWN_LANES)}", file=sys.stderr)
        return 1
    state = load_state(session_id)
    state["lane"] = lane
    save_state(session_id, state)
    print(f"lane set: {session_id[:8]} -> {lane}")
    return 0


def addressed_to(msg, lane):
    return bool(lane) and lane in (msg.get("to") or "").lower()


def render(unread, hidden, lane=None, session_id=""):
    lines = [
        "AGENT CHANNEL — %d unread message(s) since this session last looked."
        % (len(unread) + hidden),
        "Source: docs/agent-sync/AGENT-CHANNEL.md",
        "",
    ]
    # ACT-NOW banner, at the very TOP before anything else. A buried "addressed to you" flag is an
    # instruction the agent may skim past; a top-of-context imperative is a mechanism. If any unread
    # message is addressed to this lane, say so loudly and tell it to act FIRST -- so the human does
    # not have to poke the session with "may chat, check mo". Actionable != destructive: the standing
    # safety rule still holds (confirm irreversible / client-facing actions).
    mine = [m for m in unread if addressed_to(m, lane)]
    if mine:
        ids = ", ".join(m["id"] for m in mine)
        lines.append(
            "==================================================================\n"
            "*** %d MESSAGE(S) ADDRESSED TO YOUR LANE (%s) — ACT ON THESE FIRST ***\n"
            "==================================================================\n"
            "Do not wait to be told. Read the message(s) below marked ADDRESSED TO YOUR LANE\n"
            "[%s], do what they ask, and post your result (a threaded reply, `DONE:` when finished).\n"
            "Still confirm anything destructive or client-facing before doing it." % (len(mine), lane, ids)
        )
        lines.append("")
    persona = persona_for(lane)
    if persona:
        lines.append(persona)
        lines.append("")
    # The lane's situational brief, computed fresh right here rather than read from a maintained
    # file. Telling an agent to go read STATE.md is a hope; putting the derived state in front of it
    # is a mechanism. Wrapped so a brief failure can never cost a session its channel delivery.
    if lane:
        try:
            from channel_brief import build_brief

            brief = build_brief(lane)
            if brief:
                lines.append(brief)
                lines.append("")
        except Exception:
            pass
    if hidden:
        lines.append(
            "(%d older unread message(s) not shown — read the file if you need them.)" % hidden
        )
        lines.append("")
    for msg in unread:
        body = msg["body"]
        if len(body) > MAX_BODY_CHARS:
            body = body[:MAX_BODY_CHARS].rstrip() + "\n[...truncated — full text in the channel file]"
        re_note = " (replying to %s)" % msg["reply_to"] if msg.get("reply_to") else ""
        for_you = "  <<< ADDRESSED TO YOUR LANE" if addressed_to(msg, lane) else ""
        lines.append(
            "--- [%s] %s — %s → %s%s%s"
            % (msg["id"], msg["time"], msg["frm"], msg["to"], re_note, for_you)
        )
        lines.append(body)
        lines.append("")
    lines.append(
        "Act on anything addressed to your lane or to ALL. Report your work back by appending\n"
        "`### <ISO time> — <YOUR LANE> → <TO>`. Do not rewrite others' messages.\n"
        "\n"
        "THREADS: the `[id]` above each message is its permanent id. To reply *to a specific message*\n"
        "rather than starting a new topic, make `Re: <id>` the first line of your body — e.g. `Re: 4f2a91`.\n"
        "That links your reply to it in the Chatroom Lab and makes 'who answered what' a fact instead of a\n"
        "guess. Use it whenever you are answering someone; start a fresh message only for a new topic.\n"
        "\n"
        "PROMISES: when you commit to future work in a message, write it as a line starting `WILL: <thing>`.\n"
        "The lab tracks every WILL: as an open promise against your lane until you post a threaded reply\n"
        "(`Re: <that message's id>`) reporting it done. Unmarked commitments are invisible and get lost."
    )
    if not lane:
        lines.append(
            "\nLANE CHECK: this session has not declared which lane it is, so telemetry shows it as a hex id\n"
            "and deliveries cannot flag messages addressed to you. Declare it ONCE by running:\n"
            '  python "C:/Users/STAN/RAG/Smart_Agent/docs/agent-sync/channel_hook.py" set-lane %s <lane>\n'
            "where <lane> is one of: %s." % (session_id, ", ".join(KNOWN_LANES))
        )
    return "\n".join(lines)


def maybe_rotate():
    """Auto-rotate once the channel crosses the threshold. Stan wants zero manual steps.

    Runs inside the delivery hook, so the same mechanism that makes reading automatic makes rotation
    automatic. Cursor migration is part of rotate() itself, so no session loses or re-reads anything.
    A lock directory (atomic create on every platform) stops two sessions that fire simultaneously from
    both rotating; a stale lock older than 5 minutes is reclaimed.
    """
    import time

    import channel_rotate

    lock = os.path.join(STATE_DIR, "rotate.lock")
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            os.mkdir(lock)
        except FileExistsError:
            if time.time() - os.path.getmtime(lock) < 300:
                return  # someone else is rotating right now
            os.rmdir(lock)
            os.mkdir(lock)
        try:
            channel_rotate.rotate(apply=True)  # no-op below threshold
        finally:
            os.rmdir(lock)
    except Exception:
        pass  # rotation must never break delivery


def do_deliver(payload, event):
    session_id = payload.get("session_id", "")
    maybe_rotate()
    try:
        with open(CHANNEL, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        sys.exit(0)

    messages = parse_messages(text)
    state = load_state(session_id)
    seen = state.get("seen_count", 0)

    # A session that has never looked gets a bounded catch-up, not the whole 22 KB history.
    unread = messages[seen:]
    state["seen_count"] = len(messages)
    save_state(session_id, state)

    lane = state.get("lane")

    if not unread:
        sys.exit(0)

    hidden = max(0, len(unread) - MAX_MESSAGES)
    shown = unread[-MAX_MESSAGES:]
    for_you = sum(1 for m in unread if addressed_to(m, lane))
    note = (" %d addressed to your lane (%s)." % (for_you, lane)) if for_you else ""
    emit(
        event,
        context=render(shown, hidden, lane=lane, session_id=session_id),
        system_message="Agent channel: %d unread message(s) loaded.%s" % (len(unread), note),
    )


def lane_of_name(name):
    low = (name or "").lower()
    for lane in KNOWN_LANES:
        if lane in low:
            return lane
    return None


def open_promises_for(messages, lane):
    """This lane's own WILL: lines that have no threaded completion yet — its 'land the plane' checklist."""
    if not lane:
        return []
    from channel_parse import build_promises
    return [p for p in build_promises(messages, lane_of=lane_of_name)
            if not p["closed"] and lane_of_name(p["frm"]) == lane]


def do_remind(payload):
    """Stop = end of a session: the 'land the plane' moment. Two deterministic reminders, at most once
    per session: (1) you changed the repo but posted nothing; (2) you have open WILL: promises to close
    or update. (2) is the session-end ritual that replaces chasing agents with a background nudger —
    every lane is reminded of its own unfinished promises exactly when it stops, by its own session."""
    session_id = payload.get("session_id", "")
    state = load_state(session_id)
    if state.get("reminded"):
        sys.exit(0)  # once per session; this is a nudge, not a nag

    try:
        with open(CHANNEL, encoding="utf-8") as fh:
            messages = parse_messages(fh.read())
    except OSError:
        sys.exit(0)

    lane = state.get("lane")
    parts = []

    # (1) Unreported work: changed the repo, posted nothing this session.
    posted_this_session = len(messages) > state.get("seen_count", 0)
    if not posted_this_session:
        try:
            dirty = subprocess.run(
                ["git", "status", "--porcelain"], cwd=REPO_ROOT,
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            dirty = ""
        if dirty:
            parts.append(
                "You changed the repo this session but posted nothing to "
                "docs/agent-sync/AGENT-CHANNEL.md. Append `### <ISO time> — <YOUR LANE> → <TO>` with what "
                "you did, unless this session's work was trivial or already reported."
            )

    # (2) Session-end promise ritual: close or update your own open WILL: lines before you stop.
    open_wills = open_promises_for(messages, lane)
    if open_wills:
        listed = "\n".join("  - [%s] %s" % (p["id"], p["text"][:90]) for p in open_wills[:6])
        parts.append(
            "Before ending: you have %d open WILL: promise(s). Close each done one with a threaded reply "
            "(`Re: <that id>`) reporting the result, or post a one-line status / updated ETA if still in "
            "progress. Do not leave them silently open — that is how the channel loses track.\n%s"
            % (len(open_wills), listed)
        )

    # (3) Lesson capture: if this session had real activity, invite a durable lesson into semantic memory.
    # Only when something happened (posted or an open promise exists) — never on a trivial idle session.
    if parts or posted_this_session:
        parts.append(
            "If this session taught you something non-obvious and recurring (a root cause, a gotcha, a "
            "pattern worth reusing), post a line starting `LESSON: <thing>`. The consolidator stages it "
            "into KNOWLEDGE-INBOX.md for promotion — this is how a hard-won insight reaches future "
            "sessions instead of dying in the log. Skip it if nothing durable came up."
        )

    if not parts:
        sys.exit(0)

    state["reminded"] = True
    save_state(session_id, state)
    emit(
        "Stop",
        context="AGENT CHANNEL — session-end check:\n\n" + "\n\n".join(parts),
        system_message="Agent channel: session-end reminder (unreported work / open promises).",
    )


def main():
    # set-lane is a human/agent CLI call, not a hook invocation: no stdin payload, no cwd guard.
    if len(sys.argv) > 1 and sys.argv[1] == "set-lane":
        sys.exit(do_set_lane(sys.argv[2:]))

    try:
        raw = sys.stdin.read()
    except (OSError, UnicodeError):
        sys.exit(0)
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        payload = {}

    # A bridge/tool spawn sets this so the channel delivery + set-lane/post instructions do not reach
    # it and derail a read-only, single-purpose session (it should only see the prompt it was given).
    if os.environ.get("CHANNEL_HOOK_SILENT") == "1":
        sys.exit(0)

    # Only speak up inside the Smart_Agent repo — these settings are user-scoped and apply everywhere,
    # so a session in some unrelated folder must get nothing. HelloAlex has its own separate stack.
    cwd = os.path.abspath(payload.get("cwd") or os.getcwd())
    try:
        if os.path.commonpath([cwd, REPO_ROOT]) != REPO_ROOT:
            sys.exit(0)
    except ValueError:  # different drive, etc.
        sys.exit(0)

    mode = sys.argv[1] if len(sys.argv) > 1 else "deliver"
    if mode == "remind":
        do_remind(payload)
    else:
        do_deliver(payload, payload.get("hook_event_name") or "SessionStart")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
