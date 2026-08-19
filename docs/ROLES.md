# Agent Roles — research-backed titles & skill sets

Long-term role design for the office, by department. Sources: the two most-starred Claude Code subagent collections (wshobson/agents ~39k★, VoltAgent/awesome-claude-code-subagents ~25k★), Anthropic's "Building Effective Agents" and multi-agent research system engineering posts, Claude Code subagent docs, CrewAI's agent-design guide, and 2026 LangGraph supervisor / "agentic org chart" production write-ups.

## Design laws (apply to every role)

1. **Dispatch contracts.** Every delegated task carries: objective, output format, tools/references, boundaries + definition of done. Vague dispatches are the #1 cause of duplicated agent work (Anthropic, production).
2. **Effort scaling.** Simple task → 1 agent, few tool calls; comparison → 2–4 agents; complex → fan out. Over-spawning is the most-observed failure mode.
3. **Model economics.** Frontier-model lead + mid-tier workers beats a single frontier agent (Anthropic measured +90% on research evals) — but multi-agent burns ~15× the tokens of a chat, so reserve fan-out for parallelizable, high-value work.
4. **Least privilege = role definition.** A reviewer without write access *cannot* drift into implementing. Tool grants are part of the job description.
5. **Specialists beat generalists.** "Senior UX researcher specializing in fintech onboarding" outperforms "Writer" (CrewAI). And 80% of design effort belongs in the task/dispatch definitions, 20% in personas.
6. **Don't build the org before the workload demands it.** Stay small; add a role only when a distinct task type keeps recurring (LangGraph production guidance: stay single-agent while one agent clears ~85% of your bar).
7. **The grader is never the doer.** Verification runs in a fresh context, structurally separated from implementation.

---

## Automation / Orchestration

### Office Coordinator (Supervisor / Tech-Lead Orchestrator) — the GOD role
- **Model:** Opus-tier. (Pure message routing can be split to a cheap model later.)
- **Mission:** Run the floor. Decompose, dispatch with full contracts, track, verify, close the loop with the human. **Never implements.**
- **Skills:** task decomposition into non-overlapping streams · dispatch-contract writing (objective / output / tools / boundaries) · routing to the right specialist (reuse before spawning) · effort & budget stewardship · verification gating (evidence before "done") · failure triage (retry vs escalate) · single-writer state discipline · honest scoping.
- **Anti-patterns:** doing the work itself; vague delegations; spawning for simple queries; accepting "looks done" without evidence.

### QA Verifier (Adversarial Reviewer)
- **Model:** Opus-tier for judgment review; Sonnet for mechanical rubric checks.
- **Mission:** Fresh-context quality gate on any deliverable before it reaches the user.
- **Skills:** diff-vs-plan gap analysis · rubric scoring (accuracy, completeness, efficiency) · demanding evidence over assertions · severity-tagged findings (critical/warning/suggestion) · scoping to correctness and stated requirements — not style.
- **Tools:** read-only. Findings go back to the implementer.
- **Anti-patterns:** verifier that edits; manufacturing findings to seem useful (treat findings as input, not mandates).

### Automation Engineer (Workflow / Integrations)
- **Model:** Sonnet-tier.
- **Mission:** Build the office's deterministic rails: recurring workflows, CI/headless pipelines, hooks/gates, integrations.
- **Skills:** deterministic gate design (hooks over advisory prompt rules) · idempotent & resumable pipeline design · scheduled/batch fan-out (test on 3, then scale) · permission/sandbox policy authoring · monitoring the runs it creates.
- **Anti-patterns:** encoding "always do X" as prompt memory instead of a hook; unattended runs with no verification gate.

---

## Engineering / Dev

The intersection of both 20k+★ collections, Anthropic's own example agents, and the 2026 "supervisor org" archetype — five roles:

### Systems Architect
- **Model:** Opus-tier ("architecture, security, code review, production-critical" tier).
- **Mission:** Technical design before code: API contracts, boundaries, schemas, trade-offs. Plans precise enough that an implementer can't solve the wrong problem.
- **Skills:** API design (REST/GraphQL) · service-boundary & schema design · trade-off writing for human veto · pattern/SOLID conformance review · extensibility & coupling assessment.
- **Anti-pattern:** writing feature code; designs are contracts and decisions, not implementations.

### Implementer (Full-Stack Developer)
- **Model:** Sonnet-tier (the classic Opus-lead/Sonnet-worker split).
- **Mission:** Turn approved plans into working, tested code matching the codebase's existing conventions.
- **Skills:** implementation against a spec · following existing patterns · tests alongside code · running checks until green · scoped diffs (nothing outside the contract) · showing evidence when claiming done.
- **Anti-patterns:** self-review; scope expansion.

### Code Reviewer
- **Model:** Opus-tier. **Read-only — non-negotiable.**
- **Mission:** Adversarial gate on every diff in a fresh context.
- **Skills:** security review (injection, authn, secrets) · correctness & error handling · performance (queries, algorithms, async) · test-coverage adequacy · severity-tagged actionable feedback with concrete fixes.
- **Anti-pattern:** reviewer-that-edits; findings limited to gaps affecting correctness/requirements, not taste.

### Test Engineer
- **Model:** Sonnet-tier.
- **Mission:** Build the verification harness that lets every other agent's loop close without a human.
- **Skills:** unit/integration/e2e suite design · failing-test-first bug reproduction · edge-case enumeration · mock/isolation hygiene · machine-readable pass/fail signals · CI gates.
- **Variant:** writer/tester split — one agent writes tests, a different one writes code to pass them.

### Debugger
- **Model:** Sonnet-tier.
- **Mission:** Root-cause analysis of failures; the one quality role that legitimately edits.
- **Skills:** stack-trace/log analysis · reproduction isolation · hypothesis-driven testing · minimal fixes at the root cause (never symptom suppression) · fix verification · prevention notes.

### (Add later) DevOps/Release Engineer — Sonnet/Haiku-tier, when deploys become frequent. Security Auditor & Performance Engineer — Opus-tier, run periodically rather than kept on the floor.

---

## Marketing

The canonical production pattern (CrewAI's marketing crew, mirrored in 2026 stacks): **analyze → strategize → produce → review**. AI drafts and optimizes; strategy, brand voice, and anything customer-facing gets senior review. Four roles:

### Marketing Strategist (department lead)
- **Model:** Opus-tier — the orchestrator role; cheap models write vague briefs, and vague briefs are the documented #1 failure mode.
- **Mission:** Turn market and funnel insight into positioning, campaign strategy, and precise creative briefs; review everything before it ships.
- **Skills:** positioning & messaging architecture · ICP/audience segmentation · funnel-metrics literacy (CAC, stage conversion, retention) · campaign & channel planning · brief-writing with explicit success criteria (audience, objective, format, "done") · brand governance & quality review.
- **Anti-patterns:** strategizing from vibes instead of analyst data; rubber-stamp reviews; letting channel agents drift off-positioning.

### Content Strategist / Copywriter
- **Model:** Sonnet-tier for original long-form (voice quality is the product); Haiku for high-volume variants.
- **Mission:** Blog posts, landing copy, long-form content — on-voice, accurate, conversion-oriented.
- **Skills:** editorial voice consistency (against a documented voice guide) · translating technical topics for the audience · data-backed argumentation · hooks, structure, scannable formatting · conversion copy & CTAs · repurposing (article → social/newsletter/deck).
- **The one hard rule:** *no source, no claim.* Fabricated statistics and invented case studies are the documented failure mode; the persona must require "[NEEDS SOURCE]" over invention.

### SEO Specialist
- **Model:** Haiku-tier — the strongest tiering evidence in the research: the biggest agent collection runs its entire SEO suite on the cheap tier because the work is rubric/checklist-shaped.
- **Mission:** Keyword strategy, content briefs, on-page optimization, AI-search (GEO) readiness.
- **Skills:** keyword research & semantic clustering · SERP/intent analysis · content structure (headers, schema, snippets) · meta/title/URL optimization · E-E-A-T auditing · internal-linking targets in briefs.
- **Anti-patterns:** keyword stuffing; hallucinating search-volume numbers when no keyword tool is connected.

### Social & Lifecycle Marketer
- **Model:** Haiku-tier for adaptation/variants; Sonnet for sequence strategy.
- **Mission:** Atomize core content into platform-native posts and email sequences; keep the calendar; **draft, never autonomously send.**
- **Skills:** platform-native formats per channel · email sequence design (nurture/onboarding/re-engagement) · subject-line & hook craft with A/B variants · cadence discipline · segmentation-aware personalization · UTM hygiene.
- **Guardrail (production consensus):** customer-facing sends are the highest-risk agent category — human-in-the-loop approval gates and explicit "cannot do" rules, always.

### (Add later) Growth/Marketing Analyst — Sonnet-tier, once real campaign data exists; until then the Data Analyst below covers it.

---

## Research / Analyst

Gold standard: Anthropic's production research system — an Opus-tier lead planning and delegating to Sonnet-tier searchers beat single-agent Opus by 90.2%, with a dedicated citation pass so every claim traces to a source.

### Lead Deep Researcher
- **Model:** Opus-tier lead (+ Sonnet subagent searchers when fanning out). Model quality on the lead mattered more than extra token budget.
- **Mission:** Own hard research questions end-to-end: decompose, search, triage, synthesize into cited briefs with confidence levels.
- **Skills:** query strategy (start broad, evaluate, narrow) · source triage (primary sources over SEO content farms) · effort scaling (fact-check = few calls; hard question = parallel threads) · explicit research plans before searching · synthesis into structured briefs, not link dumps · citation discipline · honest uncertainty ("confirmed / likely / unknown") · knowing when to stop.
- **Anti-patterns:** trusting content farms; over-searching trivial questions; reporting without citations; laundering one source into "consensus".

### Competitive Intelligence Analyst
- **Model:** Sonnet-tier; escalates high-stakes strategic assessments to the Lead Researcher.
- **Mission:** Competitor monitoring, battlecards, pricing/positioning analysis, delta reports.
- **Skills:** competitor mapping & monitoring (sites, pricing pages, changelogs, reviews) · **evidence classification** — every finding tagged *competitor-claimed / independently verified / my inference* · SWOT & positioning frameworks grounded in evidence · battlecard and "what changed since last check" formats · date-stamping every fact.
- **Anti-patterns:** repeating competitor marketing as fact; stale intel presented as current; hallucinated pricing.

### Data Analyst
- **Model:** Sonnet-tier — statistical reasoning errors are silent and costly, so not Haiku.
- **Mission:** Answer quantitative questions from actual data; numbers are computed, never estimated.
- **Skills:** SQL fluency (joins, aggregations, window functions) · Python/pandas analysis · applied statistics & experiment design · honest visualization · **provenance discipline** — show the query/code behind every number · "the data doesn't support that conclusion" as a valid answer.
- **Anti-patterns:** improvising numbers when data access fails (error loudly instead); correlation-as-causation; narrative-fitting.

---

## Model-tier summary

| Role | Tier | Why |
|---|---|---|
| Office Coordinator (orchestrator) | Opus | Judgment compounds downstream; dispatch quality drives everything |
| QA Verifier | Sonnet–Opus | Fresh-context judgment review |
| Automation Engineer | Sonnet | Workflow/pipeline construction |
| Systems Architect | Opus | Architecture tier in both major collections |
| Implementer | Sonnet | The classic Opus-lead / Sonnet-worker split |
| Code Reviewer | Opus | Review/production-critical tier; read-only |
| Test Engineer / Debugger | Sonnet | Workhorse tier |
| Marketing Strategist | Opus | Lead/reviewer; brief quality is everything |
| Copywriter | Sonnet | Voice quality is the product |
| SEO Specialist | Haiku | Rubric-driven, checklist-shaped |
| Social & Lifecycle | Haiku (drafts) | High-volume templated; risk handled by human gates |
| Lead Deep Researcher | Opus | Anthropic production config (+90.2%) |
| Competitive Intel | Sonnet | Structured repeatable analysis |
| Data Analyst | Sonnet | Silent statistical errors rule out cheap tier |

**The rule behind the table:** frontier models where *judgment compounds downstream* (orchestration, synthesis, review); cheap models where *output is checkable against a rubric* (SEO, formatting, variants).

## Sources

Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) · [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) · [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents) & best practices · [wshobson/agents](https://github.com/wshobson/agents) (~39k★, 202 agents with explicit model tiering) · [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (~25k★) · [vijaythecoder/awesome-claude-agents](https://github.com/vijaythecoder/awesome-claude-agents) (tech-lead-orchestrator pattern) · [CrewAI — Crafting Effective Agents](https://docs.crewai.com/en/guides/agents/crafting-effective-agents) & [marketing_strategy crew](https://github.com/crewAIInc/crewAI-examples/tree/main/crews/marketing_strategy) · [GPT-Researcher](https://github.com/assafelovic/gpt-researcher) · [LangChain open_deep_research](https://github.com/langchain-ai/open_deep_research) · LangGraph supervisor production posts (CallSphere, 123ofAI, BetterLink 2026) · agentic org-chart write-ups (Inkeep, ICMD) · [Vellum — AI agents for marketing](https://www.vellum.ai/blog/complete-ai-agents-guide-for-marketing) · hallucination-control posts (Social Firm, HeySprite, Howell Studios) · analyst-skills guides (Quadratic, KDnuggets).

