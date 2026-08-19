// Claude usage monitoring: aggregate per-agent and total token/cost figures
// from Agent SDK result messages. Persisted so numbers survive restarts.
import fs from 'node:fs';
import path from 'node:path';
import { emit } from './eventlog.js';

let usageFile = null;
const totals = {
  totalCostUsd: 0,
  totalTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  byAgent: {},   // agentId -> {name, model, costUsd, turns, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, lastTurnMs}
};

export function initUsage(workspaceDir) {
  usageFile = path.join(workspaceDir, 'usage.json');
  try { Object.assign(totals, JSON.parse(fs.readFileSync(usageFile, 'utf8'))); } catch { /* fresh */ }
}

export function recordUsage(agent, result) {
  const u = result?.usage || {};
  const cost = result?.total_cost_usd || 0;
  const entry = totals.byAgent[agent.id] || (totals.byAgent[agent.id] = {
    name: agent.name, model: agent.model, costUsd: 0, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastTurnMs: 0,
  });
  entry.name = agent.name;
  entry.model = agent.model;
  entry.costUsd += cost;
  entry.turns += 1;
  entry.inputTokens += u.input_tokens || 0;
  entry.outputTokens += u.output_tokens || 0;
  entry.cacheReadTokens += u.cache_read_input_tokens || 0;
  entry.cacheWriteTokens += u.cache_creation_input_tokens || 0;
  entry.lastTurnMs = result?.duration_ms || 0;

  totals.totalCostUsd += cost;
  totals.totalTurns += 1;
  totals.inputTokens += u.input_tokens || 0;
  totals.outputTokens += u.output_tokens || 0;
  totals.cacheReadTokens += u.cache_read_input_tokens || 0;
  totals.cacheWriteTokens += u.cache_creation_input_tokens || 0;

  if (usageFile) fs.writeFileSync(usageFile, JSON.stringify(totals, null, 2));
  emit('usage', {
    agentId: agent.id,
    turn: {
      costUsd: cost,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      durationMs: result?.duration_ms || 0,
      numTurns: result?.num_turns || 0,
    },
    totals: usageSummary(),
  });
}

export function usageSummary() {
  return totals;
}

// Lifetime token consumption for one agent (all buckets, munder-style
// cumulative count) — the number per-agent budgets are enforced against.
export function agentTokens(agentId) {
  const e = totals.byAgent[agentId];
  if (!e) return 0;
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
}
