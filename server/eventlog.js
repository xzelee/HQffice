// Append-only event log + in-process pub/sub.
// Every state change in the office flows through here; the dashboard is a
// renderer over this stream (munder-difflin's event-log pattern).
import fs from 'node:fs';
import path from 'node:path';

const listeners = new Set();
let logPath = null;
let seq = 0;

export function initEventLog(workspaceDir) {
  logPath = path.join(workspaceDir, 'events.jsonl');
  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) seq = (JSON.parse(lines[lines.length - 1]).seq || 0);
    } catch { seq = 0; }
  }
}

export function emit(type, data = {}) {
  const event = { seq: ++seq, ts: Date.now(), type, ...data };
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  for (const fn of listeners) {
    try { fn(event); } catch { /* listener errors must not break the loop */ }
  }
  return event;
}

// High-frequency transient events (movement, presence ticks): broadcast to
// live listeners but never written to disk.
export function emitTransient(type, data = {}) {
  const event = { ts: Date.now(), type, transient: true, ...data };
  for (const fn of listeners) {
    try { fn(event); } catch { /* listener errors must not break the loop */ }
  }
  return event;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentEvents(limit = 200) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
