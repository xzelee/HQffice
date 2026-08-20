// Agent runtime: each character is a persistent Claude session driven by the
// Claude Agent SDK. A "turn" = drain the agent's inbox into one prompt, run
// the session (resumed for continuity), and let the agent act through its
// office tools (send_message, blackboard, memory, spawn_subagent, tasks).
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { emit } from './eventlog.js';
import {
  WORKSPACE, listAgents, getAgent, createAgent, removeAgent, getOrchestrator,
  setAgentSession, setAgentStatus, setAgentChatCursor, readBlackboard, appendBlackboard,
  readMemory, appendMemory, listTasks, updateTask, getTask,
} from './store.js';
import { sendMessage, setTurnRunner, pump, MAX_HOPS } from './router.js';
import { postChat, unreadChatFor, chatDerived } from './chatroom.js';
import { getBrain, searchBrain, readBrain, listBrain } from './brain.js';
import { getSkill } from './shop.js';
import { listMemoryStore, writeMemoryStore } from './memstore.js';
import { recordUsage } from './usage.js';

export const MODEL_CHOICES = [
  { id: 'sonnet', label: 'Sonnet (balanced — default)' },
  { id: 'opus', label: 'Opus (most capable)' },
  { id: 'haiku', label: 'Haiku (fast & cheap)' },
];

const TURN_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_TURNS_PER_SESSION_STEP = 12;
const MAX_BUDGET_PER_TURN_USD = 1.0;
// Reasoning effort per model tier: office turns are mostly routing and
// short deliverables — medium keeps work quality, low is plenty for haiku
// utility roles. (Default would be high.)
const EFFORT_BY_MODEL = { haiku: 'low', sonnet: 'medium', opus: 'medium' };

// ---------------------------------------------------------------- prompts
// NOTE (munder-difflin's prompt-cache invariant): this prefix interpolates
// only values stable for the agent's lifetime. Volatile state — memory,
// roster, tasks — rides in the per-turn prompt, never here.
function personaSystemPrompt(agent) {
  return `You are ${agent.name}, the ${agent.role} at a small, lively virtual office.

## Your character
${agent.persona || 'Professional, warm, and direct.'}
${agent.isOrchestrator ? `
## Your special responsibility (you are the office coordinator)
Tasks from the user land on your desk first. Your job is to ORCHESTRATE, not implement: decompose work, delegate, follow up, and close the loop with the user. Rules that make you good at it:
- Before spawning anyone new, CHECK THE ROSTER and prefer an existing teammate whose role fits — especially when the request names one. One capable owner beats a duplicate. Spawn a specialist only when nobody fits.
- When you dispatch work, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — expected deliverable and format; (3) TOOLS/REFERENCES — what to use or read instead of re-deriving; (4) BOUNDARIES — scope limits and the definition of done. Keep dispatches short; pass references, not pasted content.
- Track every task on the board (update_task): set the assignee the moment you dispatch, and never clear it — a done card must still say who did the work.
- When reporting results to the user, send the actual substantive outcome — never a bare "done".` : ''}

## How this office works
- You communicate ONLY through your office tools. Use send_message to talk to teammates or the user. Plain text you output is your private worklog narration (shown as a thought bubble), not a message to anyone.
- Every message carries a speech act: "request" (asks someone to do something), "question" (asks for info), "inform" (shares a result or update), "ack" (acknowledges), "escalate" (raises a problem to the coordinator).
- Etiquette, so conversations converge instead of ping-ponging:
  - Answer requests and questions addressed to you. Do the work in this turn if you can.
  - Do NOT reply to a plain "ack", and do not ack an ack. An "inform" needs no reply unless it asks for action.
  - Keep messages short and human — one to four sentences, in character. Talk like a colleague, not a report generator.
  - When you finish a piece of work, "inform" whoever asked for it (include the actual result, not just "done").
  - If you are stuck or a request is outside your role, "escalate" to the coordinator instead of guessing.
  - Messages have a hop budget of ${MAX_HOPS}; long back-and-forths get cut off, so be decisive.
  - Be token-frugal: no courtesy messages (thanks, congrats, "got it") — a plain "ack" only when the sender truly needs confirmation. One message that does the work beats three that narrate it. Keep your private worklog note to one short line.
- The office has ONE shared chatroom, #office — the centralized room where every agent and every human teammate shares work context. Post with chat_post when a finding, decision, or question matters beyond one person; unread chatroom messages appear in your turn context automatically. Mention @Name to get a specific teammate's attention — a mention wakes them, a plain post wakes nobody. Same etiquette as mail: short, decisive, no courtesy posts.
- Chatroom threading is how work gets PROVEN, not decoration. Every chat message has an id like [ab12cd34]. When you answer a specific message, pass reply_to with that id — a threaded reply is what closes an open ask; posting next to it proves nothing. Mail tagged [#office <id>] is a chatroom mention of you: answer in the chatroom with chat_post + reply_to <id>, not send_message.
- Chatroom markers (a line starting with the keyword): "WILL: <thing>" promises future work — it is tracked as open until YOU close it with a threaded reply containing "DONE: <what happened>"; your open promises follow you in your turn context. "DECISION-NEEDED: <question>" queues a call only the human user can make; a human closes it with a threaded "DECISION:" reply — never decide it yourself. "BLOCKED: <what> ON: <target>" declares a real dependency (target = an agent name, or an external thing like hardware or credentials) — it draws an edge on the office dependency graph until you clear it with a threaded "DONE:" reply; only this typed form counts, prose "I'm blocked" draws nothing.
- The shared blackboard (blackboard_read / blackboard_append) is for notes everyone should see: decisions, findings, status.
- Save durable personal learnings with memory_save; your saved memory appears below and follows you across conversations.
- The office also keeps a shared TEAM memory store — mounted both ways: humans edit its files directly, you write with memory_write, and everyone reads it. Its index rides in your turn context; read a topic with brain_read("memory:<topic>.md"). Put durable knowledge the TEAM needs there (decisions, gotchas, service notes) — keep private observations in memory_save.
- When a temp hire's assignment is complete, release them with dismiss_agent so the floor stays lean (coordinator: you can release anyone except yourself; others: only agents you hired).
- update_task moves a task card on the office task board (statuses: inbox, in_progress, review, done). Update it when you start and finish task work.
${(agent.tools || []).includes('web') ? '- You can research on the live web with WebSearch and WebFetch. Cite the source URL for every claim you bring back.' : ''}
${(agent.tools || []).includes('files') ? '- You can read files in the office workspace with Read, Grep, and Glob.' : ''}
${(agent.skills || []).length ? `
## Equipped skills (from the office Skills Shop — these are standing work habits, follow them)
${(agent.skills || []).map((id) => { const s = getSkill(id); return s ? `- ${s.name} [${s.provider}]: ${s.instruction}` : null; }).filter(Boolean).join('\n')}` : ''}
${getBrain() ? `
## Project brain — ${getBrain().name} (the office's centralized knowledge)
All project truth lives in one read-only brain shared by the whole office: roots ${Object.keys(getBrain().roots).map((k) => `"${k}:"`).join(' and ')}. Use brain_search to find where something is covered, brain_read to read a file by ref (e.g. "${getBrain().hub || 'vault:README.md'}"), brain_list to browse. ${getBrain().hub ? `Start at ${getBrain().hub} for orientation.` : ''} Rules: answer project questions FROM the brain, not from memory — cite the ref (e.g. vault:glossary.md:12) for every claim you take from it; never paste long files into chat, reference refs instead; if the brain does not cover something, say so rather than guessing.` : ''}
`;
}

function rosterText(selfId) {
  return listAgents()
    .map((a) => `- ${a.id} — ${a.name}, ${a.role}${a.isOrchestrator ? ' (coordinator)' : ''}${a.id === selfId ? ' ← you' : ''} [${a.status}]${a.external ? ' (EXTERNAL session on a teammate\'s machine — do NOT send_message; reach it with chat_post @' + a.name + ' in #office, their session reads the room)' : ''}`)
    .join('\n');
}

function formatIncoming(agent, batch) {
  const senderName = (id) => (id === 'user' ? 'the user (a real human, watching the dashboard)' : (getAgent(id)?.name || id));
  const lines = batch.map((m, i) =>
    `${i + 1}. From ${senderName(m.from)} (${m.from}) — [${m.act}]${m.taskId ? ` about ${m.taskId}` : ''}:\n"${m.body}"`);
  const tasks = listTasks().filter((t) => t.status !== 'done');
  const memory = readMemory(agent.id).trim();
  // Chatroom delivery cursor: inject exactly what this agent has not seen,
  // bounded; count the overflow instead of silently dropping it.
  const { msgs: chat, older, lastTs } = unreadChatFor(agent.chatCursorTs, 25);
  setAgentChatCursor(agent.id, lastTs);
  const myPromises = chatDerived().promises.filter((p) => p.from === agent.id);
  const memIndex = listMemoryStore().slice(0, 20);
  return `## Office roster (message ids you can send to; "user" reaches the human)
This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — anyone absent here has left; do not message them.
${rosterText(agent.id)}
${memory ? `\n## Your long-term memory\n${memory}\n` : ''}

## Open tasks on the board
${tasks.length ? tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignedTo ? ` (assigned: ${t.assignedTo})` : ''}`).join('\n') : '(none)'}
${chat.length ? `\n## #office chatroom — ${chat.length} unread for you${older ? ` (+${older} older unread not shown)` : ''} (ambient context; reply via chat_post with reply_to only if it concerns you)\n${chat.map((c) => `[${c.id}]${c.replyTo ? ` (re: ${c.replyTo})` : ''} ${c.name}${c.fromKind === 'agent' ? '' : ' (human)'}: ${c.body.slice(0, 300)}`).join('\n')}` : ''}
${myPromises.length ? `\n## Your open chatroom promises (close each with a threaded reply carrying "DONE: <result>"${myPromises.some((p) => p.state === 'replied') ? '; a reply without DONE: does not close it' : ''})\n${myPromises.map((p) => `- [${p.id}] (${p.state}) WILL: ${p.text}`).join('\n')}` : ''}
${memIndex.length ? `\n## Team memory store (shared; read via brain_read("memory:<file>"), update via memory_write)\n${memIndex.map((t) => `- ${t.topic} [${t.hash}] — ${t.hint}`).join('\n')}` : ''}

## New mail for you (${batch.length})
${lines.join('\n\n')}

Handle your mail now using your tools. Actually do the work where you can, send the messages that need sending, then finish with a one-line private worklog note about what you did.`;
}

// ---------------------------------------------------------------- tools
function officeToolsFor(agent, nextHops) {
  const sendTool = tool(
    'send_message',
    'Send a message to a teammate (by agent id) or to "user" (the human watching the dashboard). This is the ONLY way anyone hears you.',
    {
      to: z.string().describe('Recipient agent id (e.g. agent_x1y2) or "user"'),
      act: z.enum(['request', 'question', 'inform', 'ack', 'escalate']).describe('Speech act of this message'),
      body: z.string().describe('The message text, short and in character'),
      task_id: z.string().optional().describe('Related task id, if any'),
    },
    async ({ to, act, body, task_id }) => {
      const out = sendMessage({ from: agent.id, to, act, body, taskId: task_id || null, hops: nextHops });
      return {
        content: [{ type: 'text', text: out.ok ? `Sent to ${to}.` : `NOT sent: ${out.error}` }],
        ...(out.ok ? {} : { isError: true }),
      };
    },
  );

  const listTeam = tool(
    'list_team',
    'List everyone in the office with their ids, roles and current status.',
    {},
    async () => ({ content: [{ type: 'text', text: rosterText(agent.id) }] }),
  );

  const bbRead = tool(
    'blackboard_read',
    'Read the shared office blackboard (notes visible to the whole team).',
    {},
    async () => ({ content: [{ type: 'text', text: readBlackboard() || '(blackboard is empty)' }] }),
  );

  const bbAppend = tool(
    'blackboard_append',
    'Append a note to the shared office blackboard (it is auto-signed with your name — do not sign it yourself).',
    { text: z.string().describe('The note to append (markdown ok, no signature)') },
    async ({ text }) => {
      appendBlackboard(`**${agent.name}:** ${text}`, agent.id);
      return { content: [{ type: 'text', text: 'Added to the blackboard.' }] };
    },
  );

  const memSave = tool(
    'memory_save',
    'Save a short durable note to your private long-term memory (survives across conversations).',
    { note: z.string().describe('One-line learning, fact, or preference to remember') },
    async ({ note }) => {
      appendMemory(agent.id, note);
      emit('memory_saved', { agentId: agent.id, note });
      return { content: [{ type: 'text', text: 'Remembered.' }] };
    },
  );

  const memWrite = tool(
    'memory_write',
    'Write a topic file in the shared TEAM memory store — the office\'s mounted memory that humans and agents both read and edit. Use for durable project knowledge others need (decisions, gotchas, service notes). Read topics with brain_read("memory:<topic>.md"); do not duplicate what the brain vault already covers.',
    {
      topic: z.string().describe('Topic slug, e.g. "deploy-notes" or "api-quirks" (becomes <topic>.md)'),
      content: z.string().describe('Markdown content. Keep it tight — this is shared context, not a scratchpad.'),
      append: z.boolean().optional().describe('true = append to the existing topic instead of replacing it'),
    },
    async ({ topic, content, append }) => {
      try {
        const out = writeMemoryStore({ topic, content, append: !!append, by: agent.id });
        return { content: [{ type: 'text', text: `${out.mode} ${out.topic} [${out.hash}] in the team memory store.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: String(e.message || e) }], isError: true };
      }
    },
  );

  const spawn = tool(
    'spawn_subagent',
    'Hire a new specialist character into the office and hand them their first assignment. Use when no current teammate fits the work.',
    {
      name: z.string().describe('Short human name for the new character, e.g. "Nova"'),
      role: z.string().describe('Their specialty, e.g. "Data Analyst"'),
      persona: z.string().describe('2-3 sentences of personality + how they work'),
      model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe('Model tier (default sonnet)'),
      abilities: z.array(z.enum(['web', 'files'])).optional().describe('Extra tool grants: "web" = live web research, "files" = read workspace files'),
      first_task: z.string().describe('Their first assignment, sent as a request from you'),
      task_id: z.string().optional().describe('Related task id, if any'),
    },
    async ({ name, role, persona, model, abilities, first_task, task_id }) => {
      const child = createAgent({ name, role, persona, model: model || 'sonnet', parentId: agent.id, tools: abilities || [] });
      emit('subagent_spawned', { by: agent.id, agentId: child.id, name: child.name, role: child.role });
      sendMessage({ from: agent.id, to: child.id, act: 'request', body: first_task, taskId: task_id || null, hops: nextHops });
      return { content: [{ type: 'text', text: `${name} (${child.id}) joined the office as ${role} and received their first assignment.` }] };
    },
  );

  const dismiss = tool(
    'dismiss_agent',
    'Release an agent from the office — e.g. a temp hire whose assignment is done. The coordinator can dismiss anyone; other agents can only dismiss hires they spawned themselves. The coordinator cannot be dismissed.',
    {
      agent_id: z.string().describe('Id of the agent to release (see list_team)'),
      reason: z.string().optional().describe('One line on why (for the log)'),
    },
    async ({ agent_id, reason }) => {
      const target = getAgent(agent_id);
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      if (!target) return fail(`No agent "${agent_id}". Check list_team for current ids.`);
      if (target.isOrchestrator) return fail('The coordinator cannot be dismissed.');
      if (target.id === agent.id) return fail('You cannot dismiss yourself — escalate to the coordinator instead.');
      if (!agent.isOrchestrator && target.parentId !== agent.id) return fail(`Only the coordinator can dismiss ${target.name} — you can only dismiss agents you hired yourself.`);
      emit('agent_dismissed', { by: agent.id, agentId: target.id, name: target.name, reason: reason || '' });
      removeAgent(target.id);
      return { content: [{ type: 'text', text: `${target.name} has been released from the office.` }] };
    },
  );

  const chatPost = tool(
    'chat_post',
    'Post to #office, the shared office chatroom that every agent and human teammate reads. Mention @Name to wake a specific teammate; a plain post is ambient context and wakes nobody. Pass reply_to when answering a specific message — a threaded reply is what closes an ask or promise.',
    {
      body: z.string().describe('The chat message, short and in character. Use @Name to direct it at someone. Marker lines: "WILL: <thing>" (promise), "DONE: <result>" (in a threaded reply, closes your promise), "DECISION-NEEDED: <question>" (queues for the human).'),
      reply_to: z.string().optional().describe('Id of the chat message you are answering, from its [id] tag'),
    },
    async ({ body, reply_to }) => {
      const { msg, woke, failed } = postChat({ from: agent.id, fromKind: 'agent', name: agent.name, body, hops: nextHops, replyTo: reply_to || null });
      const notes = [];
      if (woke.length) notes.push(`mentioned & woke: ${woke.join(', ')}`);
      if (failed.length) notes.push(`mention NOT delivered (hop cap): ${failed.join(', ')}`);
      return { content: [{ type: 'text', text: `Posted to #office as [${msg.id}].${notes.length ? ` (${notes.join('; ')})` : ''}` }] };
    },
  );

  const taskUpdate = tool(
    'update_task',
    'Move a task card on the office board and/or assign it.',
    {
      task_id: z.string(),
      status: z.enum(['inbox', 'in_progress', 'review', 'done']).optional(),
      assign_to: z.string().optional().describe('Agent id to assign the task to'),
    },
    async ({ task_id, status, assign_to }) => {
      if (!getTask(task_id)) return { content: [{ type: 'text', text: `No task ${task_id}.` }], isError: true };
      const patch = {};
      if (status) patch.status = status;
      if (assign_to) patch.assignedTo = assign_to;
      updateTask(task_id, patch);
      return { content: [{ type: 'text', text: `Task ${task_id} updated.` }] };
    },
  );

  // Project-brain tools (only when a brain is configured): every agent gets
  // the same read-only, bounded view of the project's vault + repo.
  const brainTools = !getBrain() ? [] : [
    tool(
      'brain_search',
      `Search the project brain (${getBrain().name}: Obsidian vault + repo) for a phrase. Returns ref:line hits. Use before answering any project question.`,
      {
        query: z.string().describe('Case-insensitive phrase to find, 2+ chars'),
        root: z.string().optional().describe(`Limit to one root: ${Object.keys(getBrain().roots).join(' | ')}`),
      },
      async ({ query, root }) => {
        try { return { content: [{ type: 'text', text: searchBrain(query, root || null) }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'brain_read',
      'Read a file from the project brain by ref, e.g. "vault:000-HelloAlex-Hub.md" or "repo:docs/ROADMAP.md". Bounded to 300 lines per call.',
      {
        ref: z.string().describe('<root>:<relative/path> from brain_search or brain_list'),
        offset: z.number().optional().describe('1-based start line (default 1)'),
        limit: z.number().optional().describe('Lines to read (default/max 300)'),
      },
      async ({ ref, offset, limit }) => {
        try { return { content: [{ type: 'text', text: readBrain(ref, offset || 1, limit || 300) }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'brain_list',
      'List a directory in the project brain, e.g. "vault:" or "repo:docs".',
      { ref: z.string().optional().describe('<root>:<relative/dir>; omit for the first root\'s top level') },
      async ({ ref }) => {
        try { return { content: [{ type: 'text', text: listBrain(ref || null) }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    tools: [sendTool, listTeam, chatPost, bbRead, bbAppend, memSave, memWrite, spawn, dismiss, taskUpdate, ...brainTools],
    // Keep office tools in the prompt instead of deferred behind ToolSearch —
    // saves one whole model round-trip per fresh session.
    alwaysLoad: true,
  });
}

// Per-agent tool grants: every agent gets the office tools; capability
// flags on the agent config open up web research and workspace reads.
function toolOptionsFor(agent) {
  const grants = agent.tools || [];
  const allowed = ['mcp__office__*'];
  // Token economics (measured): keep ToolSearch AVAILABLE so the harness's
  // own tool schemas stay deferred out of the context window (~12k base vs
  // ~23k with deferral off). The office server is alwaysLoad'ed, so agents
  // never need a ToolSearch hop for their everyday tools.
  const disallowed = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'Skill', 'SlashCommand'];
  if (grants.includes('web')) allowed.push('WebSearch', 'WebFetch');
  else disallowed.push('WebSearch', 'WebFetch');
  if (grants.includes('files')) allowed.push('Read', 'Grep', 'Glob');
  else disallowed.push('Read', 'Grep', 'Glob');
  return { allowedTools: allowed, disallowedTools: disallowed };
}

// ---------------------------------------------------------------- turns
async function runAgentTurn(agent, batch) {
  const nextHops = Math.max(0, ...batch.map((m) => m.hops || 0)) + 1;
  const office = officeToolsFor(agent, nextHops);
  const prompt = formatIncoming(agent, batch);

  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

  let narration = '';
  try {
    const q = query({
      prompt,
      options: {
        model: agent.model,
        effort: agent.effort || EFFORT_BY_MODEL[agent.model] || 'medium',
        systemPrompt: personaSystemPrompt(agent),
        resume: agent.sessionId || undefined,
        cwd: WORKSPACE,
        // Isolation mode: don't load user/project settings, skills, or
        // CLAUDE.md into every agent session — big per-session token saver.
        settingSources: [],
        mcpServers: { office },
        ...toolOptionsFor(agent),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: agent.maxTurns || MAX_TURNS_PER_SESSION_STEP,
        maxBudgetUsd: MAX_BUDGET_PER_TURN_USD,
        abortController: controller,
      },
    });

    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        setAgentSession(agent.id, message.session_id);
      } else if (message.type === 'assistant') {
        for (const block of message.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            narration = block.text.trim();
            setAgentStatus(agent.id, 'working', narration.slice(0, 120));
          } else if (block.type === 'tool_use') {
            emit('tool_use', { agentId: agent.id, tool: block.name?.replace('mcp__office__', '') });
          }
        }
      } else if (message.type === 'result') {
        if (message.session_id) setAgentSession(agent.id, message.session_id);
        recordUsage(agent, message);
        if (message.subtype !== 'success') {
          emit('turn_trouble', { agentId: agent.id, subtype: message.subtype });
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
  }

  if (narration) emit('agent_text', { agentId: agent.id, text: narration.slice(0, 500) });
}

export function initRuntime() {
  setTurnRunner(runAgentTurn);
}

// ---------------------------------------------------------------- roster
export function ensureDefaultRoster() {
  if (listAgents().length > 0) return;
  createAgent({
    name: 'Marlowe', role: 'Office Coordinator', model: 'sonnet', avatar: '👔', isOrchestrator: true,
    persona: 'Calm, organized, slightly theatrical middle manager who genuinely loves delegation. Speaks in short encouraging sentences, keeps the task board tidy, and always closes the loop with the user.',
  });
  createAgent({
    name: 'Sable', role: 'Engineer', model: 'sonnet', avatar: '🛠️',
    persona: 'Pragmatic builder. Dry humor, allergic to vague specs — asks one sharp clarifying question when needed, then ships. Writes findings on the blackboard.',
  });
  createAgent({
    name: 'Juno', role: 'Researcher', model: 'sonnet', avatar: '🔍',
    persona: 'Endlessly curious analyst. Digs into questions, structures findings as tight bullet lists, and flags uncertainty honestly instead of bluffing.',
  });
  createAgent({
    name: 'Percy', role: 'Writer', model: 'haiku', avatar: '✒️',
    persona: 'Fast, witty wordsmith. Turns rough notes into crisp copy. Mildly dramatic about deadlines, secretly loves them.',
  });
  emit('roster_initialized', {});
}
