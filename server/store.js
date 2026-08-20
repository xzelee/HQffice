// Agent registry + tasks + blackboard, persisted to the workspace directory.
// An agent is a config object (model, persona, tools scope), never a
// hardcoded process — creating a character = writing a config; changing its
// model = editing one field.
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';

export const WORKSPACE = path.join(process.cwd(), 'workspace');
const AGENTS_FILE = path.join(WORKSPACE, 'agents.json');
const TASKS_FILE = path.join(WORKSPACE, 'tasks.json');
const BLACKBOARD_FILE = path.join(WORKSPACE, 'blackboard.md');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

const PEOPLE_FILE = path.join(WORKSPACE, 'people.json');

const state = {
  agents: [],   // [{id,name,role,persona,model,color,desk,parentId,ownerId,isOrchestrator,budgetTokens,effort,maxTurns,sessionId,status,createdAt}]
  tasks: [],    // [{id,title,description,status,assignedTo,createdAt,updatedAt}]
  people: [],   // [{id,name,appearance,roomIndex,pos,online,lastSeen,sessions}]
};

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveAgents() { fs.writeFileSync(AGENTS_FILE, JSON.stringify(state.agents, null, 2)); }
function saveTasks() { fs.writeFileSync(TASKS_FILE, JSON.stringify(state.tasks, null, 2)); }

export function initStore() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  state.agents = load(AGENTS_FILE, []);
  state.tasks = load(TASKS_FILE, []);
  state.people = load(PEOPLE_FILE, []);
  for (const p of state.people) { p.online = false; p.sessions = p.sessions || []; }
  // Sessions don't survive a server restart cleanly; reset transient status.
  for (const a of state.agents) if (a.status !== 'over_budget') a.status = 'idle';
  // Map v2 migration: reassign every desk allocated on an older map.
  if (state.agents.some((a) => a.desk?.v !== MAP.v)) {
    for (const a of state.agents) a.desk = null;
    for (const a of state.agents) a.desk = allocateDesk({ isOrchestrator: a.isOrchestrator, ownerId: a.ownerId });
    saveAgents();
  }
  if (!fs.existsSync(BLACKBOARD_FILE)) {
    fs.writeFileSync(BLACKBOARD_FILE, '# Office Blackboard\n\n(Shared notes visible to every agent.)\n');
  }
}

let idCounter = Date.now() % 100000;
export function makeId(prefix) { return `${prefix}_${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// --- office map v2 ------------------------------------------------------
// 46x28 tile grid. Five personal rooms along the top (one per teammate),
// a meeting room and cafeteria on the right, hot desks on the open floor,
// coordinator at the central front desk. The client renders from this same
// definition (served in /api/state) so layout and allocation never drift.
export const MAP = {
  v: 2,
  w: 46, h: 28,
  rooms: Array.from({ length: 5 }, (_, i) => ({
    index: i,
    x0: 1 + i * 8, y0: 1, x1: 1 + i * 8 + 6, y1: 6,      // interior
    door: { x: 1 + i * 8 + 3, y: 7 },
    ownerDesk: { x: 1 + i * 8 + 2, y: 3 },
    agentDesks: [
      { x: 1 + i * 8 + 5, y: 3 },
      { x: 1 + i * 8 + 5, y: 5 },
      { x: 1 + i * 8 + 2, y: 5 },
    ],
  })),
  meeting: { x0: 36, y0: 10, x1: 44, y1: 17, door: { x: 36, y: 13 }, table: { x0: 38, y0: 12, x1: 42, y1: 14 }, label: 'MEETING ROOM' },
  cafe: { x0: 36, y0: 20, x1: 44, y1: 26 },
  entrance: { x: 22, y: 26 },
  frontDesk: { x: 21, y: 10 },
  hotDesks: [
    ...[4, 8, 12, 16, 20, 24, 28, 32].map((x) => ({ x, y: 13 })),
    ...[4, 8, 12, 16, 20, 24, 28, 32].map((x) => ({ x, y: 18 })),
  ],
};

export function listAgents() { return state.agents; }
export function getAgent(id) { return state.agents.find((a) => a.id === id); }
export function getOrchestrator() { return state.agents.find((a) => a.isOrchestrator); }

// Desk allocation: coordinator sits at the front desk; an agent owned by a
// person with a room gets a desk in that room; everyone else takes a hot desk.
function allocateDesk({ isOrchestrator, ownerId }) {
  const taken = new Set(state.agents.map((a) => `${a.desk?.x},${a.desk?.y}`));
  const free = (d) => !taken.has(`${d.x},${d.y}`);
  if (isOrchestrator) return { ...MAP.frontDesk, v: 2 };
  if (ownerId) {
    const owner = getPerson(ownerId);
    const room = owner?.roomIndex != null ? MAP.rooms[owner.roomIndex] : null;
    const slot = room?.agentDesks.find(free);
    if (slot) return { ...slot, v: 2 };
  }
  const hot = MAP.hotDesks.find(free);
  if (hot) return { ...hot, v: 2 };
  return { x: 4 + Math.floor(Math.random() * 28), y: 9 + Math.floor(Math.random() * 12), v: 2 };
}

export function createAgent({ name, role, persona, model = 'sonnet', color, avatar, isOrchestrator = false, parentId = null, ownerId = null, tools = [] }) {
  const desk = allocateDesk({ isOrchestrator, ownerId });
  const agent = {
    id: makeId('agent'),
    name, role, persona,
    model,
    color: color || pickColor(state.agents.length),
    avatar: avatar || '',
    desk,
    parentId,
    ownerId,
    isOrchestrator,
    tools: Array.isArray(tools) ? tools.filter((t) => ['web', 'files'].includes(t)) : [],
    budgetTokens: null,   // lifetime token cap (in+out+cache); null = unlimited
    effort: null,         // per-agent effort override: low|medium|high
    maxTurns: null,       // per-step internal turn cap override
    sessionId: null,
    status: 'idle',
    createdAt: Date.now(),
  };
  state.agents.push(agent);
  saveAgents();
  emit('agent_created', { agent });
  return agent;
}

export function updateAgent(id, patch) {
  const agent = getAgent(id);
  if (!agent) return null;
  const allowed = ['name', 'role', 'persona', 'model', 'color', 'avatar', 'ownerId', 'budgetTokens', 'effort', 'maxTurns'];
  const prevOwner = agent.ownerId;
  for (const k of allowed) if (patch[k] !== undefined) agent[k] = patch[k];
  // New owner → move desk into (or out of) their room.
  if (patch.ownerId !== undefined && patch.ownerId !== prevOwner) {
    agent.desk = null;
    agent.desk = allocateDesk({ isOrchestrator: agent.isOrchestrator, ownerId: agent.ownerId });
  }
  if (patch.tools !== undefined) {
    agent.tools = Array.isArray(patch.tools) ? patch.tools.filter((t) => ['web', 'files'].includes(t)) : [];
  }
  // Budget raised or cleared: let held mail flow again.
  if (patch.budgetTokens !== undefined && agent.status === 'over_budget') agent.status = 'idle';
  // Model, persona, or tool-grant change means the old session's system
  // prompt is stale: start a fresh session on the next turn.
  if (patch.model !== undefined || patch.persona !== undefined || patch.tools !== undefined) agent.sessionId = null;
  saveAgents();
  emit('agent_updated', { agent });
  return agent;
}

export function setAgentSession(id, sessionId) {
  const agent = getAgent(id);
  if (agent) { agent.sessionId = sessionId; saveAgents(); }
}

// Chatroom delivery cursor: ts of the newest #office message this agent has
// had injected into a turn. Guarantees no message is silently missed.
export function setAgentChatCursor(id, ts) {
  const agent = getAgent(id);
  if (agent && agent.chatCursorTs !== ts) { agent.chatCursorTs = ts; saveAgents(); }
}

export function setAgentStatus(id, status, detail = '') {
  const agent = getAgent(id);
  if (agent && agent.status !== status) {
    agent.status = status;
    emit('agent_status', { agentId: id, status, detail });
  }
}

export function removeAgent(id) {
  const i = state.agents.findIndex((a) => a.id === id);
  if (i === -1) return false;
  const [agent] = state.agents.splice(i, 1);
  saveAgents();
  emit('agent_removed', { agentId: id, name: agent.name });
  return true;
}

// munder-difflin accent palette: coral, sky, mint, lemon, lilac, peach
const PALETTE = ['#D96A62', '#4F9FAF', '#5CA97A', '#DCAB3C', '#9482D3', '#D99168'];
function pickColor(n) { return PALETTE[n % PALETTE.length]; }

// --- tasks --------------------------------------------------------------
export function listTasks() { return state.tasks; }
export function getTask(id) { return state.tasks.find((t) => t.id === id); }

export function createTask({ title, description = '', status = 'inbox', assignedTo = null, key = null, source = null }) {
  const task = { id: makeId('task'), key, source, title, description, status, assignedTo, createdAt: Date.now(), updatedAt: Date.now() };
  state.tasks.push(task);
  saveTasks();
  emit('task_created', { task });
  return task;
}

export function updateTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;
  for (const k of ['status', 'assignedTo', 'title', 'description']) if (patch[k] !== undefined) task[k] = patch[k];
  task.updatedAt = Date.now();
  saveTasks();
  emit('task_updated', { task });
  return task;
}

// --- blackboard ---------------------------------------------------------
export function readBlackboard() {
  try { return fs.readFileSync(BLACKBOARD_FILE, 'utf8'); } catch { return ''; }
}
export function writeBlackboard(content, by) {
  fs.writeFileSync(BLACKBOARD_FILE, content);
  emit('blackboard_updated', { by, size: content.length });
}
export function appendBlackboard(text, by) {
  fs.appendFileSync(BLACKBOARD_FILE, `\n${text}\n`);
  emit('blackboard_updated', { by, appended: text.slice(0, 200) });
}

// --- people (real teammates with characters) ----------------------------
function savePeople() { fs.writeFileSync(PEOPLE_FILE, JSON.stringify(state.people, null, 2)); }
export function listPeople() { return state.people; }
export function getPerson(id) { return state.people.find((p) => p.id === id); }

const DEFAULT_APPEARANCE = { skin: '#E8C39E', hairStyle: 'short', hairColor: '#4a3527', shirt: '#4F9FAF', hat: 'none', badge: '' };

export function createPerson({ name, appearance = {} }) {
  const takenRooms = new Set(state.people.map((p) => p.roomIndex).filter((r) => r != null));
  const roomIndex = MAP.rooms.map((r) => r.index).find((i) => !takenRooms.has(i)) ?? null;
  const room = roomIndex != null ? MAP.rooms[roomIndex] : null;
  const person = {
    id: makeId('person'),
    name,
    appearance: { ...DEFAULT_APPEARANCE, ...appearance },
    roomIndex,
    pos: room ? { x: room.ownerDesk.x, y: room.ownerDesk.y + 1 } : { ...MAP.entrance },
    online: false,
    lastSeen: Date.now(),
    sessions: [],
    createdAt: Date.now(),
  };
  state.people.push(person);
  savePeople();
  emit('person_joined', { person });
  return person;
}

export function updatePerson(id, patch) {
  const person = getPerson(id);
  if (!person) return null;
  if (patch.name !== undefined) person.name = patch.name;
  if (patch.appearance) person.appearance = { ...person.appearance, ...patch.appearance };
  savePeople();
  emit('person_updated', { person });
  return person;
}

export function setPersonPresence(id, online) {
  const person = getPerson(id);
  if (!person || person.online === online) return;
  person.online = online;
  person.lastSeen = Date.now();
  savePeople();
  emit(online ? 'person_online' : 'person_offline', { personId: id, name: person.name });
}

export function setPersonPos(id, pos) {
  const person = getPerson(id);
  if (person) { person.pos = pos; person.lastSeen = Date.now(); }
}

// Live Claude Code sessions reported by that person's beacon.
export function setPersonSessions(id, sessions) {
  const person = getPerson(id);
  if (!person) return null;
  person.sessions = (sessions || []).slice(0, 12).map((s) => ({
    project: String(s.project || 'unknown').slice(0, 60),
    ageSec: Math.max(0, s.ageSec | 0),
    ts: Date.now(),
  }));
  person.lastSeen = Date.now();
  return person;
}

export function expireStaleSessions(maxAgeMs = 60000) {
  let changed = false;
  for (const p of state.people) {
    if (p.sessions?.length && Date.now() - (p.sessions[0]?.ts || 0) > maxAgeMs) {
      p.sessions = [];
      changed = true;
    }
  }
  return changed;
}

// --- per-agent memory ---------------------------------------------------
export function memoryPath(agentId) { return path.join(MEMORY_DIR, `${agentId}.md`); }
export function readMemory(agentId) {
  try { return fs.readFileSync(memoryPath(agentId), 'utf8'); } catch { return ''; }
}
export function appendMemory(agentId, note) {
  fs.appendFileSync(memoryPath(agentId), `- ${new Date().toISOString().slice(0, 16)} ${note}\n`);
}
