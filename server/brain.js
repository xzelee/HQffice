// Project brain — the office's centralized knowledge. A read-only bridge to
// the project's Obsidian vault and git repo, exposed to EVERY office agent
// through three bounded tools (brain_search / brain_read / brain_list), so
// the whole office — the user's agents and every teammate's — shares one
// source of truth instead of private copies of it.
//
// Read-only by construction: no write path exists here. Bounded by
// construction: extension allowlist, per-file size cap, hit caps, and heavy
// directories skipped — an agent can never pull the whole repo into context.
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';

const TEXT_EXT = new Set([
  '.md', '.txt', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonl',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.css', '.html', '.sh', '.ps1', '.sql',
  '.env.example', '.dockerfile', '.makefile', '',
]);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', 'dist', 'build', '.obsidian', '.venv', 'venv',
  'models', 'recordings', 'checkpoints', 'weights', '.channel-state',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_LINES = 300;
const MAX_HITS = 40;
const MAX_FILES_WALKED = 8000;

let brainFile = null;
let brain = null;   // { name, roots: {vault: path, repo: path}, hub }

export function initBrain(workspaceDir) {
  brainFile = path.join(workspaceDir, 'brain.json');
  try { brain = JSON.parse(fs.readFileSync(brainFile, 'utf8')); } catch { brain = null; }
}

export function getBrain() {
  if (!brain) return null;
  const roots = {};
  for (const [k, p] of Object.entries(brain.roots || {})) roots[k] = { path: p, exists: fs.existsSync(p) };
  return { name: brain.name, hub: brain.hub || null, roots };
}

export function setBrain(next) {
  if (next === null) { brain = null; }
  else {
    const roots = {};
    for (const [k, p] of Object.entries(next.roots || {})) {
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) roots[k.replace(/[^\w-]/g, '')] = path.resolve(p);
    }
    if (!Object.keys(roots).length) throw new Error('brain needs at least one existing root directory');
    brain = { name: String(next.name || 'project').slice(0, 80), roots, hub: next.hub ? String(next.hub).slice(0, 200) : null };
  }
  if (brainFile) {
    if (brain) fs.writeFileSync(brainFile, JSON.stringify(brain, null, 2));
    else if (fs.existsSync(brainFile)) fs.unlinkSync(brainFile);
  }
  emit('brain_configured', { brain: getBrain() });
  return getBrain();
}

// A ref is "<rootKey>:<relative/path>" e.g. "vault:decisions/amd.md".
function resolveRef(ref) {
  if (!brain) throw new Error('no project brain configured');
  const m = String(ref || '').match(/^([\w-]+):(.*)$/);
  if (!m || !brain.roots[m[1]]) throw new Error(`bad ref "${ref}" — use <root>:<path> with root one of: ${Object.keys(brain.roots).join(', ')}`);
  const root = brain.roots[m[1]];
  const abs = path.resolve(root, m[2] || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes the brain root');
  return { rootKey: m[1], root, abs, rel: m[2] || '' };
}

function readable(abs) {
  const base = path.basename(abs).toLowerCase();
  const ext = path.extname(base);
  if (base === 'makefile' || base === 'dockerfile') return true;
  return TEXT_EXT.has(ext);
}

export function listBrain(ref) {
  const { rootKey, abs, rel } = resolveRef(ref || `${Object.keys(brain.roots)[0]}:`);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${rootKey}:${rel ? rel.replace(/\/?$/, '/') : ''}${e.name}`);
  return entries.join('\n') || '(empty)';
}

export function readBrain(ref, offset = 1, limit = MAX_READ_LINES) {
  const { abs } = resolveRef(ref);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return listBrain(ref);
  if (st.size > MAX_FILE_BYTES) throw new Error(`file too large (${Math.round(st.size / 1024)}KB > ${MAX_FILE_BYTES / 1024}KB)`);
  if (!readable(abs)) throw new Error('not a readable text type');
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, offset | 0);
  const n = Math.min(Math.max(1, limit | 0), MAX_READ_LINES);
  const slice = lines.slice(start - 1, start - 1 + n);
  const body = slice.map((l, i) => `${start + i}\t${l.length > 400 ? l.slice(0, 400) + '…' : l}`).join('\n');
  const more = lines.length - (start - 1 + slice.length);
  return body + (more > 0 ? `\n… (${more} more lines — call again with offset ${start + slice.length})` : '');
}

export function searchBrain(query, rootKey = null) {
  if (!brain) throw new Error('no project brain configured');
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) throw new Error('query too short');
  const roots = rootKey ? { [rootKey]: brain.roots[rootKey] } : brain.roots;
  const hits = [];
  let walked = 0;
  for (const [key, root] of Object.entries(roots)) {
    if (!root) continue;
    const stack = [root];
    while (stack.length && hits.length < MAX_HITS && walked < MAX_FILES_WALKED) {
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
        if (!readable(abs)) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        if (!text.toLowerCase().includes(q)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            const l = lines[i].trim();
            hits.push(`${key}:${rel}:${i + 1}  ${l.length > 200 ? l.slice(0, 200) + '…' : l}`);
            if (hits.length % 3 === 0) break;   // max 3 lines per file, keep coverage broad
          }
        }
      }
    }
  }
  if (!hits.length) return `No matches for "${query}"${walked >= MAX_FILES_WALKED ? ' (walk capped — try a root filter)' : ''}.`;
  return hits.join('\n') + (hits.length >= MAX_HITS ? `\n… (capped at ${MAX_HITS} hits — narrow the query)` : '');
}
