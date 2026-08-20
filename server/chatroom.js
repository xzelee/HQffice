// Shared office chatroom (#office): one centralized room where every agent
// and every human teammate posts, so cross-team context lives in one place.
//
// Design notes ported from Stan's Chatroom Lab (docs/agent-sync in the RAG
// repo), per its chatroom agent's advice:
// - Message ids are CONTENT HASHES, never positions — rotation/archiving can
//   never orphan a thread link (their first rotation with positional ids
//   silently broke all threading; we start hashed from day one).
// - Delivery is a PER-AGENT CURSOR, not "agents will read the log" (false):
//   every turn injects exactly the messages that agent has not seen, bounded,
//   with older ones counted rather than pasted.
// - A threaded reply (replyTo) is PROOF OF ANSWER: it closes an open ask.
//   "WILL:" lines open promises closed only by the author's threaded "DONE:".
//   "DECISION-NEEDED:" lines queue for a human, closed by a human's threaded
//   "DECISION:" reply.
// - Token economics: a plain post wakes NOBODY. An @mention delivers mail
//   through the router (hop counts, budgets, scheduler) and wakes only the
//   mentioned agent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';
import { listAgents } from './store.js';
import { sendMessage } from './router.js';

const KEEP = 500;                 // in-memory window; the jsonl keeps everything
let chatFile = null;
let messages = [];

export function initChat(workspaceDir) {
  chatFile = path.join(workspaceDir, 'chat.jsonl');
  try {
    messages = fs.readFileSync(chatFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-KEEP);
  } catch { messages = []; }
}

// Content-derived id: stable forever, independent of position in the log.
function hashId(ts, from, body) {
  return crypto.createHash('sha1').update(`${ts}|${from}|${String(body).slice(0, 200)}`).digest('hex').slice(0, 8);
}

// Injection quarantine (the lab's hard rule, learned from a live phantom-task
// incident): markers and mentions inside fenced code blocks or blockquotes
// are documentation, not intent — strip them before any marker matching, or
// quoted examples mint phantom edges, promises, and wakes.
export function authoritative(body) {
  return String(body)
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

// "@Name" or "@agent_id" → agent ids. Names match case-insensitively; a
// poster never wakes themselves by writing their own name.
export function parseMentions(body, exceptId = null) {
  const found = new Set();
  for (const [, token] of authoritative(body).matchAll(/@([\w-]+)/g)) {
    const t = token.toLowerCase();
    const agent = listAgents().find((a) => a.id.toLowerCase() === t || a.name.toLowerCase() === t);
    if (agent && agent.id !== exceptId) found.add(agent.id);
  }
  return [...found];
}

// from: agent id, person id, or 'user'. fromKind: 'agent' | 'person' | 'user'.
export function postChat({ from, fromKind, name, body, hops = 0, replyTo = null }) {
  const mentions = parseMentions(body, fromKind === 'agent' ? from : null);
  const ts = Date.now();
  const msg = {
    id: hashId(ts, from, body),
    from, fromKind, name,
    body: String(body).slice(0, 2000),
    mentions,
    replyTo: replyTo ? String(replyTo).trim().toLowerCase().replace(/^\[|\]$/g, '') : null,
    ts,
  };
  messages.push(msg);
  if (messages.length > KEEP) messages.splice(0, messages.length - KEEP);
  if (chatFile) fs.appendFileSync(chatFile, JSON.stringify(msg) + '\n');
  emit('chat_message', { message: msg });

  const woke = [], failed = [];
  for (const to of mentions) {
    const out = sendMessage({ from, to, act: 'chat', body: `[#office ${msg.id}] ${name}: ${msg.body}`, hops });
    (out.ok ? woke : failed).push(to);
  }
  return { msg, woke, failed };
}

export function recentChat(n = 50) { return messages.slice(-n); }

// Guaranteed delivery: everything after this agent's cursor, bounded. Older
// overflow is counted, never silently dropped.
export function unreadChatFor(cursorTs, cap = 25) {
  const unread = messages.filter((m) => m.ts > (cursorTs || 0));
  return {
    msgs: unread.slice(-cap),
    older: Math.max(0, unread.length - cap),
    lastTs: messages.length ? messages[messages.length - 1].ts : (cursorTs || 0),
  };
}

// Coordination views over the live window — recomputed on demand.
// - openAsks: an @mention is an ask until the mentioned agent replies IN
//   THREAD (a reply is proof-of-answer; posting next is not).
// - promises: "WILL:" opens; only the author's threaded "DONE:" closes.
//   The middle state matters: replied-but-no-DONE is not proof.
// - decisions: "DECISION-NEEDED:" queues for a human; only a human's
//   threaded "DECISION:" closes it.
export function chatDerived() {
  const replies = new Map();
  for (const m of messages) {
    if (!m.replyTo) continue;
    if (!replies.has(m.replyTo)) replies.set(m.replyTo, []);
    replies.get(m.replyTo).push(m);
  }

  const openAsks = [];
  for (const m of messages) {
    if (!m.mentions?.length) continue;
    const rs = replies.get(m.id) || [];
    const waitingOn = m.mentions.filter((a) => !rs.some((r) => r.from === a));
    if (waitingOn.length) openAsks.push({ id: m.id, from: m.from, by: m.name, body: m.body.slice(0, 140), waitingOn, ts: m.ts });
  }

  const promises = [];
  for (const m of messages) {
    const will = authoritative(m.body).match(/^WILL:\s*(.+)$/m);
    if (!will) continue;
    const own = (replies.get(m.id) || []).filter((r) => r.from === m.from);
    const state = own.some((r) => /^DONE:/m.test(authoritative(r.body))) ? 'done' : own.length ? 'replied' : 'open';
    if (state !== 'done') promises.push({ id: m.id, from: m.from, by: m.name, text: will[1].slice(0, 140), state, ts: m.ts });
  }

  const decisions = [];
  for (const m of messages) {
    const need = authoritative(m.body).match(/^DECISION-NEEDED:\s*(.+)$/m);
    if (!need) continue;
    const decided = (replies.get(m.id) || []).some((r) => r.fromKind !== 'agent' && /^DECISION:/m.test(authoritative(r.body)));
    if (!decided) decisions.push({ id: m.id, from: m.from, by: m.name, text: need[1].slice(0, 200), ts: m.ts });
  }

  // Typed dependency: "BLOCKED: <what> ON: <target>" (the lab's graph
  // convention — only the typed form draws an edge; prose blockers don't).
  // Cleared by the author's own threaded DONE: reply. A line containing "<"
  // is documentation of the convention itself, never a real blocker.
  const blockers = [];
  for (const m of messages) {
    const b = authoritative(m.body).match(/^BLOCKED:\s*(.+?)\s+ON:\s*(.+?)\s*$/m);
    if (!b || b[1].includes('<') || b[2].includes('<')) continue;
    const cleared = (replies.get(m.id) || []).some((r) => r.from === m.from && /^DONE:/m.test(authoritative(r.body)));
    if (cleared) continue;
    const target = b[2].trim();
    const agent = listAgents().find((a) => a.id.toLowerCase() === target.toLowerCase() || a.name.toLowerCase() === target.toLowerCase());
    blockers.push({ id: m.id, from: m.from, by: m.name, what: b[1].slice(0, 120), target: agent ? agent.id : target.slice(0, 40), targetKind: agent ? 'agent' : 'external', ts: m.ts });
  }

  return { openAsks: openAsks.slice(-20), promises: promises.slice(-20), decisions: decisions.slice(-10), blockers: blockers.slice(-20) };
}

// Archive rotation: move everything but the newest `keep` messages into a
// dated archive file. Cursors are timestamps and ids are content hashes, so
// rotation breaks neither delivery nor threading (the lab's hard-won rule).
export function rotateChat(keep = 100) {
  if (messages.length <= keep) return { archived: 0, kept: messages.length };
  const cut = messages.length - keep;
  const old = messages.slice(0, cut);
  const archiveFile = chatFile.replace(/\.jsonl$/, `-archive-${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(archiveFile, old.map((m) => JSON.stringify(m)).join('\n') + '\n');
  messages = messages.slice(cut);
  fs.writeFileSync(chatFile, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  emit('chat_rotated', { archived: old.length, kept: messages.length, archiveFile: path.basename(archiveFile) });
  return { archived: old.length, kept: messages.length };
}
