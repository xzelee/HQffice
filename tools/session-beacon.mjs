#!/usr/bin/env node
// HQ-Agents session beacon — run this on YOUR machine so the office floor
// shows your live Claude Code sessions next to your character.
//
//   node tools/session-beacon.mjs --server http://<office-ip>:4643 --name "Alex"
//
// It scans ~/.claude/projects for session transcripts touched in the last
// few minutes and reports them every 15s. Stop it with Ctrl-C; your
// sessions disappear from the floor within a minute.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SERVER = (args.server || 'http://localhost:4643').replace(/\/$/, '');
const NAME = args.name;
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;
const INTERVAL_MS = 15000;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

if (!NAME && !args.person) {
  console.error('usage: node session-beacon.mjs --server http://<office-ip>:4643 --name "Your Name"');
  process.exit(1);
}

async function resolvePersonId() {
  if (args.person) return args.person;
  const state = await (await fetch(`${SERVER}/api/state`)).json();
  const existing = state.people.find((p) => p.name.toLowerCase() === NAME.toLowerCase());
  if (existing) return existing.id;
  const { person } = await (await fetch(`${SERVER}/api/people`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: NAME }),
  })).json();
  console.log(`joined the office as ${person.name} (${person.id}) — open ${SERVER} to customize your character`);
  return person.id;
}

function scanSessions() {
  const sessions = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return sessions; }
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let freshest = 0;
    for (const f of files) {
      try {
        const m = fs.statSync(path.join(PROJECTS_DIR, dir, f)).mtimeMs;
        if (m > freshest) freshest = m;
      } catch { /* transient file */ }
    }
    const age = Date.now() - freshest;
    if (freshest && age < ACTIVE_WINDOW_MS) {
      const project = dir.split('-').filter(Boolean).slice(-2).join('/');
      sessions.push({ project, ageSec: Math.round(age / 1000) });
    }
  }
  return sessions.sort((a, b) => a.ageSec - b.ageSec);
}

const personId = await resolvePersonId();
console.log(`beacon running → ${SERVER} (person ${personId}); scanning ${PROJECTS_DIR}`);

let lastCount = -1;
async function tick() {
  const sessions = scanSessions();
  try {
    await fetch(`${SERVER}/api/people/${personId}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions }),
    });
    if (sessions.length !== lastCount) {
      lastCount = sessions.length;
      console.log(`${new Date().toTimeString().slice(0, 8)} reporting ${sessions.length} live session(s): ${sessions.map((s) => s.project).join(', ') || '—'}`);
    }
  } catch (e) {
    console.error('beacon: server unreachable —', e.message);
  }
}
await tick();
setInterval(tick, INTERVAL_MS);
