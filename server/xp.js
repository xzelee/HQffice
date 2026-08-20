// XP + levels — the office's progression layer, for agents AND humans.
// Event-driven: this module subscribes to the office event stream and awards
// points for real contributions (memory-store writes weigh most — knowledge
// that compounds beats chatter). The exact award table and level curve are
// v1 placeholders to be tuned; the LEDGER shape (per-entity xp + reasons) is
// the stable part. Persisted to workspace/xp.json.
import fs from 'node:fs';
import path from 'node:path';
import { subscribe, emit } from './eventlog.js';

// v1 award table — TUNE LATER (Stan wants a balancing pass).
const AWARDS = {
  memory_write: 25,     // wrote durable team knowledge (the big one)
  chat_done: 15,        // closed a promise / delivered with DONE:
  task_done: 30,        // moved a task to done
  chat_post: 5,         // said something in #office
  turn: 3,              // an agent worked a turn
  spawn: 10,            // hired a sub-agent
  skill: 20,            // equipped a new skill from the shop
};

// v1 curve: level n needs 100*(n-1)^2 total xp → L2@100, L3@400, L4@900…
export const levelOf = (xp) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 100));
export const xpForLevel = (lvl) => 100 * (lvl - 1) * (lvl - 1);

let xpFile = null;
let ledger = {};          // id -> { xp, awards: {reason: count}, lastActiveTs }
let saveTimer = null;

function entry(id) {
  if (!id) return null;
  if (!ledger[id]) ledger[id] = { xp: 0, awards: {}, lastActiveTs: 0 };
  return ledger[id];
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(xpFile, JSON.stringify(ledger, null, 2)); } catch { /* next save */ }
  }, 2000);
}

export function awardXp(id, reason, amount = AWARDS[reason] || 0) {
  const e = entry(id);
  if (!e || !amount) return;
  const before = levelOf(e.xp);
  e.xp += amount;
  e.awards[reason] = (e.awards[reason] || 0) + 1;
  scheduleSave();
  const after = levelOf(e.xp);
  if (after > before) emit('level_up', { entityId: id, level: after, xp: e.xp });
}

function touch(id) {
  const e = entry(id);
  if (e) { e.lastActiveTs = Date.now(); scheduleSave(); }
}

export function initXp(workspaceDir) {
  xpFile = path.join(workspaceDir, 'xp.json');
  try { ledger = JSON.parse(fs.readFileSync(xpFile, 'utf8')); } catch { ledger = {}; }

  subscribe((ev) => {
    try {
      switch (ev.type) {
        case 'memory_store_written':
          awardXp(ev.by, 'memory_write'); touch(ev.by); break;
        case 'chat_message': {
          const m = ev.message;
          if (!m) break;
          touch(m.from);
          awardXp(m.from, /^DONE:/m.test(m.body) ? 'chat_done' : 'chat_post');
          break;
        }
        case 'task_updated':
          if (ev.task?.status === 'done' && ev.task.assignedTo) awardXp(ev.task.assignedTo, 'task_done');
          break;
        case 'turn_finished':
          awardXp(ev.agentId, 'turn'); touch(ev.agentId); break;
        case 'subagent_spawned':
          awardXp(ev.by, 'spawn'); break;
        case 'skill_bought': case 'skill_purchased':
          awardXp(ev.agentId, 'skill'); break;
        case 'person_said':
          touch(ev.personId); break;
        case 'person_moved':
          touch(ev.personId); break;
        case 'person_online':
          touch(ev.personId); break;
      }
    } catch { /* awards must never break the office */ }
  });
}

// id -> {xp, level, into, need, awards, lastActiveTs} for the dashboard.
export function xpSummary() {
  const out = {};
  for (const [id, e] of Object.entries(ledger)) {
    const level = levelOf(e.xp);
    out[id] = {
      xp: e.xp,
      level,
      into: e.xp - xpForLevel(level),
      need: xpForLevel(level + 1) - xpForLevel(level),
      awards: e.awards,
      lastActiveTs: e.lastActiveTs,
    };
  }
  return out;
}
