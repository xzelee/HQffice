// Skills Shop — the office storefront where agents get equipped with new
// tricks. Three providers stock the shelves: claude (reasoning craft),
// openclaw (automation muscle), hermes (local/fast inference habits).
// A purchased skill is REAL: its `instruction` is injected into the agent's
// system prompt (see runtime.js personaSystemPrompt), so buying changes how
// the agent actually works. Prices are office credits — flavor, not a wallet.
export const SKILLS = [
  // --- claude ------------------------------------------------------------
  {
    id: 'claude-deep-research', provider: 'claude', name: 'Deep Research', price: 140,
    blurb: 'Triangulate sources, cite refs, flag uncertainty honestly.',
    instruction: 'When investigating anything, gather at least two independent sources (brain refs, web, teammates) before concluding; cite each claim (ref or URL) and state confidence + what would change your mind.',
  },
  {
    id: 'claude-code-review', provider: 'claude', name: 'Code Review', price: 120,
    blurb: 'Hunt real bugs first, style later; verify before reporting.',
    instruction: 'When reviewing code or a change, hunt correctness bugs first (inputs/state → wrong output), verify each finding against the actual code path before reporting it, and rank findings by severity — never pad with style nits.',
  },
  {
    id: 'claude-crisp-writing', provider: 'claude', name: 'Crisp Writing', price: 90,
    blurb: 'Lead with the outcome; cut every sentence that does no work.',
    instruction: 'Every deliverable you write leads with the outcome in the first sentence, uses concrete nouns over abstractions, and cuts any sentence that does not change what the reader does next.',
  },
  // --- openclaw ----------------------------------------------------------
  {
    id: 'openclaw-web-automation', provider: 'openclaw', name: 'Web Automation', price: 130,
    blurb: 'Drive sites step-by-step; screenshot-verify every action.',
    instruction: 'When a task involves a website or web app, plan it as explicit steps (navigate, act, verify), verify each step actually happened before the next, and report the evidence trail — never assume a click worked.',
  },
  {
    id: 'openclaw-cron-routines', provider: 'openclaw', name: 'Cron Routines', price: 110,
    blurb: 'Turn repeated work into scheduled, self-reporting routines.',
    instruction: 'When you notice work repeating, propose a routine: trigger, steps, expected output, and how failures surface. Design every recurring job to report its own outcome instead of failing silently.',
  },
  {
    id: 'openclaw-integrations', provider: 'openclaw', name: 'Integrations', price: 100,
    blurb: 'Glue services together; respect rate limits and idempotency.',
    instruction: 'When connecting services or APIs, design for idempotency (safe retries), respect rate limits, and log each side-effectful call so a teammate can audit what was sent where.',
  },
  // --- hermes ------------------------------------------------------------
  {
    id: 'hermes-fast-draft', provider: 'hermes', name: 'Fast Draft', price: 80,
    blurb: 'Ship a rough complete draft first, polish second.',
    instruction: 'Bias to a complete rough draft over a perfect fragment: produce the full shape of the deliverable first, mark weak spots with TODO lines, then iterate. Never spend a whole turn polishing an intro.',
  },
  {
    id: 'hermes-local-inference', provider: 'hermes', name: 'Local Inference', price: 120,
    blurb: 'Know when a small local model beats a big remote one.',
    instruction: 'When proposing model choices, weigh local/small-model options (latency, cost, privacy) against remote frontier models, and recommend the cheapest tier that meets the quality bar — with the tradeoff stated.',
  },
  {
    id: 'hermes-data-wrangling', provider: 'hermes', name: 'Data Wrangling', price: 100,
    blurb: 'Profile first, transform second; show row counts at each step.',
    instruction: 'When handling datasets, profile before transforming (shape, nulls, ranges), keep a row-count trail through each step, and validate the output against the input totals before declaring it done.',
  },
];

export const getSkill = (id) => SKILLS.find((s) => s.id === id) || null;
