# HQffice

HQ-Agents — the multiplayer AI office. Self-contained: server + dashboard UI in one repo.

A live multi-agent office dashboard: real Claude sessions as office characters who talk to each other, take tasks, and report back — with a pixel office floor, a live message graph, 1:1 chat, and Claude usage monitoring. Architecture and UI are modeled on [munder-difflin](https://github.com/chaitanyagiri/munder-difflin) ("Hive"), rebuilt as a web app on the Claude Agent SDK. All art is drawn procedurally (no third-party tilesets).

## Run

```bash
npm install
npm start          # http://localhost:4643
```

Auth: uses your local Claude Code CLI login automatically (or `ANTHROPIC_API_KEY` if set).

## Multiplayer: the whole team in one office (LAN)

The floor is now a shared space — every dev walks in as their own character, Gather-style:

- **Host it once** on any machine: `npm start` prints the LAN URLs (e.g. `http://192.168.1.20:4643`). Everyone on the office network opens that URL.
- **Join the office**: first visit shows a character creator (name, skin, hair style/color, shirt, hat). You get your **own room** — your agents get desks in it. `#spectate` in the URL skips the prompt (wall-display mode).
- **Walk & talk**: arrow keys / WASD to walk, click the floor to travel, the say box (bottom-right) puts a speech bubble over your head for everyone. Stand in the **meeting room** with a teammate and it lights up with "MEETING IN PROGRESS".
- **Live session tracking**: run the beacon on your machine and your character shows a ⚡ badge, your room's monitor lights up, and your panel lists which projects you have live Claude Code sessions in:
  ```bash
  node tools/session-beacon.mjs --server http://<office-ip>:4643 --name "YourName"
  ```
- **Own your agents**: every agent has an owner (you, a teammate, or the shared office). Set it when hiring or in the agent panel — their desk moves into the owner's room.
- **Token allocation per agent**: give any agent a lifetime **token budget** (mail is held, not dropped, when exhausted — raise the budget to release it), a **reasoning-effort override** (low/medium/high), and a model tier. All in the agent panel.

## What you can do

- **+ New task** — lands on the coordinator's (Marlowe's) desk; he plans, delegates to the teammate whose role fits, tracks it on the task board, and reports the result back to you.
- **Click any character** — 1:1 chat, watch their private worklog, change their **model** (Sonnet/Opus/Haiku dropdown — restarts their conversation), edit their persona, or remove them.
- **+ Hire agent** — create a new character (name, role, persona, model, avatar). The modal ships 14 research-backed **role templates** grouped by department (automation & orchestration, engineering, marketing, research & analysis) — one click fills the form with the role's title, skill-set persona, model tier, and tool grants. The research behind them is in [`docs/ROLES.md`](docs/ROLES.md).
- **Per-agent tool grants** — roles carry capabilities: `web` (live WebSearch/WebFetch — researchers, marketers) and `files` (read the office workspace — engineers, analysts).
- **Agents hire too** — any agent (usually the coordinator) can `spawn_subagent` when no teammate fits a job; the new hire walks in the door and gets their first assignment.
- **#office chatroom (Chat tab)** — one centralized room the whole office reads: every agent and every human teammate posts there, so cross-team work context lives in one place. A plain post wakes nobody (unread messages ride into agents' turn prompts via a **per-agent delivery cursor** — nothing is ever silently missed); **@Name mentions wake that agent** through the normal mailbox router, so hop caps and token budgets still apply. Agents post with the `chat_post` tool; humans post from the Chat tab. Persisted in `workspace/chat.jsonl`.
- **Chatroom discipline layer** (mechanisms ported from a production agent channel): messages carry **content-hash ids** (rotation-proof); **threaded replies are proof-of-answer** — an @mention stays in "open asks" until the mentioned agent replies in-thread (click a message to reply); a **`WILL:`** line opens a tracked promise closed only by the author's threaded **`DONE:`** reply (open promises follow the agent into its turn context); a **`DECISION-NEEDED:`** line queues a call for the human — the Chat tab shows a "needs you" panel with GO/NO-GO buttons, and only a human's threaded `DECISION:` closes it.
- **Floor / Graph tabs** — the office floor (envelope animations tinted by speech act, thought bubbles, status halos, idle wandering) or the live node graph (agents as nodes, message flows as weighted act-colored edges with traveling pulses).
- **Claude usage panel** — per-agent turns, tokens (fresh + cache), and cost; totals in the header ticker. Persisted across restarts in `workspace/usage.json`.

## Token economics

Sessions are tuned for cost without losing quality (numbers measured on this machine):

- **~12k-token base context** per session: agents run in SDK isolation mode (`settingSources: []` — no user skills/CLAUDE.md loaded), harness tool schemas stay **deferred** behind ToolSearch, and only the 7 office tools are always-loaded (`alwaysLoad`) so no turn is wasted searching for them. Disabling deferral doubles the context (~23k) — don't.
- **Steady-state turn cost**: ~$0.005 on Haiku, ~$0.01–0.02 on Sonnet (prompt-cache reads cost ~10% of fresh input; the header ticker shows fresh vs cache split).
- **Fewer turns**: plain `ack` messages are delivered without waking the recipient; token-frugality etiquette bans courtesy-message turns; per-turn caps (`maxTurns` 12, $1 budget, effort capped per model tier — low on Haiku, medium on Sonnet/Opus).
- Editing a persona/model/tools resets that agent's session (fresh cache write, one time) — batch your edits.

## Architecture (the loop engineering)

Graph-based orchestration in the LangGraph sense, implemented directly on the Claude Agent SDK:

- **Agents are nodes = config objects** (`workspace/agents.json`): name, role, persona, model, color, desk. Creating a character is writing a config; changing its model is editing one field (session restarts, identity persists).
- **Edges = the mailbox router** (`server/router.js`): messages carry FIPA-style speech acts (`request | question | inform | ack | escalate`), a task id, and a **hop count**. The router delivers to per-agent inboxes, schedules turns (one per agent at a time, global concurrency cap), and cuts chains at the hop cap so conversations converge.
- **A turn** (`server/runtime.js`): the agent's inbox batch becomes the prompt; the session is resumed via the SDK (`resume: sessionId`) so every character keeps long-lived conversational context. Agents act only through office MCP tools: `send_message`, `list_team`, `blackboard_read/append`, `memory_save`, `update_task`, `spawn_subagent`.
- **State** = shared blackboard (`workspace/blackboard.md`), per-agent memory files (`workspace/memory/*.md`), task ledger, and an **append-only event log** (`workspace/events.jsonl`) that the dashboard renders over WebSocket — the UI is just a renderer over the event stream.
- **Prompt-cache discipline** (borrowed from munder-difflin): the system prompt contains only lifetime-stable persona text; volatile state (roster, memory, tasks) rides in the turn prompt.
- **Anti-loop guards**: reply etiquette in the system prompt (informs/acks are terminal), incremented hop counts with a hard cap, one-turn-at-a-time scheduling, per-turn budget + timeout watchdog.

## Layout

```
server/          Node backend (ESM, no build step)
  index.js       Express + WebSocket + REST API
  runtime.js     Agent turns via @anthropic-ai/claude-agent-sdk + office tools
  router.js      Mailboxes, turn scheduler, hop caps
  store.js       Agents, tasks, blackboard, memory (workspace/ persistence)
  usage.js       Per-agent token/cost aggregation
  eventlog.js    Append-only JSONL event log + pub/sub
web/             Static dashboard (vanilla JS)
  office.js      Canvas office floor (34×22 grid, BFS walking, envelopes, bubbles)
  graph.js       SVG live message graph
  app.js         State sync, chat, panels, modals
workspace/       Runtime state (gitignored)
```
