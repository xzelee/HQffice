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
  setAgentSession, listTasks, createTask, updateTask, getOrchestrator, readBlackboard,
  listPeople, getPerson, createPerson, updatePerson, setPersonPresence, setPersonPos,
  setPersonSessions, expireStaleSessions,
} from './store.js';
import { sendMessage, pendingCounts, pump, setPaused, isPaused } from './router.js';
import { initChat, postChat, recentChat, chatDerived, rotateChat } from './chatroom.js';
import { initBrain, getBrain, setBrain, listBrain, readBrain, searchBrain } from './brain.js';
import { initMemStore, listMemoryStore } from './memstore.js';
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
initMemStore(WORKSPACE);
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
    brain: getBrain(),
    memoryStore: listMemoryStore(),
    models: MODEL_CHOICES,
    presets: ROLE_PRESETS,
    events: recentEvents(150),
  });
});

// --- people (real teammates) -------------------------------------------
app.post('/api/people', (req, res) => {
  const { name, appearance } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
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
  const { name, role, persona, model, color, avatar, tools, ownerId, budgetTokens, effort } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
  const agent = createAgent({ name, role, persona: persona || '', model: model || 'sonnet', color, avatar, tools, ownerId: ownerId || null });
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

// Beacon expiry: a machine that stops reporting drops its live sessions.
setInterval(() => {
  if (expireStaleSessions()) emitTransient('people_sync', { people: listPeople() });
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
