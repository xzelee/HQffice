// Brain watcher — the office's live wire to the Hello Alex project, modeled
// on the Chatroom Lab's channel_hook: every update to a brain root lands in
// #office automatically as an ambient "alex-sync" post (a plain post wakes
// nobody; the update simply becomes context every agent sees next turn).
//
// Roots with a .git are followed by commit (git log polling); plain roots
// (the Obsidian vault) by file mtimes. Roots living inside the office
// workspace (the team memory store) are skipped — agent writes there are
// already announced. Last-seen state persists to workspace/brainwatch.json
// so a server restart never replays history.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getBrain } from './brain.js';
import { postChat } from './chatroom.js';

const POLL_MS = 45_000;
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', 'dist', 'build', '.obsidian', '.venv', 'venv',
  'models', 'recordings', 'checkpoints', 'weights', '.channel-state',
]);
const MAX_FILES = 6000;

let stateFile = null;
let workspaceAbs = null;
let st = { commits: {}, mtimes: {} };   // rootKey -> last seen

function save() { try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2)); } catch { /* best effort */ } }

export function initBrainWatch(workspaceDir) {
  workspaceAbs = path.resolve(workspaceDir);
  stateFile = path.join(workspaceDir, 'brainwatch.json');
  try { st = { commits: {}, mtimes: {}, ...JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^﻿/, '')) }; } catch { /* fresh */ }
  setTimeout(tick, 15_000);
  setInterval(tick, POLL_MS).unref?.();
}

function post(body) {
  postChat({ from: 'alex-sync', fromKind: 'user', name: 'alex-sync', body });
}

function tick() {
  const brain = getBrain();
  if (!brain) return;
  for (const [key, info] of Object.entries(brain.roots || {})) {
    if (!info.exists) continue;
    if (path.resolve(info.path).startsWith(workspaceAbs)) continue;   // team memory store: already announced
    if (fs.existsSync(path.join(info.path, '.git'))) checkGit(key, info.path);
    else checkMtimes(key, info.path);
  }
}

function checkGit(key, root) {
  execFile('git', ['-C', root, 'log', '-15', '--pretty=%H%x09%an%x09%s'], { timeout: 15_000 }, (err, stdout) => {
    if (err || !stdout) return;
    const commits = stdout.trim().split('\n').map((l) => {
      const [hash, author, subject] = l.split('\t');
      return { hash, author, subject };
    }).filter((c) => c.hash);
    if (!commits.length) return;
    const known = st.commits[key];
    if (!known) { st.commits[key] = commits[0].hash; return save(); }   // baseline: don't replay history
    const fresh = [];
    for (const c of commits) { if (c.hash === known) break; fresh.push(c); }
    if (!fresh.length) return;
    st.commits[key] = commits[0].hash; save();
    const lines = fresh.slice(0, 3).map((c) => `• ${c.author}: ${c.subject} (${c.hash.slice(0, 7)})`);
    if (fresh.length > 3) lines.push(`…and ${fresh.length - 3} more`);
    post(`🔁 ${key} update — ${fresh.length} new commit${fresh.length > 1 ? 's' : ''} in the Hello Alex local model:\n${lines.join('\n')}`);
  });
}

function checkMtimes(key, root) {
  const since = st.mtimes[key];
  let newest = since || 0, walked = 0;
  const changed = [];
  const stack = [root];
  while (stack.length && walked < MAX_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
        continue;
      }
      walked++;
      let m; try { m = fs.statSync(abs).mtimeMs; } catch { continue; }
      if (m > newest) newest = m;
      if (since && m > since) changed.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  if (!since) { st.mtimes[key] = newest || Date.now(); return save(); }   // baseline
  if (!changed.length) return;
  st.mtimes[key] = newest; save();
  const shown = changed.slice(0, 5).map((f) => `• ${key}:${f}`);
  if (changed.length > 5) shown.push(`…and ${changed.length - 5} more`);
  post(`📝 ${key} update — ${changed.length} file${changed.length > 1 ? 's' : ''} changed in the Hello Alex local model:\n${shown.join('\n')}`);
}
