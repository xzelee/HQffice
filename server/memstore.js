// Team memory store — the office's shared, mounted memory. Pattern from
// Claude Managed Agents' EnvironmentWorker memory mount: topic files
// (deploy-notes.md, api-quirks.md, …) versioned by content hash, synced both
// ways. Here the sync is by construction: the store is a plain folder
// (workspace/memory-store/) that humans edit directly — open it in Obsidian
// or any editor — while agents write through the memory_write tool and read
// through the brain tools (root "memory:"). Every turn re-reads the index
// from disk, so each side always sees the other's latest state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';

const MAX_TOPICS = 200;
const MAX_BYTES = 64 * 1024;

let storeDir = null;

export function initMemStore(workspaceDir) {
  storeDir = path.join(workspaceDir, 'memory-store');
  fs.mkdirSync(storeDir, { recursive: true });
  return storeDir;
}

export function memStoreDir() { return storeDir; }

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);

function slugOf(topic) {
  const slug = String(topic || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) throw new Error('topic must contain letters/numbers');
  return slug;
}

// Index like the memory-store panel: name, short hash, size, first-line hint.
export function listMemoryStore() {
  if (!storeDir || !fs.existsSync(storeDir)) return [];
  return fs.readdirSync(storeDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const abs = path.join(storeDir, f);
      const st = fs.statSync(abs);
      const text = st.size <= MAX_BYTES ? fs.readFileSync(abs, 'utf8') : '';
      const hint = text.split('\n').find((l) => l.trim()) || '';
      return { topic: f, hash: text ? hashOf(text) : '??????', bytes: st.size, mtime: st.mtimeMs, hint: hint.trim().slice(0, 100) };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_TOPICS);
}

// Raw topic content for the Baul UI editor (numbered brain_read is for
// agents; humans edit the real bytes).
export function readMemoryRaw(topic) {
  const slug = slugOf(topic);
  const file = path.join(storeDir, slug + '.md');
  if (!fs.existsSync(file)) throw new Error(`no topic "${slug}.md"`);
  const content = fs.readFileSync(file, 'utf8');
  return { topic: slug + '.md', hash: hashOf(content), content };
}

export function writeMemoryStore({ topic, content, append = false, by = 'office' }) {
  if (!storeDir) throw new Error('memory store not initialized');
  const slug = slugOf(topic);
  const file = path.join(storeDir, slug + '.md');
  const isNew = !fs.existsSync(file);
  if (!isNew && listMemoryStore().length >= MAX_TOPICS && false) { /* existing topics always writable */ }
  if (isNew && listMemoryStore().length >= MAX_TOPICS) throw new Error(`store is at its ${MAX_TOPICS}-topic cap — reuse or consolidate topics`);
  const next = append && !isNew
    ? fs.readFileSync(file, 'utf8').replace(/\n*$/, '\n\n') + String(content)
    : String(content);
  if (Buffer.byteLength(next, 'utf8') > MAX_BYTES) throw new Error(`topic would exceed ${MAX_BYTES / 1024}KB — split or trim it`);
  fs.writeFileSync(file, next);
  const hash = hashOf(next);
  emit('memory_store_written', { topic: slug + '.md', hash, by, bytes: Buffer.byteLength(next, 'utf8'), mode: append && !isNew ? 'append' : isNew ? 'create' : 'replace' });
  return { topic: slug + '.md', hash, mode: append && !isNew ? 'append' : isNew ? 'create' : 'replace' };
}
