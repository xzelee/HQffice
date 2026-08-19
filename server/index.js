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
  listTasks, createTask, updateTask, getOrchestrator, readBlackboard,
  listPeople, getPerson, createPerson, updatePerson, setPersonPresence, setPersonPos,
  setPersonSessions, expireStaleSessions,
} from './store.js';
import { sendMessage, pendingCounts, pump } from './router.js';
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
initUsage(WORKSPACE);
initRuntime();
ensureDefaultRoster();

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
