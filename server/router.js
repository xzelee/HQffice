// Mailbox router + turn scheduler — the "loop engineering" core.
//
// Pattern (after munder-difflin): outbox -> router -> inbox. Each agent is a
// node; a delivered message schedules a turn on the recipient. One turn per
// agent at a time, a global concurrency cap across agents, and a hop budget
// per message chain so conversations converge instead of ping-ponging
// forever.
import { emit } from './eventlog.js';
import { getAgent, listAgents, makeId, setAgentStatus } from './store.js';
import { agentTokens } from './usage.js';

export const MAX_HOPS = 16;          // hard ceiling per message chain
const MAX_CONCURRENT_TURNS = 3;      // live Claude sessions running at once
const MAX_INBOX_BATCH = 8;           // messages folded into one turn

const inboxes = new Map();           // agentId -> [message]
const dirty = new Set();             // agents with undelivered mail
const running = new Set();           // agents with an active turn
const userInbox = [];                // messages addressed to the human

let runTurn = null;                  // injected from runtime.js
export function setTurnRunner(fn) { runTurn = fn; }

function inboxOf(id) {
  if (!inboxes.has(id)) inboxes.set(id, []);
  return inboxes.get(id);
}

// act: request | inform | question | ack | escalate
export function sendMessage({ from, to, act = 'inform', body, taskId = null, hops = 0 }) {
  const msg = {
    id: makeId('msg'),
    from, to, act, body,
    taskId,
    hops,
    ts: Date.now(),
  };

  if (hops > MAX_HOPS) {
    emit('message_dropped', { message: msg, reason: `hop budget exceeded (${MAX_HOPS})` });
    return { ok: false, error: `Message chain exceeded ${MAX_HOPS} hops and was stopped. Wrap up: send a final "inform" to the user or orchestrator instead of continuing the thread.` };
  }

  emit('message_sent', { message: msg });

  if (to === 'user') {
    userInbox.push(msg);
    emit('user_message', { message: msg });
    return { ok: true, id: msg.id };
  }

  const recipient = getAgent(to);
  if (!recipient) {
    const roster = listAgents().map((a) => `${a.id} (${a.name})`).join(', ');
    return { ok: false, error: `No agent with id "${to}". Current roster: ${roster || 'empty'}` };
  }

  inboxOf(to).push(msg);
  emit('message_delivered', { message: msg, toName: recipient.name });
  // Token saver: a plain "ack" is delivered but does not wake the recipient —
  // they'll see it batched with their next real message. Everything else
  // schedules a turn. External agents (real outside sessions represented on
  // the floor) are NEVER scheduled — their mail is held; they read the room
  // through their own session's bridge/channel instead.
  if (act !== 'ack' && !recipient.external) {
    dirty.add(to);
    queueMicrotask(pump);
  }
  return { ok: true, id: msg.id };
}

export function userMessages(sinceTs = 0) {
  return userInbox.filter((m) => m.ts > sinceTs);
}

// Global pause switch: mail keeps accumulating in inboxes, but no new turns
// start until resumed (a cost brake for the dashboard's Controls page).
let paused = false;
export function setPaused(v) {
  if (paused === !!v) return paused;
  paused = !!v;
  emit(paused ? 'scheduler_paused' : 'scheduler_resumed', {});
  if (!paused) queueMicrotask(pump);
  return paused;
}
export function isPaused() { return paused; }

// The scheduler: run turns for agents with mail, respecting caps.
const budgetWarned = new Set();

export async function pump() {
  if (!runTurn || paused) return;
  for (const agentId of [...dirty]) {
    if (running.size >= MAX_CONCURRENT_TURNS) break;
    if (running.has(agentId)) continue;
    const agent = getAgent(agentId);
    if (!agent) { dirty.delete(agentId); inboxes.delete(agentId); continue; }

    // Token budget gate: an over-budget agent's mail is held (not dropped)
    // until someone raises or clears their budget in the dashboard.
    if (agent.budgetTokens && agentTokens(agentId) >= agent.budgetTokens) {
      if (!budgetWarned.has(agentId)) {
        budgetWarned.add(agentId);
        setAgentStatus(agentId, 'over_budget', `token budget exhausted (${agent.budgetTokens})`);
        emit('budget_exhausted', { agentId, name: agent.name, budgetTokens: agent.budgetTokens, used: agentTokens(agentId) });
      }
      continue;
    }
    budgetWarned.delete(agentId);

    const inbox = inboxOf(agentId);
    if (inbox.length === 0) { dirty.delete(agentId); continue; }

    const batch = inbox.splice(0, MAX_INBOX_BATCH);
    if (inbox.length === 0) dirty.delete(agentId);

    running.add(agentId);
    setAgentStatus(agentId, 'thinking');
    emit('turn_started', { agentId, messages: batch.map((m) => m.id) });

    runTurn(agent, batch)
      .catch((err) => {
        emit('error', { agentId, error: String(err?.message || err) });
      })
      .finally(() => {
        running.delete(agentId);
        setAgentStatus(agentId, 'idle');
        emit('turn_finished', { agentId });
        queueMicrotask(pump);
      });
  }
}

export function pendingCounts() {
  const out = {};
  for (const [id, box] of inboxes) if (box.length) out[id] = box.length;
  return out;
}

export function isBusy(agentId) { return running.has(agentId); }
