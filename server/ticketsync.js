// HALM ticket sync — one-way mirror from the project brain's Obsidian
// ticket notes (vault:tickets/*.md) onto the office task board. The vault is
// the source of truth: synced cards are re-stamped on every pass, keyed by
// their HALM id so they update in place instead of duplicating.
//
// Parse contract (the vault mirror's own format):
//   ## HALM-79 — Device/condition QA campaign
//   Status: In Progress / Assignee: Rizelle Bautista / Priority: ...
// ("|" separators in the rollup notes are accepted too; "## HALM-71 — MISSING"
// entries are skipped; week*.md files are parsed last so they win over
// rollups when a ticket appears in both.)
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';
import { listTasks, createTask, updateTask, listPeople } from './store.js';
import { getBrain } from './brain.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

function statusOf(text) {
  if (/done/i.test(text)) return 'done';
  if (/in progress/i.test(text)) return 'in_progress';
  if (/review|qa\b/i.test(text)) return 'review';
  return 'inbox';
}

// "Julius Callejo" → person "juls" etc.: match on the first three letters of
// the first name; unmatched assignees keep their raw name.
function assigneeLabel(raw) {
  if (!raw || /^unassigned$/i.test(raw)) return null;
  const first3 = raw.trim().toLowerCase().slice(0, 3);
  const person = listPeople().find((p) => p.name.trim().toLowerCase().slice(0, 3) === first3);
  return person ? person.name : raw.trim();
}

function parseTickets(dir) {
  const tickets = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    .sort((a, b) => (a.startsWith('week') ? 1 : 0) - (b.startsWith('week') ? 1 : 0) || a.localeCompare(b));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#{2,4}\s+(HALM-\d+)\s+[—–-]\s+(.+?)\s*$/);
      if (!h) continue;
      const [, key, title] = h;
      if (/^MISSING\b/.test(title)) continue;
      // the meta line is the first non-empty line after the heading — either
      // "Status: X / Assignee: Y / …" (labeled) or
      // "Task | Done | Julius Callejo | …" (positional, the week1-3 style)
      let meta = '';
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (/^Status:/i.test(l) || /^(Task|Epic|Milestone|Bug|Story|Subtask)\s*\|/i.test(l)) meta = l;
        break;
      }
      if (!meta && tickets.has(key)) continue;   // keep the richer earlier entry
      let status = 'inbox', assignee = null;
      if (/^Status:/i.test(meta)) {
        const fields = Object.fromEntries(
          meta.split(/\s*[/|]\s*/).map((f) => {
            const m = f.match(/^([\w -]+?):\s*(.*)$/);
            return m ? [m[1].trim().toLowerCase(), m[2].trim()] : null;
          }).filter(Boolean),
        );
        status = statusOf(fields.status || '');
        assignee = assigneeLabel(fields.assignee);
      } else if (meta) {
        const parts = meta.split('|').map((p) => p.trim());
        status = statusOf(parts[1] || '');
        assignee = assigneeLabel(parts[2]);
      }
      tickets.set(key, {
        key,
        title: title.slice(0, 160),
        status,
        assignee,
        ref: `vault:tickets/${file}`,
      });
    }
  }
  return tickets;
}

export function syncTickets() {
  const brain = getBrain();
  const vault = brain?.roots?.vault;
  if (!vault?.exists) return { skipped: 'no brain vault configured' };
  const dir = path.join(vault.path, 'tickets');
  if (!fs.existsSync(dir)) return { skipped: 'vault has no tickets/ folder' };

  const tickets = parseTickets(dir);
  const byKey = new Map(listTasks().filter((t) => t.key).map((t) => [t.key, t]));
  let created = 0, updated = 0;
  for (const t of tickets.values()) {
    const description = `${t.ref} — mirrored from the HALM board snapshot (brain_read the ref for the full body)`;
    const existing = byKey.get(t.key);
    if (existing) {
      if (existing.title !== `${t.key} · ${t.title}` || existing.status !== t.status || existing.assignedTo !== t.assignee) {
        updateTask(existing.id, { title: `${t.key} · ${t.title}`, status: t.status, assignedTo: t.assignee });
        updated++;
      }
    } else if (t.status !== 'done') {
      // done-and-never-seen tickets stay in the vault as history; the board
      // only takes on work that is still alive.
      createTask({ title: `${t.key} · ${t.title}`, description, status: t.status, assignedTo: t.assignee, key: t.key, source: 'halm' });
      created++;
    }
  }
  const out = { parsed: tickets.size, created, updated };
  if (created || updated) emit('tickets_synced', out);
  return out;
}

export function initTicketSync() {
  setTimeout(() => { try { syncTickets(); } catch (e) { emit('error', { error: `ticket sync: ${e.message}` }); } }, 3000);
  setInterval(() => { try { syncTickets(); } catch { /* next pass */ } }, SYNC_INTERVAL_MS);
}
