// agent-office — live multi-agent office dashboard server.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import os from 'node:os';
import { initEventLog, emit, emitTransient, subscribe, recentEvents } from './eventlog.js';
import {
  WORKSPACE, MAP, initStore, listAgents, getAgent, createAgent, updateAgent, removeAgent,
  setAgentSession, grantSkill, listTasks, createTask, updateTask, getOrchestrator, readBlackboard, appendBlackboard,
  listPeople, getPerson, createPerson, updatePerson, setPersonPresence, setPersonPos,
  setPersonSessions, expireStaleSessions, heartbeatConnection, expireStaleConnections, heartbeatAgent, expireStaleAgentPings,
} from './store.js';
import { sendMessage, pendingCounts, pump, setPaused, isPaused } from './router.js';
import { initChat, postChat, recentChat, chatDerived, rotateChat } from './chatroom.js';
import { initBrain, getBrain, setBrain, listBrain, readBrain, searchBrain } from './brain.js';
import { initBrainWatch } from './brainwatch.js';
import { SKILLS, getSkill } from './shop.js';
import { initMemStore, listMemoryStore, readMemoryRaw, writeMemoryStore } from './memstore.js';
import { initXp, xpSummary } from './xp.js';
import { initTicketSync, syncTickets } from './ticketsync.js';
import { initUsage, usageSummary } from './usage.js';
import { initRuntime, ensureDefaultRoster, MODEL_CHOICES } from './runtime.js';
import { ROLE_PRESETS } from './roles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4643;

// The dashboard UI lives in the kooyahq_fe repo (hq-agents/web). Resolution:
// WEB_DIR env var → local ../web → sibling checkout of kooyahq_fe.
import fs from 'node:fs';
const WEB_DIR = [
  process.env.WEB_DIR,
  path.join(here, '..', 'web'),
  path.join(here, '..', '..', '..', 'kooyahq_fe', 'hq-agents', 'web'),
].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'index.html')));

initEventLog(WORKSPACE);
initStore();
initChat(WORKSPACE);
initBrain(WORKSPACE);
initBrainWatch(WORKSPACE);
initMemStore(WORKSPACE);
initXp(WORKSPACE);
initUsage(WORKSPACE);
initRuntime();
ensureDefaultRoster();
initTicketSync();

const app = express();
app.use(express.json({ limit: '1mb' }));
if (WEB_DIR) {
  app.use(express.static(WEB_DIR));
} else {
  console.warn('hq-agents: dashboard UI not found — running API-only. Set WEB_DIR to kooyahq_fe/hq-agents/web.');
}

// --- state snapshot -----------------------------------------------------
app.get('/api/state', (_req, res) => {
  res.json({
    agents: listAgents(),
    tasks: listTasks(),
    people: listPeople(),
    map: MAP,
    usage: usageSummary(),
    blackboard: readBlackboard(),
    pending: pendingCounts(),
    chat: recentChat(200),
    chatMeta: chatDerived(),
    schedulerPaused: isPaused(),
    meetingCall,
    brain: getBrain(),
    memoryStore: listMemoryStore(),
    xp: xpSummary(),
    models: MODEL_CHOICES,
    presets: ROLE_PRESETS,
    events: recentEvents(150),
  });
});

// --- people (real teammates) -------------------------------------------
app.post('/api/people', (req, res) => {
  const { name, appearance } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  // Rejoining with an existing name reclaims that character (an IP change
  // wipes browser localStorage — that must never mint a duplicate person).
  const existing = listPeople().find((p) => p.name.toLowerCase() === String(name).trim().toLowerCase());
  if (existing) {
    if (appearance) updatePerson(existing.id, { appearance });
    return res.json({ person: getPerson(existing.id) });
  }
  const person = createPerson({ name, appearance });
  res.json({ person });
});

app.patch('/api/people/:id', (req, res) => {
  const person = updatePerson(req.params.id, req.body || {});
  if (!person) return res.status(404).json({ error: 'no such person' });
  res.json({ person });
});

// Session beacon: each dev's machine reports its live Claude Code sessions.
app.post('/api/people/:id/sessions', (req, res) => {
  const person = setPersonSessions(req.params.id, req.body?.sessions);
  if (!person) return res.status(404).json({ error: 'no such person — join the office first' });
  emitTransient('person_sessions', { personId: person.id, sessions: person.sessions });
  res.json({ ok: true, sessions: person.sessions.length });
});

// --- agents -------------------------------------------------------------
app.post('/api/agents', (req, res) => {
  const { name, role, persona, model, color, avatar, tools, ownerId, budgetTokens, effort, external } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
  const agent = createAgent({ name, role, persona: persona || '', model: model || 'sonnet', color, avatar, tools, ownerId: ownerId || null, external: !!external });
  if (budgetTokens || effort) updateAgent(agent.id, { budgetTokens: budgetTokens || null, effort: effort || null });
  res.json({ agent: getAgent(agent.id) });
});

app.patch('/api/agents/:id', (req, res) => {
  const agent = updateAgent(req.params.id, req.body || {});
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  queueMicrotask(pump);   // a raised budget releases held mail
  res.json({ agent });
});

app.delete('/api/agents/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  if (agent.isOrchestrator) return res.status(400).json({ error: 'cannot remove the orchestrator' });
  removeAgent(req.params.id);
  res.json({ ok: true });
});

// --- chat: user -> agent DM --------------------------------------------
app.post('/api/agents/:id/message', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const out = sendMessage({ from: 'user', to: agent.id, act: 'request', body });
  res.json(out);
});

// --- chatroom: humans post to #office ----------------------------------
app.post('/api/chat', (req, res) => {
  const { personId, body, replyTo } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const person = personId ? getPerson(personId) : null;
  const out = postChat({
    from: person ? person.id : 'user',
    fromKind: person ? 'person' : 'user',
    name: person ? person.name : 'user',
    body,
    replyTo: replyTo || null,
  });
  res.json({ ok: true, id: out.msg.id, woke: out.woke });
});

// Controls are localhost-only (the lab's rule): the server binds 0.0.0.0
// for the LAN, but ops that speak as others or pause the office belong to
// whoever runs the host machine.
function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'controls are localhost-only — run this from the host machine' });
}

// Controls: post to #office as any agent or lane (the lab's "post to
// channel" control — appends, never edits).
app.post('/api/chat/as', localOnly, (req, res) => {
  const { agentId, body, replyTo } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const agent = agentId ? getAgent(agentId) : null;
  if (agentId && !agent) return res.status(404).json({ error: 'no such agent' });
  const out = agent
    ? postChat({ from: agent.id, fromKind: 'agent', name: agent.name, body, replyTo: replyTo || null })
    : postChat({ from: 'user', fromKind: 'user', name: 'user', body, replyTo: replyTo || null });
  res.json({ ok: true, id: out.msg.id, woke: out.woke });
});

// The Baul (team memory store) — office-wide like the chatroom: teammates
// read raw topics and write through the same audited path agents use.
app.get('/api/memory/raw', (req, res) => {
  try { res.json(readMemoryRaw(req.query.topic)); }
  catch (e) { res.status(404).json({ error: String(e.message || e) }); }
});
app.post('/api/memory', (req, res) => {
  const { topic, content, append, personId } = req.body || {};
  if (!topic || content === undefined) return res.status(400).json({ error: 'topic and content required' });
  const person = personId ? getPerson(personId) : null;
  try { res.json(writeMemoryStore({ topic, content, append: !!append, by: person ? person.id : 'user' })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Controls: archive rotation for the chat log.
app.post('/api/chat/rotate', localOnly, (req, res) => {
  res.json(rotateChat(Math.max(20, +req.body?.keep || 100)));
});

// Controls: pause/resume the turn scheduler (mail is held, not dropped).
app.post('/api/scheduler', localOnly, (req, res) => {
  res.json({ paused: setPaused(!!req.body?.paused) });
});

// Controls: configure the project brain (read-only knowledge roots). A brain
// change alters every agent's system prompt, so all sessions restart fresh.
app.post('/api/brain', localOnly, (req, res) => {
  try {
    const out = setBrain(req.body?.brain ?? req.body ?? null);
    for (const a of listAgents()) setAgentSession(a.id, null);
    res.json({ brain: out });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Meeting call: when someone calls a meeting, EVERYONE shows up — every
// client walks its agents to the conference table while this is active,
// and the call is announced in #office. Live state only, not persisted.
let meetingCall = null;   // { active, by, name, ts } | null
app.post('/api/meeting', (req, res) => {
  const { active, personId } = req.body || {};
  const person = personId ? getPerson(personId) : null;
  const name = person ? person.name : 'user';
  meetingCall = active ? { active: true, by: person ? person.id : 'user', name, ts: Date.now() } : null;
  emit('meeting_call', { active: !!active, name });
  postChat({
    from: person ? person.id : 'user', fromKind: person ? 'person' : 'user', name,
    body: active
      ? '📣 MEETING CALLED — everyone to the conference table in the HQ Hall, right now! Attendance required.'
      : '📣 Meeting adjourned — back to work, thanks everyone!',
  });
  res.json({ meetingCall });
});

// The hall billboard: the wall TV is wired to the shared blackboard. Read
// it, or pin a note — pinning appends through the same audited path agents
// use (blackboard_append), so a pinned note reaches every agent's context.
app.get('/api/blackboard', (_req, res) => res.json({ blackboard: readBlackboard() }));
app.post('/api/blackboard', (req, res) => {
  const { text, personId } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const person = personId ? getPerson(personId) : null;
  appendBlackboard(`[${person ? person.name : 'user'}] ${String(text).trim().slice(0, 2000)}`, person ? person.id : 'user');
  res.json({ ok: true, blackboard: readBlackboard() });
});

// Skills Shop: catalog + purchase. Buying equips the skill (its instruction
// lands in the agent's system prompt), so the session restarts fresh.
app.get('/api/shop', (_req, res) => res.json({ skills: SKILLS }));
app.post('/api/shop/buy', (req, res) => {
  const { agentId, skillId } = req.body || {};
  const agent = getAgent(agentId);
  if (!agent) return res.status(404).json({ error: 'no such agent' });
  if (!getSkill(skillId)) return res.status(404).json({ error: 'no such skill' });
  if ((agent.skills || []).includes(skillId)) return res.status(400).json({ error: 'already equipped' });
  grantSkill(agentId, skillId);
  setAgentSession(agentId, null);
  res.json({ agent: getAgent(agentId) });
});

// Brain browser: read-only endpoints behind the BRAIN CORE terminal on the
// floor. Same bounded reads every agent already has (brain_list / brain_read
// / brain_search) — office-wide like the rest of the dashboard, no write path.
app.get('/api/brain/list', (req, res) => {
  try { res.json({ listing: listBrain(req.query.ref || null) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/brain/read', (req, res) => {
  try { res.json({ ref: req.query.ref, body: readBrain(req.query.ref, +req.query.offset || 1, +req.query.limit || 300) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/brain/search', (req, res) => {
  try { res.json({ hits: searchBrain(req.query.q, req.query.root || null) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Controls: re-sync the HALM ticket mirror from the brain vault on demand.
app.post('/api/tasks/sync', localOnly, (_req, res) => {
  try { res.json(syncTickets()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- tasks: dashboard -> orchestrator ----------------------------------
app.post('/api/tasks', (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const task = createTask({ title, description });
  const boss = getOrchestrator();
  if (boss) {
    sendMessage({
      from: 'user', to: boss.id, act: 'request', taskId: task.id,
      body: `New task ${task.id}: "${title}"${description ? `\n\nDetails: ${description}` : ''}\n\nPlan it, delegate to the right teammates (or spawn a subagent if a needed specialty is missing), track progress, and send the user an "inform" message when it is done.`,
    });
  }
  res.json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = updateTask(req.params.id, req.body || {});
  if (!task) return res.status(404).json({ error: 'no such task' });
  res.json({ task });
});

// --- server + websocket -------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// One person can have several tabs open; they're offline when the last closes.
const socketsByPerson = new Map();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  let personId = null;
  const unsub = subscribe((event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello' && msg.personId && getPerson(msg.personId)) {
      personId = msg.personId;
      socketsByPerson.set(personId, (socketsByPerson.get(personId) || 0) + 1);
      setPersonPresence(personId, true);
    } else if (msg.type === 'move' && personId) {
      const pos = { x: Math.max(0, Math.min(MAP.w - 1, +msg.x || 0)), y: Math.max(0, Math.min(MAP.h - 1, +msg.y || 0)) };
      setPersonPos(personId, pos);
      emitTransient('person_moved', { personId, x: pos.x, y: pos.y, face: msg.face || 'down' });
    } else if (msg.type === 'say' && personId && msg.text) {
      const person = getPerson(personId);
      emit('person_said', { personId, name: person?.name, text: String(msg.text).slice(0, 280) });
    }
  });

  ws.on('close', () => {
    unsub();
    if (personId) {
      const n = (socketsByPerson.get(personId) || 1) - 1;
      if (n <= 0) { socketsByPerson.delete(personId); setPersonPresence(personId, false); }
      else socketsByPerson.set(personId, n);
    }
  });
});

// One-line onboarding: the server serves a personalized installer per
// teammate — `irm http://<office>/install/juls | iex` does everything
// (bridge download, identity-baked config, safe hook merge, self-check).
// We set them up; they paste one line.
app.get('/office-bridge.mjs', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(here, '..', 'tools', 'office-bridge.mjs'));
});

// Linux/macOS variant: curl -fsSL http://<office>/install/<name>.sh | bash
app.get('/install/:name.sh', (req, res) => {
  const person = listPeople().find((p) => p.name.toLowerCase() === String(req.params.name).toLowerCase());
  if (!person) return res.status(404).type('text/plain').send(`# no teammate named "${req.params.name}" — walk into the office first (or check spelling)`);
  const base = `http://${req.headers.host}`;
  const cfg = JSON.stringify({ server: base, personId: person.id, name: person.name }, null, 2);
  res.type('text/plain').send(`#!/usr/bin/env bash
# HQ office-bridge installer for ${person.name} — generated by the office
set -e
DIR="$HOME/.hqffice"
mkdir -p "$DIR"
curl -fsSL "${base}/office-bridge.mjs" -o "$DIR/office-bridge.mjs"
cat > "$DIR/config.json" << 'CFGEOF'
${cfg}
CFGEOF
node "$DIR/office-bridge.mjs" install-hooks
node "$DIR/office-bridge.mjs" check
echo ""
echo "Done, ${person.name}! Start a NEW Claude session (claude -c) - the office context arrives automatically."
`);
});

app.get('/install/:name', (req, res) => {
  const person = listPeople().find((p) => p.name.toLowerCase() === String(req.params.name).toLowerCase());
  if (!person) return res.status(404).type('text/plain').send(`# no teammate named "${req.params.name}" — walk into the office first (or check spelling)`);
  const base = `http://${req.headers.host}`;
  const cfg = JSON.stringify({ server: base, personId: person.id, name: person.name }, null, 2);
  res.type('text/plain').send(`# HQ office-bridge installer for ${person.name} — generated by the office
$ErrorActionPreference = "Stop"
$dir = "$env:USERPROFILE\\.hqffice"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest -Uri "${base}/office-bridge.mjs" -OutFile "$dir\\office-bridge.mjs"
@'
${cfg}
'@ | Set-Content -Encoding utf8 "$dir\\config.json"
node "$dir\\office-bridge.mjs" install-hooks
node "$dir\\office-bridge.mjs" check
Write-Host ""
Write-Host "Done, ${person.name}! Start a NEW Claude session (claude -c) - the office context arrives automatically." -ForegroundColor Green
`);
});

// External-agent presence heartbeat: a teammate's own Claude (office-bridge),
// Codex, or OpenClaw pings this so the office shows them as connected.
// Auto-provision: the first heartbeat from a teammate's agent stack
// materializes a floor character for it ("juls-claude", "stephen-codex").
// No prompting, no manual step — connecting IS appearing.
const EXT_AVATAR = { claude: '💻', codex: '🟦', openclaw: '🦞' };
function externalAgentFor(person, kind) {
  const name = `${person.name}-${kind}`;
  let agent = listAgents().find((a) => a.external && a.name.toLowerCase() === name.toLowerCase());
  if (!agent) {
    agent = createAgent({
      name, role: `${kind} agent (${person.name}'s own session)`, model: 'sonnet',
      avatar: EXT_AVATAR[kind] || '🔌', ownerId: person.id, external: true,
      persona: `${person.name}'s own ${kind} session, represented on the floor. Runs on their machine — mentions here are held, never billed. Reach them through #office; their session hears it via their bridge.`,
    });
  }
  return agent;
}

app.post('/api/presence', (req, res) => {
  const { personId, agentId, kind, label } = req.body || {};
  if (agentId) {
    const agent = heartbeatAgent(agentId, label);
    if (!agent) return res.status(404).json({ error: 'no such external agent' });
    return res.json({ ok: true, status: agent.status });
  }
  const person = heartbeatConnection(personId, kind, label);
  if (person) {
    const k = String(kind || 'agent').toLowerCase().replace(/[^\w-]/g, '').slice(0, 20) || 'agent';
    heartbeatAgent(externalAgentFor(person, k).id, label);
  }
  if (!person) return res.status(404).json({ error: 'no such person — run office-bridge setup first' });
  emitTransient('person_connections', { personId: person.id, connections: person.connections });
  res.json({ ok: true, connections: person.connections });
});

// Beacon expiry: a machine that stops reporting drops its live sessions.
setInterval(() => {
  const changed = expireStaleSessions() | expireStaleConnections() | expireStaleAgentPings();
  if (changed) emitTransient('people_sync', { people: listPeople() });
}, 30000);

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`hq-agents listening on http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  office LAN: http://${ip}:${PORT}`);
  emit('server_started', { port: PORT, lan: lanAddresses() });
  pump();
});
