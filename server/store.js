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
  // External characters rest at 'offline' (presence-driven), not 'idle'.
  for (const a of state.agents) if (a.status !== 'over_budget') a.status = a.external ? 'offline' : 'idle';
  // Map v2 migration: reassign every desk allocated on an older map.
  if (state.agents.some((a) => a.desk?.v !== MAP.v)) {
    for (const a of state.agents) a.desk = null;
    for (const a of state.agents) a.desk = allocateDesk({ isOrchestrator: a.isOrchestrator, ownerId: a.ownerId, parentId: a.parentId });
    saveAgents();
  }
  if (!fs.existsSync(BLACKBOARD_FILE)) {
    fs.writeFileSync(BLACKBOARD_FILE, '# Office Blackboard\n\n(Shared notes visible to every agent.)\n');
  }
}

let idCounter = Date.now() % 100000;
export function makeId(prefix) { return `${prefix}_${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// --- office map v8: the VILLAGE ------------------------------------------
// 96x64 tile grid, open-world style (à la Tribes of Malaya / Summertime
// Saga): every structure is its OWN free-standing building on a big grassy
// world, connected by paved roads. Buildings carry their walls on
// x0/x1/y0/y1 with the interior inside. North: five personal HOUSES (labs —
// owner desk + 10 agent desks). Center: the HQ HALL (front desk, brain
// core, hot desks). East: MISSION CONTROL and the CAFETERIA as separate
// buildings, and the SKILLS SHOP far east. South: five WORKSHOPS (sub-agent
// bays, 8 desks, index === person.roomIndex). The client renders from this
// same definition (served in /api/state) so layout and allocation never
// drift.
export const MAP = {
  v: 10,
  w: 80, h: 48,
  world: 'village',
  rooms: Array.from({ length: 5 }, (_, i) => {
    const x0 = 2 + i * 13;
    return {
      index: i,
      x0, y0: 2, x1: x0 + 12, y1: 12,                    // wall ring, interior 11x9
      door: { x: x0 + 5, y: 12 },                        // south door (2 tiles)
      ownerDesk: { x: x0 + 6, y: 5 },
      agentDesks: [                                      // 10 seats
        ...[2, 4, 6, 8, 10].map((dx) => ({ x: x0 + dx, y: 8 })),
        ...[2, 4, 6, 8, 10].map((dx) => ({ x: x0 + dx, y: 11 })),
      ],
    };
  }),
  // east column: skills shop / cafeteria (the meeting room now lives
  // INSIDE the HQ hall as its conference zone)
  shop: {
    x0: 68, y0: 16, x1: 78, y1: 26,
    door: { x: 68, y: 20 },
    counter: { x0: 71, y0: 21, x1: 75, y1: 21 },
    label: 'SKILLS SHOP',
  },
  cafe: { x0: 68, y0: 30, x1: 78, y1: 40, door: { x: 68, y: 34 } },
  hq: {
    x0: 16, y0: 15, x1: 51, y1: 30,
    doorS: { x: 33, y: 30 }, doorE: { x: 51, y: 18 },
    label: 'HQ HALL',
  },
  // the BRAIN VAULT — a high-tech data-center building housing the project
  // brain (racks + the core; clicking the core opens the archive terminal).
  // The door is ACCESS CONTROLLED: identification at the keypad — your name
  // + password, default 123 (checked by POST /api/vault/unlock).
  vault: {
    x0: 68, y0: 2, x1: 78, y1: 12,
    door: { x: 68, y: 7 },
    core: { x: 73, y: 8 },
    racks: [
      { x: 70, y: 4 }, { x: 72, y: 4 }, { x: 74, y: 4 }, { x: 76, y: 4 },
      { x: 70, y: 8 }, { x: 76, y: 8 },
    ],
    label: 'BRAIN VAULT',
  },
  // conference zone INSIDE the HQ hall: a long LANDSCAPE boardroom table
  // DEAD-CENTER in the hall, chairs along the top and bottom (client
  // dressing), wall TV on the hall's south wall below it; hot desks are
  // pushed to the hall's west and east flanks. 2+ humans inside = briefing
  meeting: { x0: 26, y0: 19, x1: 41, y1: 30, table: { x0: 28, y0: 22, x1: 39, y1: 24 }, label: 'CONFERENCE' },
  entrance: { x: 33, y: 31 },                            // spawn: on the road at HQ's south door
  frontDesk: { x: 33, y: 18 },
  hotDesks: [
    ...[18, 20, 22, 24, 26].map((x) => ({ x, y: 21 })),  // west flank
    ...[18, 20, 22, 24, 26].map((x) => ({ x, y: 24 })),
    ...[42, 44, 46, 48, 50].map((x) => ({ x, y: 21 })),  // east flank
    ...[42, 44, 46, 48, 50].map((x) => ({ x, y: 24 })),
  ],
  bays: Array.from({ length: 5 }, (_, i) => {
    const x0 = 2 + i * 13;
    return {
      index: i,
      x0, y0: 32, x1: x0 + 12, y1: 42,                   // wall ring, interior 11x9
      door: { x: x0 + 5, y: 32 },                        // north door (2 tiles)
      desks: [                                           // 8 seats
        ...[3, 5, 7, 9].map((dx) => ({ x: x0 + dx, y: 37 })),
        ...[3, 5, 7, 9].map((dx) => ({ x: x0 + dx, y: 41 })),
      ],
    };
  }),
};

export function listAgents() { return state.agents; }
export function getAgent(id) { return state.agents.find((a) => a.id === id); }
export function getOrchestrator() { return state.agents.find((a) => a.isOrchestrator); }

// Whose team is this agent on? Follow the parent chain up to the first
// agent with an ownerId — a sub-agent belongs to its spawner's owner.
function ownerOfLineage(agent) {
  let cur = agent, hops = 0;
  while (cur && hops++ < 8) {
    if (cur.ownerId) return cur.ownerId;
    cur = cur.parentId ? getAgent(cur.parentId) : null;
  }
  return null;
}

// Desk allocation: coordinator sits at the front desk; an agent owned by a
// person with a room gets a desk in that room; sub-agents (parentId) are
// seated in their team's PRIVATE BAY (lineage owner's bay, under that
// person's lab); everyone else takes a hot desk, with any free bay desk as
// shared overflow once the floor fills up.
function allocateDesk({ isOrchestrator, ownerId, parentId }) {
  const taken = new Set(state.agents.map((a) => `${a.desk?.x},${a.desk?.y}`));
  const free = (d) => !taken.has(`${d.x},${d.y}`);
  const allBayDesks = () => MAP.bays.flatMap((b) => b.desks);
  if (isOrchestrator) return { ...MAP.frontDesk, v: MAP.v };
  if (ownerId) {
    const owner = getPerson(ownerId);
    const room = owner?.roomIndex != null ? MAP.rooms[owner.roomIndex] : null;
    // owner's room first, their own bay as overflow — an owned agent never
    // sits out on the open floor while their team has seats
    const slot = room?.agentDesks.find(free)
      || (owner?.roomIndex != null ? MAP.bays[owner.roomIndex]?.desks.find(free) : null);
    if (slot) return { ...slot, v: MAP.v };
  }
  if (parentId) {
    const oid = ownerId || ownerOfLineage(getAgent(parentId));
    const owner = oid ? getPerson(oid) : null;
    const bay = owner?.roomIndex != null ? MAP.bays[owner.roomIndex] : null;
    const slot = bay?.desks.find(free) || allBayDesks().find(free);
    if (slot) return { ...slot, v: MAP.v };
  }
  const hot = MAP.hotDesks.find(free) || allBayDesks().find(free);
  if (hot) return { ...hot, v: MAP.v };
  return { x: 4 + Math.floor(Math.random() * 28), y: 9 + Math.floor(Math.random() * 12), v: MAP.v };
}

export function createAgent({ name, role, persona, model = 'sonnet', color, avatar, isOrchestrator = false, parentId = null, ownerId = null, tools = [], external = false }) {
  const desk = allocateDesk({ isOrchestrator, ownerId, parentId });
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
    external: !!external,   // a real outside session (Claude dev session, Codex, ...) represented on the floor — never scheduled by the runtime
    lastPingTs: 0,
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
    agent.desk = allocateDesk({ isOrchestrator: agent.isOrchestrator, ownerId: agent.ownerId, parentId: agent.parentId });
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

// Skills Shop purchase: equip the skill on the agent. The runtime injects
// equipped skills into the system prompt, so the buyer restarts the session.
export function grantSkill(id, skillId) {
  const agent = getAgent(id);
  if (!agent) return null;
  agent.skills = agent.skills || [];
  if (!agent.skills.includes(skillId)) agent.skills.push(skillId);
  saveAgents();
  emit('skill_purchased', { agentId: id, name: agent.name, skillId });
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

// External-agent presence: a teammate's OWN agent stack (Claude via the
// office-bridge, Codex, OpenClaw) heartbeats here so the office can show
// "juls' Claude — connected". One entry per kind; expiry mirrors sessions.
export function heartbeatConnection(id, kind, label = '') {
  const person = getPerson(id);
  if (!person) return null;
  const k = String(kind || 'agent').toLowerCase().replace(/[^\w-]/g, '').slice(0, 20) || 'agent';
  person.connections = (person.connections || []).filter((c) => c.kind !== k);
  person.connections.push({ kind: k, label: String(label || '').slice(0, 60), ts: Date.now() });
  person.lastSeen = Date.now();
  return person;
}

// External AGENT presence: an outside session heartbeats its floor character.
export function heartbeatAgent(id, label = '') {
  const agent = getAgent(id);
  if (!agent || !agent.external) return null;
  agent.lastPingTs = Date.now();
  if (agent.status !== 'online') { agent.status = 'online'; emit('agent_status', { agentId: id, status: 'online', detail: label }); }
  return agent;
}

// Three presence tiers, so "installed but idle" never reads as "not set up":
//   online    — pinged within 90s (a session is actively working right now)
//   connected — pinged within 24h (bridge is installed and working)
//   offline   — never pinged, or silent for over a day
const ONLINE_MS = 90 * 1000;
const CONNECTED_MS = 24 * 60 * 60 * 1000;

export function expireStaleAgentPings(maxAgeMs = ONLINE_MS) {
  let changed = false;
  for (const a of state.agents) {
    if (!a.external) continue;
    const age = Date.now() - (a.lastPingTs || 0);
    const want = !a.lastPingTs ? 'offline' : age <= maxAgeMs ? 'online' : age <= CONNECTED_MS ? 'connected' : 'offline';
    if (a.status !== want) {
      a.status = want;
      emit('agent_status', { agentId: a.id, status: want, detail: '' });
      changed = true;
    }
  }
  if (changed) saveAgents();
  return changed;
}

export function expireStaleConnections(maxAgeMs = 90000) {
  let changed = false;
  for (const p of state.people) {
    if (!p.connections?.length) continue;
    const live = p.connections.filter((c) => Date.now() - c.ts <= maxAgeMs);
    if (live.length !== p.connections.length) { p.connections = live; changed = true; }
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
