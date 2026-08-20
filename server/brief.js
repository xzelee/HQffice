// Session brief — port of the lab's channel_brief (their #2-ranked
// mechanism: "killed the read-STATE.md-at-session-start hope"). A brief is
// COMPUTED at delivery time from the ledger + verifier — never hand-written
// (D9), never from memory. Per recipient it answers: what is waiting on ME,
// what did I promise, what am I blocking on, which of my claims got
// contradicted, and which standing decisions govern my work.
import { chatDerived, recentChat } from './chatroom.js';
import { claimVerdicts } from './verify.js';

// ids: an entity plus any aliases (a person's external agent characters).
export function briefFor(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const meta = chatDerived();
  const byId = new Map(recentChat(200).map((m) => [m.id, m]));
  const verdicts = claimVerdicts();
  return {
    asks: (meta.openAsks || []).filter((a) => a.waitingOn.some((w) => set.has(w))),
    promises: (meta.promises || []).filter((p) => set.has(p.from)),
    blockers: (meta.blockers || []).filter((b) => set.has(b.from)),
    contradicted: Object.entries(verdicts)
      .filter(([mid, v]) => v.verdict === 'contradicted' && set.has(byId.get(mid)?.from))
      .map(([mid, v]) => ({ id: mid, claim: v.claim, detail: v.detail })),
    standing: meta.standing || [],
  };
}

// Text block for a turn prompt / bridge context. Empty string kung walang
// standing state — a brief must never be noise.
export function renderBrief(b) {
  const out = [];
  if (b.asks.length) out.push(`OPEN ASKS WAITING ON YOU (${b.asks.length}) — answer each with a threaded reply:\n` +
    b.asks.map((a) => `- [${a.id}] ${a.by}: ${a.body.slice(0, 120)}`).join('\n'));
  if (b.promises.length) out.push(`YOUR OPEN PROMISES — close each with a threaded "DONE: <result>":\n` +
    b.promises.map((p) => `- [${p.id}] (${p.state}) WILL: ${p.text}`).join('\n'));
  if (b.blockers.length) out.push(`YOUR OPEN BLOCKERS — clear with a threaded "DONE:" once unblocked:\n` +
    b.blockers.map((x) => `- [${x.id}] BLOCKED: ${x.what} ON: ${x.target}`).join('\n'));
  if (b.contradicted.length) out.push(`YOUR CONTRADICTED CLAIMS — the verifier disproved these; fix or retract with a threaded correction:\n` +
    b.contradicted.map((c) => `- [${c.id}] "${c.claim}" — ${c.detail}`).join('\n'));
  if (b.standing.length) out.push(`STANDING DECISIONS (scoped authority, D11):\n` +
    b.standing.map((s) => `- [${s.id}] ${s.by}: ${s.verdict} | scope: ${s.scope}${s.expires ? ` | expires: ${s.expires}` : ''}`).join('\n'));
  return out.join('\n');
}
