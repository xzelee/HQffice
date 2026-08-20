#!/usr/bin/env python
"""Shared parser for AGENT-CHANNEL.md — the single definition of the channel format.

channel_hook.py, channel_rotate.py and chatroom-lab/chatroom_server.py all read this file. They each used
to carry their own copy of HEADER_RE; three copies of a format contract is how parsers silently drift apart.
This module is now the one place the format is defined.

Message identity
----------------
Ids are a hash of the message's own content, NOT its position in the file. That is deliberate: rotation
archives messages off the front, which renumbers every index. A positional id would break every thread link
the moment we rotate. A content hash is stable forever, and every message that already exists gets one
without rewriting a single byte of the channel.

Threading
---------
A reply marks its parent on the first line of its body:

    Re: 4f2a91

That keeps the `### <time> — <FROM> → <TO>` header contract untouched (nothing that already parses the
channel breaks), and it is greppable by a human reading the raw markdown.
"""
import hashlib
import re

HEADER_RE = re.compile(r"^###\s+(.*?)\s+—\s+(.*?)\s+→\s+(.*?)\s*$")
# `Re: abc123` alone on the line, or `Re: abc123 — rest of the sentence`. RAG's first real threaded
# reply wrote it inline and a strict end-anchor silently dropped the link -- accept how agents actually
# write, not how the spec imagined they would.
REPLY_RE = re.compile(r"^\s*>?\s*Re:\s*([0-9a-f]{6})\b[\s—:,.-]*(.*)$", re.I)
FENCE_RE = re.compile(r"^\s*(```|~~~)")

ID_LEN = 6


def header_lines(text):
    """Indices of lines that genuinely start a message.

    A header inside a fenced code block is documentation, not a message. The channel's own preamble
    contains a worked example of the header format, and agents post format examples all the time -- and a
    phantom message would shift every session's cursor, since cursors are counts. Fences are tracked so
    documentation can never masquerade as a post.
    """
    out, in_fence = [], False
    for i, line in enumerate(text.splitlines()):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence and HEADER_RE.match(line):
            out.append(i)
    return out


def message_id(time, frm, to, body):
    """Stable, content-derived. Survives rotation; independent of position in the file."""
    basis = f"{time.strip()}|{frm.strip()}|{to.strip()}|{body.strip()[:200]}"
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:ID_LEN]


def parse_messages(text):
    """-> [{idx, time, frm, to, body, id, reply_to}] in file order.

    `body` has the `Re:` marker stripped -- callers render prose, not plumbing. `reply_to` carries it.
    """
    lines = text.splitlines()
    starts = set(header_lines(text))
    raw, cur = [], None
    for i, line in enumerate(lines):
        if i in starts:
            m = HEADER_RE.match(line)
            if cur:
                raw.append(cur)
            cur = {"time": m.group(1), "frm": m.group(2), "to": m.group(3), "body": []}
        elif cur is not None:
            cur["body"].append(line)
    if cur:
        raw.append(cur)

    out = []
    for i, msg in enumerate(raw):
        lines = msg["body"]
        reply_to = None
        # The marker is the first non-empty line, if present.
        for n, line in enumerate(lines):
            if not line.strip():
                continue
            hit = REPLY_RE.match(line)
            if hit:
                reply_to = hit.group(1).lower()
                rest = hit.group(2).strip()
                # Inline form keeps its prose; marker-only lines are dropped entirely.
                lines = lines[:n] + ([rest] if rest else []) + lines[n + 1 :]
            break
        body = "\n".join(lines).strip()
        out.append(
            {
                "idx": i,
                "time": msg["time"],
                "frm": msg["frm"],
                "to": msg["to"],
                "body": body,
                "id": message_id(msg["time"], msg["frm"], msg["to"], body),
                "reply_to": reply_to,
            }
        )
    return out


# A typed authority line: `>` is deliberately NOT in the allowed prefix -- a blockquoted WILL: is quoted
# text, not a commitment (see authoritative_lines).
PROMISE_RE = re.compile(r"^\s*[*_\-\s]*WILL:\s*(.+?)\s*$", re.I)

# The receipt that PROVES a promise: `DONE: <what actually happened>` in a threaded reply from the
# promiser's own lane. This exists because a threaded reply alone proves only that its author posted
# again -- it says nothing about the promised work. Without this marker a promise can be closed by an
# unrelated follow-up, which is how the tracker meant to stop promises being forgotten acquired a way
# to forget one silently. See build_promises: a bare reply now yields "replied", not "done".
DONE_RE = re.compile(r"^\s*[*_\-\s]*DONE:\s*(.+?)\s*$", re.I)

# A durable lesson worth carrying to future sessions. Same typed-marker discipline as WILL: -- an agent
# drops `LESSON: <thing>` when it learns something non-obvious and recurring, and the consolidator
# (channel_consolidate.py) harvests these into the KNOWLEDGE-INBOX for human-gated promotion. Quarantined
# the same way (a LESSON inside a fence/quote/[EXTERNAL] block is inert).
LESSON_RE = re.compile(r"^\s*[*_\-\s]*LESSON:\s*(.+?)\s*$", re.I)

# A dependency edge: `BLOCKED: <what> ON: <who/what>`. Canonical definition lives here so both the lab
# server and the call-graph builder read the same rule (the server used to carry its own copy).
BLOCKED_RE = re.compile(r"^\s*[*_\-\s]*BLOCKED:\s*(.+?)\s+ON:\s*(.+?)\s*$", re.I)

# An authority-delegation record with an optional light schema (research 9c8417 / arXiv 2606.31498 gap:
# no standard way to express authority + accountability). Backward-compatible with the freeform
# `DECISION: GO. <comment>` the GO/NO-GO button writes: verdict is required, the ` | key: value` fields
# are optional. Recognized fields: scope (what the decision authorizes), expires (when it lapses /
# whether reversible), by (who decided -- defaults to the message author). Makes an informal habit
# machine-checkable: an expired or scope-mismatched authority can be detected instead of assumed.
DECISION_RE = re.compile(r"^\s*[*_\-\s]*DECISION:\s*(GO|NO-?GO|HOLD)\b[.:]?\s*(.*)$", re.I)
_DECISION_FIELD_RE = re.compile(r"(scope|expires?|reversible|by)\s*[:=]\s*([^|]+)", re.I)

# A consequential claim carrying a machine-checkable POINTER (K4: verify the pointer, not the payload).
# `CLAIM: <text> | check: <kind> <arg> [op value]` -- the verifier dereferences the pointer ITSELF
# (fetches the http endpoint, reads the file), so an agent cannot self-attest a passing result. The
# claim only becomes "verified" if the verifier's own fresh check passes; unreachable/error -> fail
# closed to "unverifiable", never "verified". Quarantine applies (a CLAIM in a quote/fence is inert).
CLAIM_RE = re.compile(r"^\s*[*_\-\s]*CLAIM:\s*(.+?)\s*\|\s*check:\s*(.+?)\s*$", re.I)

# Injection quarantine markers. Content a lane pastes from an external source (a web page, a paper) is
# wrapped in one of these so it cannot carry authority into the team's trusted context.
QUOTE_RE = re.compile(r"^\s*>")
EXTERNAL_START_RE = re.compile(r"^\s*(?:<<<\s*EXTERNAL\b|\[EXTERNAL\])", re.I)
EXTERNAL_END_RE = re.compile(r"^\s*(?:EXTERNAL\s*>>>|\[/EXTERNAL\])", re.I)


def authoritative_lines(body):
    """Body lines that MAY carry a typed authority line (WILL:/BLOCKED:/verdict).

    Injection quarantine: provenance follows the content, not the messenger. A directive inside a code
    fence, a blockquote (`>`), or an explicit `[EXTERNAL] ... [/EXTERNAL]` block is inert -- it cannot
    create a promise or a dependency edge -- even when a trusted lane faithfully excerpted it. This is the
    structural defense (external text becomes UNABLE to carry authority) that replaces mere tagging.
    """
    out, in_fence, in_external = [], False, False
    for line in body.splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if EXTERNAL_START_RE.match(line):
            in_external = True
            continue
        if EXTERNAL_END_RE.match(line):
            in_external = False
            continue
        if in_fence or in_external or QUOTE_RE.match(line):
            continue
        out.append(line)
    return out


def build_promises(messages, lane_of=None):
    """Open commitments: every `WILL: <thing>` line, held against its author.

    Three states, because "closed" was conflating two different facts:

      open    -- no threaded reply from the promiser's lane yet.
      replied -- such a reply exists, but nothing in it reports the work. This proves the author
                 posted again; it does NOT prove the promise was kept.
      done    -- a threaded same-lane reply carries an explicit `DONE: <what happened>` receipt.

    The distinction is not pedantry: under the old two-state rule ANY threaded self-reply closed every
    WILL in the parent, so an unrelated follow-up silently retired a promise -- the one failure the
    tracker exists to prevent. `closed` is kept as (status != "open") so existing consumers behave
    exactly as before and no historical promise is retroactively reopened; `proven` is the honest bit
    to gate on when you need the stronger claim.

    Threading is still required either way -- a later unthreaded post does not close anything, because
    "they posted something afterwards" is exactly the guess threading exists to kill. lane_of optionally
    maps a FROM string to a lane so closure matches by lane rather than exact author string. Typed lines
    that are quoted or externally sourced are inert (see authoritative_lines) -- injection quarantine.
    """
    ident = lane_of or (lambda name: (name or "").strip().lower())
    out = []
    for m in messages:
        texts = [h.group(1) for line in authoritative_lines(m["body"]) if (h := PROMISE_RE.match(line))]
        if not texts:
            continue
        replies = [
            later
            for later in messages
            if later["idx"] > m["idx"]
            and later["reply_to"] == m["id"]
            and ident(later["frm"]) == ident(m["frm"])
        ]
        # A receipt only counts from an authoritative line -- a DONE: inside a fence or a quote is
        # someone reproducing text, not reporting work (same quarantine as every other typed marker).
        proven = any(
            DONE_RE.match(line)
            for r in replies
            for line in authoritative_lines(r["body"])
        )
        status = "done" if proven else ("replied" if replies else "open")
        closed = status != "open"  # unchanged semantics for existing consumers
        for text in texts:
            out.append(
                {
                    "id": m["id"],
                    "idx": m["idx"],
                    "frm": m["frm"],
                    "time": m["time"],
                    "text": text[:300],
                    "closed": closed,
                    "status": status,
                    "proven": proven,
                    "msgs_ago": len(messages) - 1 - m["idx"],
                }
            )
    return out


def build_lessons(messages):
    """Every `LESSON: <thing>` line across the channel, with its source, newest last.

    Unlike a promise, a lesson has no "closed" state -- it is a candidate for the semantic memory
    (KNOWLEDGE.md), staged and human-promoted rather than auto-written. Quarantined lines are inert.
    Returns [{id, idx, frm, time, text}] -- one entry per LESSON line (a message may hold several).
    """
    out = []
    for m in messages:
        for line in authoritative_lines(m["body"]):
            h = LESSON_RE.match(line)
            if h:
                out.append({
                    "id": m["id"], "idx": m["idx"], "frm": m["frm"],
                    "time": m["time"], "text": h.group(1).strip()[:400],
                })
    return out


def build_claim_checks(body):
    """Every `CLAIM: <text> | check: <spec>` in a body, quarantine-aware -> [{text, check}].

    Returns only the DECLARED checks; evaluating them (dereferencing the pointer) is the verifier's job
    (channel_verify.py), kept separate so parsing has no side effects and no network/disk access.
    """
    out = []
    for line in authoritative_lines(body):
        h = CLAIM_RE.match(line)
        if h:
            out.append({"text": h.group(1).strip(), "check": h.group(2).strip()})
    return out


def build_decisions(messages):
    """Every `DECISION: <verdict>` with its parsed light schema, newest last.

    Returns [{id, idx, by, time, verdict, scope, expires, target}] -- target is the message the decision
    replies to (what it authorizes), by defaults to the author. Quarantined lines are inert. This turns
    the informal GO/NO-GO habit into a machine-checkable authority-delegation record: an auditor can ask
    'did an unexpired, in-scope decision authorize this action?' instead of trusting that one existed.
    """
    out = []
    for m in messages:
        for line in authoritative_lines(m["body"]):
            h = DECISION_RE.match(line)
            if not h:
                continue
            verdict = h.group(1).upper().replace("NOGO", "NO-GO")
            fields = {k.lower().rstrip("s"): v.strip() for k, v in _DECISION_FIELD_RE.findall(h.group(2) or "")}
            out.append({
                "id": m["id"], "idx": m["idx"], "time": m["time"],
                "by": fields.get("by") or m["frm"],
                "verdict": verdict,
                "scope": fields.get("scope"),
                # `reversible: yes` folds into expires for a single "how long does this hold" field
                "expires": fields.get("expire") or (("reversible" if fields.get("reversible") else None)),
                "target": m["reply_to"],
            })
    return out


def build_call_graph(messages):
    """Reconstruct the actual runtime work-graph from the ledger (research 5f5dcc marker #3).

    The channel is an append-only log; the WORK graph is implicit in it. This makes it explicit and
    machine-readable: each root thread is a `graph_id` (one multi-lane workflow), each message a node
    (`node_id` = its content-hash id, the stable run_id research asked us to standardize on), and edges
    are TYPED by what actually connects two nodes:
      - reply   : node B threads onto node A (`Re: <A>`)
      - closes  : B is A's author closing A's own WILL: (a promise fulfilled)
      - blocks  : A declares `BLOCKED: X ON: Y` -- a dependency edge to Y's lane
      - decides : B carries a `DECISION:` on A (an authority edge)
    Returns {graphs: [{graph_id, root_id, nodes, edges}], node_index}. Deterministic, no prose guessing --
    this is the unified single-ledger trace the A2A/MCP frontier still lacks (research 9c8417).
    """
    by_id = {m["id"]: m for m in messages}
    promises = {p["id"] for p in build_promises(messages)}
    threads = build_threads(messages)

    # map each message to its thread root => graph_id
    root_of = {}
    for t in threads:
        rid = t["root"]["id"]
        root_of[rid] = rid
        for r in t["replies"]:
            root_of[r["id"]] = rid

    edges = []
    for m in messages:
        # reply / closes edge
        if m["reply_to"] and m["reply_to"] in by_id:
            parent = by_id[m["reply_to"]]
            same_author = (m["frm"] or "").strip().lower() == (parent["frm"] or "").strip().lower()
            kind = "closes" if (same_author and parent["id"] in promises) else "reply"
            edges.append({"from": m["reply_to"], "to": m["id"], "type": kind})
        # decides edge (a DECISION replying to a target)
        for line in authoritative_lines(m["body"]):
            if DECISION_RE.match(line) and m["reply_to"] in by_id:
                edges.append({"from": m["id"], "to": m["reply_to"], "type": "decides"})
                break
        # blocks edge: BLOCKED: X ON: Y -- Y is a lane/thing, not always an id; keep the label
        for line in authoritative_lines(m["body"]):
            b = BLOCKED_RE.match(line)
            if b:
                edges.append({"from": m["id"], "to": b.group(2).strip()[:40], "type": "blocks"})

    graphs = {}
    for m in messages:
        gid = root_of.get(m["id"], m["id"])
        g = graphs.setdefault(gid, {"graph_id": gid, "root_id": gid, "nodes": [], "edges": []})
        g["nodes"].append({"node_id": m["id"], "lane": m["frm"], "time": m["time"], "idx": m["idx"]})
    for e in edges:
        gid = root_of.get(e["from"], e["from"])
        if gid in graphs:
            graphs[gid]["edges"].append(e)

    ordered = sorted(graphs.values(), key=lambda g: -max(n["idx"] for n in g["nodes"]))
    return {"graphs": ordered, "node_index": {m["id"]: root_of.get(m["id"], m["id"]) for m in messages}}


def build_threads(messages):
    """Group into threads. Returns [{root, replies:[...]}] newest-root-first.

    A reply whose parent is missing (archived, or a typo'd id) is treated as its own root rather than
    dropped -- losing a message because its parent rotated away would be worse than an orphan.
    """
    by_id = {m["id"]: m for m in messages}

    def root_of(m, seen=None):
        seen = seen or set()
        while m["reply_to"] and m["reply_to"] in by_id and m["id"] not in seen:
            seen.add(m["id"])
            m = by_id[m["reply_to"]]
        return m

    roots, order = {}, []
    for m in messages:
        r = root_of(m)
        if r["id"] not in roots:
            roots[r["id"]] = {"root": r, "replies": []}
            order.append(r["id"])
        if m["id"] != r["id"]:
            roots[r["id"]]["replies"].append(m)

    threads = [roots[i] for i in order]
    for t in threads:
        t["replies"].sort(key=lambda x: x["idx"])
        t["last_idx"] = max([t["root"]["idx"]] + [r["idx"] for r in t["replies"]])
    threads.sort(key=lambda t: -t["last_idx"])  # most recently active first
    return threads
