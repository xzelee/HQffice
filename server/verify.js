// CLAIM verification for the multi-user office — port of the lab's
// channel_verify, adapted for a team of many humans and many machines.
//
// Multi-user rule: claims are verified ON THE HOST against SHARED sources of
// truth only — the project repo clone (pushed work), the vault, the memory
// store, the synced ticket board, and live HTTP endpoints. Work that exists
// only on someone's private machine is UNVERIFIABLE by design: push it or it
// does not count.
//
// The lab's four principles, kept verbatim in spirit:
//   1. ZERO FALSE CONTRADICTIONS — ambiguity degrades to "unverifiable",
//      never to "contradicted".
//   2. VERDICTS FREEZE at first check (claims are true at posting time),
//      cached forever against the message's content-hash id.
//   3. NEVER in the request path — a background interval writes
//      workspace/verify.json; the API only reads memory.
//   4. FAIL CLOSED — errors and timeouts are "unverifiable", never
//      "verified"; any future automation may key ONLY on a positive
//      "verified".
//
// Marker (line-anchored, quarantine-aware):
//   CLAIM: <text> | check: <kind> <args>
// Kinds (narrow by design — no arbitrary command execution):
//   http <url> [== <code>]          GET the url (default expects 2xx)
//   repo <path> [contains "s"]      file under the brain's repo root
//   vault <path> [contains "s"]     file under the brain's vault root
//   memory <topic> [contains "s"]   topic in the team memory store
//   git-tracked <path>              committed in the repo clone (not just on disk)
//   commit <sha>                    object exists in the repo clone
//   halm <HALM-n> [<status>]        ticket exists on the synced board (status optional)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { emit } from './eventlog.js';
import { recentChat, authoritative } from './chatroom.js';
import { getBrain } from './brain.js';
import { readMemoryRaw } from './memstore.js';
import { listTasks } from './store.js';

const CLAIM_RE = /^CLAIM:\s*(.+?)\s*\|\s*check:\s*(\S+)\s*(.*)$/;
const INTERVAL_MS = 60 * 1000;
const HTTP_TIMEOUT = 6000;

let verifyFile = null;
let verdicts = {};            // msgId -> { verdict, kind, detail, ts, claim }

const V = { OK: 'verified', NO: 'contradicted', UNK: 'unverifiable' };

function repoRoot() { return getBrain()?.roots?.repo?.path || null; }
function vaultRoot() { return getBrain()?.roots?.vault?.path || null; }

function safeJoin(root, rel) {
  const abs = path.resolve(root, String(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;   // escape → ambiguous → UNK
  return abs;
}

function fileCheck(root, rel, needle) {
  if (!root) return { verdict: V.UNK, detail: 'no brain root configured' };
  const abs = safeJoin(root, rel);
  if (!abs) return { verdict: V.UNK, detail: 'path escapes root' };
  if (!fs.existsSync(abs)) return { verdict: V.UNK, detail: 'file not found (missing ≠ disproven)' };
  if (!needle) return { verdict: V.OK, detail: 'file exists' };
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return text.includes(needle)
      ? { verdict: V.OK, detail: `contains "${needle.slice(0, 40)}"` }
      : { verdict: V.NO, detail: `file exists but does NOT contain "${needle.slice(0, 40)}"` };
  } catch { return { verdict: V.UNK, detail: 'unreadable' }; }
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function runCheck(kind, argstr) {
  const contains = /contains\s+"([^"]*)"/.exec(argstr)?.[1] ?? null;
  const first = argstr.replace(/contains\s+"[^"]*"/, '').trim().split(/\s+/)[0] || '';
  switch (kind) {
    case 'http': {
      const m = /^(\S+)(?:\s*==\s*(\d{3}))?/.exec(argstr.trim());
      if (!m) return { verdict: V.UNK, detail: 'bad http args' };
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT);
        const r = await fetch(m[1], { signal: ctl.signal });
        clearTimeout(t);
        const want = m[2] ? +m[2] : null;
        const ok = want ? r.status === want : r.ok;
        return ok
          ? { verdict: V.OK, detail: `HTTP ${r.status}` }
          : { verdict: V.NO, detail: `HTTP ${r.status}${want ? ` (expected ${want})` : ''}` };
      } catch { return { verdict: V.UNK, detail: 'unreachable (fail-closed)' }; }
    }
    case 'repo': return fileCheck(repoRoot(), first, contains);
    case 'vault': return fileCheck(vaultRoot(), first, contains);
    case 'memory': {
      try {
        const t = readMemoryRaw(first);
        if (!contains) return { verdict: V.OK, detail: `topic exists [${t.hash}]` };
        return t.content.includes(contains)
          ? { verdict: V.OK, detail: `topic contains it [${t.hash}]` }
          : { verdict: V.NO, detail: 'topic exists but does not contain it' };
      } catch { return { verdict: V.UNK, detail: 'no such topic' }; }
    }
    case 'git-tracked': {
      const root = repoRoot();
      if (!root) return { verdict: V.UNK, detail: 'no repo root' };
      const out = await git(root, ['ls-files', '--', first]);
      if (out === null) return { verdict: V.UNK, detail: 'git error (fail-closed)' };
      return out ? { verdict: V.OK, detail: 'tracked' } : { verdict: V.NO, detail: 'not tracked in the shared clone' };
    }
    case 'commit': {
      const root = repoRoot();
      const sha = /^[0-9a-f]{7,40}$/i.exec(first)?.[0];
      if (!root || !sha) return { verdict: V.UNK, detail: 'no repo root / bad sha' };
      const out = await git(root, ['cat-file', '-t', sha]);
      // Absence is UNK, not NO — the commit may simply not be fetched/pushed
      // yet. Multi-user rule: only pushed work is verifiable.
      return out === 'commit' ? { verdict: V.OK, detail: 'commit exists in shared clone' }
        : { verdict: V.UNK, detail: 'not in the shared clone (push it — unpushed work is unverifiable)' };
    }
    case 'halm': {
      const key = first.toUpperCase();
      const task = listTasks().find((t) => t.key === key);
      if (!task) return { verdict: V.UNK, detail: 'no such ticket on the synced board' };
      const status = argstr.trim().split(/\s+/)[1];
      if (!status) return { verdict: V.OK, detail: `exists [${task.status}]` };
      return task.status === status.toLowerCase()
        ? { verdict: V.OK, detail: `status ${task.status}` }
        : { verdict: V.NO, detail: `status is ${task.status}, not ${status}` };
    }
    default: return { verdict: V.UNK, detail: `unknown check kind "${kind}"` };
  }
}

async function pass() {
  for (const m of recentChat(200)) {
    if (verdicts[m.id]) continue;                        // verdicts freeze
    const line = authoritative(m.body).split('\n').map((l) => CLAIM_RE.exec(l.trim())).find(Boolean);
    if (!line) continue;
    const [, claim, kind, argstr] = line;
    let out;
    try { out = await runCheck(kind.toLowerCase(), argstr); }
    catch { out = { verdict: V.UNK, detail: 'verifier error (fail-closed)' }; }
    verdicts[m.id] = { ...out, kind: kind.toLowerCase(), claim: claim.slice(0, 160), ts: Date.now() };
    try { fs.writeFileSync(verifyFile, JSON.stringify(verdicts, null, 2)); } catch { /* next pass */ }
    emit('claim_verified', { msgId: m.id, ...verdicts[m.id] });
  }
}

export function initVerify(workspaceDir) {
  verifyFile = path.join(workspaceDir, 'verify.json');
  try { verdicts = JSON.parse(fs.readFileSync(verifyFile, 'utf8')); } catch { verdicts = {}; }
  setTimeout(() => pass().catch(() => { }), 5000);
  setInterval(() => pass().catch(() => { }), INTERVAL_MS);
}

export function claimVerdicts() { return verdicts; }
