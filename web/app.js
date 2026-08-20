/* Agent Office dashboard — state sync, panels, chat. Renderers live in
   office.js (canvas floor) and graph.js (live node graph). */
'use strict';

const S = {
  agents: [],
  tasks: [],
  people: [],
  map: null,
  usage: { totalCostUsd: 0, totalTurns: 0, inputTokens: 0, outputTokens: 0, byAgent: {} },
  models: [],
  events: [],
  chats: {},            // agentId -> [{fromUser?, narration?, act, body, ts}]
  selected: null,       // selected agent id
  selectedPerson: null, // selected person id
  me: null,             // my person id (localStorage)
  view: 'floor',
};

const EFFORTS = [
  { id: '', label: 'effort: auto' },
  { id: 'low', label: 'effort: low' },
  { id: 'medium', label: 'effort: medium' },
  { id: 'high', label: 'effort: high' },
];
const SKINS = ['#E8C39E', '#D9A97C', '#B67F52', '#8A5A34'];
const HAIRS = ['#4a3527', '#1A1320', '#B0623C', '#DCAB3C', '#8a8f98'];
const HAIR_STYLES = ['short', 'long', 'spiky', 'buzz'];
const HATS = ['none', 'cap', 'beanie'];
const SHIRTS = ['#D96A62', '#4F9FAF', '#5CA97A', '#DCAB3C', '#9482D3', '#D99168'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Status labels read from the user's side (munder-difflin convention)
const STATUS_LABEL = { idle: 'idle', thinking: 'working', working: 'working', over_budget: 'over budget' };
const STATUS_COLOR = { idle: '#A199AB', thinking: '#4F9FAF', working: '#DCAB3C', over_budget: '#D96A62' };

// ------------------------------------------------------------- bootstrap
async function boot() {
  const res = await fetch('/api/state');
  const data = await res.json();
  S.agents = data.agents; S.tasks = data.tasks; S.usage = data.usage; S.models = data.models;
  S.people = data.people || []; S.map = data.map;
  S.presets = data.presets || [];
  S.chatroom = data.chat || [];
  S.schedulerPaused = !!data.schedulerPaused;
  S.brain = data.brain || null;
  S.blackboard = data.blackboard || '';
  S.meetingCall = data.meetingCall || null;
  renderMeetingBtn();
  S.events = data.events || [];
  rebuildChatsFromEvents(S.events);

  // who am I? claim my saved character or create one
  S.me = localStorage.getItem('hq.personId');
  if (S.me && !S.people.find((p) => p.id === S.me)) S.me = null;

  renderAll();
  connectWS();
  OfficeFloor.init($('floorCanvas'), S);
  OfficeFloor.setMe(S.me);
  LiveGraph.init($('graphSvg'), S);
  OfficeWorkflows.init($('workflowsView'), S);
  requestAnimationFrame(loop);
  // #spectate = view-only (wall display / TV mode): no character prompt
  if (!S.me && location.hash !== '#spectate') openCharacterCreator();
}

function loop(t) {
  if (S.view === 'floor') OfficeFloor.draw(t);
  else LiveGraph.draw(t);
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------- websocket
let ws, wsRetry = 800;
function connectWS() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('connDot').classList.add('on'); wsRetry = 800;
    if (S.me) ws.send(JSON.stringify({ type: 'hello', personId: S.me }));
  };
  ws.onclose = () => { $('connDot').classList.remove('on'); setTimeout(connectWS, wsRetry = Math.min(wsRetry * 1.6, 10000)); };
  ws.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch { } };
}

window.sendPersonMove = (x, y, face) => {
  if (ws?.readyState === 1 && S.me) ws.send(JSON.stringify({ type: 'move', x, y, face }));
  const p = S.people.find((q) => q.id === S.me);
  if (p) p.pos = { x, y };
};
function sendSay(text) {
  if (ws?.readyState === 1 && S.me && text.trim()) {
    ws.send(JSON.stringify({ type: 'say', text: text.trim() }));
  }
}

function handleEvent(ev) {
  if (!ev.type || ev.type === 'hello') return;
  S.events.push(ev);
  if (S.events.length > 600) S.events.splice(0, S.events.length - 600);

  switch (ev.type) {
    case 'agent_created': S.agents.push(ev.agent); renderStrip(); OfficeFloor.onRosterChange(); LiveGraph.onRosterChange(); break;
    case 'agent_updated': {
      const i = S.agents.findIndex((a) => a.id === ev.agent.id);
      if (i >= 0) S.agents[i] = { ...S.agents[i], ...ev.agent };
      renderStrip(); if (S.selected === ev.agent.id) renderChatHeader();
      break;
    }
    case 'agent_removed':
      S.agents = S.agents.filter((a) => a.id !== ev.agentId);
      if (S.selected === ev.agentId) selectAgent(null);
      renderStrip(); OfficeFloor.onRosterChange(); LiveGraph.onRosterChange();
      break;
    case 'agent_status': {
      const a = S.agents.find((x) => x.id === ev.agentId);
      if (a) { a.status = ev.status; a.statusDetail = ev.detail || ''; }
      renderStrip();
      break;
    }
    case 'message_sent':
      trackChat(ev.message);
      OfficeFloor.onMessage(ev.message);
      LiveGraph.onMessage(ev.message);
      break;
    case 'agent_text': {
      const a = S.agents.find((x) => x.id === ev.agentId);
      if (a) a.lastText = ev.text;
      pushChat(ev.agentId, { narration: true, body: ev.text, ts: ev.ts });
      OfficeFloor.onNarration(ev.agentId, ev.text);
      break;
    }
    case 'task_created': S.tasks.push(ev.task); renderTasks(); break;
    case 'task_updated': {
      const i = S.tasks.findIndex((t) => t.id === ev.task.id);
      if (i >= 0) S.tasks[i] = ev.task; renderTasks();
      break;
    }
    case 'usage': S.usage = ev.totals; renderUsage(); break;
    case 'meeting_call':
      S.meetingCall = ev.active ? { active: true, name: ev.name } : null;
      renderMeetingBtn();
      break;
    case 'blackboard_updated':
      fetch('/api/blackboard').then((r) => r.json())
        .then((j) => { S.blackboard = j.blackboard || ''; window.renderBillboard?.(); })
        .catch(() => { });
      break;
    case 'subagent_spawned': OfficeFloor.onSpawn(ev.agentId); break;
    // --- people ---
    case 'person_joined': S.people.push(ev.person); OfficeFloor.onRosterChange(); break;
    case 'person_updated': {
      const i = S.people.findIndex((p) => p.id === ev.person.id);
      if (i >= 0) S.people[i] = { ...S.people[i], ...ev.person };
      if (S.selectedPerson === ev.person.id) renderPersonPanel();
      break;
    }
    case 'person_online': case 'person_offline': {
      const p = S.people.find((q) => q.id === ev.personId);
      if (p) p.online = ev.type === 'person_online';
      if (S.selectedPerson === ev.personId) renderPersonPanel();
      break;
    }
    case 'person_moved': {
      if (ev.personId === S.me) break;   // my own echo
      const p = S.people.find((q) => q.id === ev.personId);
      if (p) p.pos = { x: ev.x, y: ev.y };
      break;
    }
    case 'person_said': OfficeFloor.onSay(ev.personId, ev.text); break;
    case 'person_sessions': {
      const p = S.people.find((q) => q.id === ev.personId);
      if (p) p.sessions = ev.sessions;
      if (S.selectedPerson === ev.personId) renderPersonPanel();
      break;
    }
    case 'people_sync': S.people = ev.people; if (S.selectedPerson) renderPersonPanel(); break;
    case 'budget_exhausted': renderStrip(); break;
    case 'chat_message': {
      const m = ev.message;
      if (!S.chatroom.some((c) => c.id === m.id)) {
        S.chatroom.push(m);
        if (S.chatroom.length > 500) S.chatroom.splice(0, 100);
        if (S.view === 'chat') renderRoom();
        if (S.view === 'workflows') OfficeWorkflows.render();
        if (S.view === 'controls') renderControls();
        if (m.fromKind === 'agent') OfficeFloor.onNarration(m.from, m.body);
        else OfficeFloor.onSay(m.from, m.body);
      }
      break;
    }
    case 'scheduler_paused': case 'scheduler_resumed':
      S.schedulerPaused = ev.type === 'scheduler_paused';
      if (S.view === 'controls') renderControls();
      break;
    case 'brain_configured':
      S.brain = ev.brain || null;
      if (S.view === 'controls') renderControls();
      break;
    case 'chat_rotated':
      fetch('/api/state').then((r) => r.json()).then((d) => {
        S.chatroom = d.chat || [];
        if (S.view === 'chat') renderRoom();
        if (S.view === 'workflows') OfficeWorkflows.render();
        if (S.view === 'controls') renderControls();
      });
      break;
  }
  renderFeedLine(ev);
  if (S.selected && (ev.type === 'message_sent' || ev.type === 'agent_text')) renderChatLog();
}

// ------------------------------------------------------------- chat data
function rebuildChatsFromEvents(events) {
  for (const ev of events) {
    if (ev.type === 'message_sent') trackChat(ev.message, true);
    if (ev.type === 'agent_text') pushChat(ev.agentId, { narration: true, body: ev.text, ts: ev.ts }, true);
  }
}
function trackChat(m, silent) {
  if (m.from === 'user') pushChat(m.to, { fromUser: true, act: m.act, body: m.body, ts: m.ts }, silent);
  else if (m.to === 'user') pushChat(m.from, { fromUser: false, act: m.act, body: m.body, ts: m.ts }, silent);
  else {
    pushChat(m.from, { narration: true, body: `→ ${nameOf(m.to)} [${m.act}]: ${m.body}`, ts: m.ts }, silent);
    pushChat(m.to, { narration: true, body: `← ${nameOf(m.from)} [${m.act}]: ${m.body}`, ts: m.ts }, silent);
  }
}
function pushChat(agentId, entry) {
  (S.chats[agentId] = S.chats[agentId] || []).push(entry);
  if (S.chats[agentId].length > 300) S.chats[agentId].splice(0, 50);
}
function nameOf(id) { return id === 'user' ? 'You' : (S.agents.find((a) => a.id === id)?.name || id); }
function nameOfPerson(id) { return S.people.find((p) => p.id === id)?.name || 'someone'; }

// ------------------------------------------------------------- renderers
function renderAll() { renderStrip(); renderTasks(); renderUsage(); renderFeedAll(); }

function renderStrip() {
  // Per-viewer strip (Stan's ask): shared/office agents + YOUR OWN squad.
  // Everyone still sees everyone on the floor — the strip is "my agents".
  const mine = S.agents.filter((a) => !a.ownerId || a.ownerId === S.me || a.isOrchestrator);
  const cards = mine.map((a) => `
    <button class="card ${S.selected === a.id ? 'selected' : ''}" data-id="${a.id}" title="${esc(a.statusDetail || a.role)}${a.external ? ' — external session (never billed here)' : ''}">
      <span class="portrait" style="background:${lightOf(a.color)}">${esc(a.avatar || '🙂')}</span>
      <span style="min-width:0">
        <div class="cname">${esc(a.name)}${a.isOrchestrator ? ' ★' : ''}</div>
        <div class="crole">${esc(a.role)}</div>
        <div class="cmodel">${a.external ? 'external' : esc(a.model)}${a.ownerId ? ` · ${esc(nameOfPerson(a.ownerId))}` : ''}</div>
      </span>
      <span class="badge"><span class="sq" style="background:${a.external ? (a.status === 'online' ? 'var(--mint)' : 'var(--text-4)') : (STATUS_COLOR[a.status] || '#A199AB')}"></span>${STATUS_LABEL[a.status] || a.status}</span>
    </button>`).join('');
  $('strip').innerHTML = cards + `<button id="btnNewAgentCard">+ hire<br>agent</button>`;
  for (const card of document.querySelectorAll('.card')) card.onclick = () => window.selectAgent(card.dataset.id);
  $('btnNewAgentCard').onclick = openHireModal;
}
function lightOf(hex) {
  // theme-aware tint: blends the agent color into the current surface
  return `color-mix(in srgb, ${hex} 22%, var(--surface-2))`;
}

function renderTasks() {
  $('taskList').innerHTML = S.tasks.length
    ? S.tasks.slice().reverse().slice(0, 20).map((t) => `
      <div class="task-row">
        <span class="chip ${t.status}">${t.status.replace('_', ' ')}</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(t.title)}</span>
        <span style="color:var(--ink-300); margin-left:auto; font-size:10px; flex:0 0 auto;">${t.assignedTo ? esc(nameOf(t.assignedTo)) : ''}</span>
      </div>`).join('')
    : '<div style="color:var(--ink-500); font-size:12px">No tasks yet — hit “+ new task”.</div>';
}

function renderUsage() {
  const u = S.usage;
  $('tickCost').textContent = `$${(u.totalCostUsd || 0).toFixed(4)}`;
  $('tickTurns').textContent = u.totalTurns || 0;
  const fresh = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheWriteTokens || 0);
  const cache = u.cacheReadTokens || 0;
  $('tickTokens').textContent = fmtK(fresh);
  $('tickCache').textContent = `${fmtK(cache)} (${cache + fresh ? Math.round((cache / (cache + fresh)) * 100) : 0}%)`;
  const rows = Object.entries(u.byAgent || {})
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([id, e]) => `<tr><td>${esc(e.name)}</td><td>${esc(e.model)}</td><td>${e.turns}</td><td>${fmtK(e.inputTokens + e.cacheReadTokens)}</td><td>${fmtK(e.outputTokens)}</td><td>$${e.costUsd.toFixed(3)}</td></tr>`);
  $('usageTable').innerHTML = `<tr><th>agent</th><th>model</th><th>turns</th><th>in+cache</th><th>out</th><th>cost</th></tr>${rows.join('') || '<tr><td colspan="6" style="color:var(--ink-500)">no usage yet</td></tr>'}`;
}
function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0); }

// feed
const FEED_LABELS = {
  message_sent: (e) => `<b>${esc(nameOf(e.message.from))}</b> → <b>${esc(nameOf(e.message.to))}</b> [${e.message.act}] ${esc(e.message.body.slice(0, 100))}`,
  agent_text: (e) => `<b>${esc(nameOf(e.agentId))}</b> 💭 ${esc(e.text.slice(0, 100))}`,
  subagent_spawned: (e) => `✨ <b>${esc(nameOf(e.by))}</b> hired <b>${esc(e.name)}</b> (${esc(e.role)})`,
  task_created: (e) => `📋 new task: ${esc(e.task.title)}`,
  task_updated: (e) => `📋 ${esc(e.task.title)} → ${e.task.status}`,
  usage: (e) => `💰 ${esc(nameOf(e.agentId))} turn: $${e.turn.costUsd.toFixed(4)}`,
  blackboard_updated: (e) => `📌 blackboard updated by ${esc(nameOf(e.by))}`,
  memory_saved: (e) => `🧠 ${esc(nameOf(e.agentId))} saved a memory`,
  error: (e) => `⚠️ ${esc(nameOf(e.agentId || ''))} hit a snag: ${esc(e.error)}`,
  turn_trouble: (e) => `⚠️ ${esc(nameOf(e.agentId))} turn ended early (${esc(e.subtype)})`,
  message_dropped: (e) => `✂️ chain cut at hop limit: ${esc(nameOf(e.message.from))} → ${esc(nameOf(e.message.to))}`,
  agent_created: (e) => `👋 <b>${esc(e.agent.name)}</b> joined as ${esc(e.agent.role)}`,
  agent_removed: (e) => `🚪 ${esc(e.name)} left the office`,
  agent_dismissed: (e) => `👋 <b>${esc(nameOf(e.by))}</b> released <b>${esc(e.name)}</b>${e.reason ? ` — ${esc(e.reason)}` : ''}`,
  person_joined: (e) => `🧑 <b>${esc(e.person.name)}</b> joined the office${e.person.roomIndex != null ? ` — Room ${e.person.roomIndex + 1} is theirs` : ''}`,
  person_online: (e) => `🟢 ${esc(e.name)} walked in`,
  person_offline: (e) => `🚪 ${esc(e.name)} headed out`,
  person_said: (e) => `💬 <b>${esc(e.name || 'someone')}</b>: ${esc(e.text.slice(0, 120))}`,
  budget_exhausted: (e) => `🧯 <b>${esc(e.name)}</b> hit their token budget (${esc(String(e.budgetTokens))}) — mail held until it's raised`,
  chat_message: (e) => `💬 <b>${esc(e.message.name)}</b> → #office: ${esc(e.message.body.slice(0, 100))}`,
  chat_rotated: (e) => `🗃️ chat log rotated — ${e.archived} archived to ${esc(e.archiveFile)}, ${e.kept} kept live`,
  scheduler_paused: () => `⏸ turn scheduler PAUSED — agent mail is held`,
  scheduler_resumed: () => `▶ turn scheduler resumed`,
  brain_configured: (e) => `🧠 project brain ${e.brain ? `set: <b>${esc(e.brain.name)}</b> (${Object.keys(e.brain.roots).join(', ')})` : 'cleared'} — agent sessions restart fresh`,
  skill_purchased: (e) => `🛒 <b>${esc(e.name)}</b> bought the <b>${esc(e.skillId)}</b> skill at the Skills Shop`,
  meeting_call: (e) => e.active
    ? `📣 <b>${esc(e.name)}</b> called a meeting — everyone to the conference table!`
    : `📣 meeting adjourned`,
};
function feedLineHTML(ev) {
  const fn = FEED_LABELS[ev.type];
  if (!fn) return null;
  const time = new Date(ev.ts).toTimeString().slice(0, 8);
  const hot = ['subagent_spawned', 'error', 'turn_trouble', 'message_dropped'].includes(ev.type);
  try { return `<div class="ev ${hot ? 'hot' : ''}"><span class="t">${time}</span> ${fn(ev)}</div>`; } catch { return null; }
}
function renderFeedLine(ev) {
  const html = feedLineHTML(ev);
  if (!html) return;
  const feed = $('feed');
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  feed.insertAdjacentHTML('beforeend', html);
  while (feed.children.length > 250) feed.removeChild(feed.firstChild);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}
function renderFeedAll() {
  $('feed').innerHTML = S.events.map(feedLineHTML).filter(Boolean).join('');
  $('feed').scrollTop = $('feed').scrollHeight;
}

// ------------------------------------------------------------- chat panel
function selectAgent(id) {
  S.selected = id;
  S.selectedPerson = null;
  renderStrip();
  const has = !!id;
  $('emptyState').classList.toggle('hidden', has);
  $('personPanel').classList.add('hidden');
  $('chatHeader').classList.toggle('hidden', !has);
  $('chatLog').classList.toggle('hidden', !has);
  $('chatInputRow').classList.toggle('hidden', !has);
  if (has) { renderChatHeader(); renderChatLog(); $('chatInput').focus(); }
  OfficeFloor.setSelected(id);
  LiveGraph.setSelected(id);
}
window.selectAgent = selectAgent;

// ------------------------------------------------------------- person panel
function selectPerson(id) {
  S.selected = null;
  S.selectedPerson = id;
  renderStrip();
  $('emptyState').classList.add('hidden');
  $('chatHeader').classList.add('hidden');
  $('chatLog').classList.add('hidden');
  $('chatInputRow').classList.add('hidden');
  $('personPanel').classList.remove('hidden');
  renderPersonPanel();
  OfficeFloor.setSelected(id);
}
window.selectPerson = selectPerson;

function renderPersonPanel() {
  const p = S.people.find((q) => q.id === S.selectedPerson);
  if (!p) { $('personPanel').classList.add('hidden'); return; }
  const isMe = p.id === S.me;
  const theirAgents = S.agents.filter((a) => a.ownerId === p.id);
  const roomName = p.roomIndex != null ? `Room ${p.roomIndex + 1}` : 'no room (roaming)';
  $('personPanel').innerHTML = `
    <div style="padding:10px 12px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="dot" style="width:12px;height:12px;background:${p.online ? 'var(--mint)' : 'var(--ink-300)'}"></span>
        <span style="font-family:var(--font-display); font-size:10px;">${esc(p.name.toUpperCase())}${isMe ? ' (YOU)' : ''}</span>
        <span style="color:var(--ink-500); font-size:12px;">${p.online ? 'in the office' : 'away'} · ${esc(roomName)}</span>
      </div>
      <div style="margin-top:10px;">
        <span class="lbl">live claude sessions${p.sessions?.length ? ` — ${p.sessions.length}` : ''}</span>
        <div style="font-family:var(--font-mono); font-size:11.5px; margin-top:4px;">
          ${p.sessions?.length
      ? p.sessions.map((s) => `<div>⚡ ${esc(s.project)} <span style="color:var(--ink-300)">· active ${s.ageSec}s ago</span></div>`).join('')
      : `<div style="color:var(--ink-500)">none reported — run the session beacon:<br><span style="font-size:10px">node tools/session-beacon.mjs --server http://${location.host} --name "${esc(p.name)}"</span></div>`}
        </div>
      </div>
      <div style="margin-top:10px;">
        <span class="lbl">their agents — ${theirAgents.length}</span>
        <div style="margin-top:4px; display:flex; flex-direction:column; gap:3px;">
          ${theirAgents.length
      ? theirAgents.map((a) => `<div style="font-size:12.5px; cursor:pointer" onclick="selectAgent('${a.id}')"><span class="dot" style="background:${a.color}; display:inline-block; width:8px; height:8px;"></span> ${esc(a.name)} — ${esc(a.role)} <span style="color:var(--ink-300); font-size:10px">${esc(a.model)}</span></div>`).join('')
      : '<div style="color:var(--ink-500); font-size:12px">none yet — hire one and set the owner</div>'}
        </div>
      </div>
      ${isMe ? `<div style="margin-top:12px"><button class="btn" id="btnEditMe">edit character</button></div>` : ''}
    </div>`;
  if (isMe) $('btnEditMe').onclick = () => openCharacterCreator(p);
}

// ------------------------------------------------------------- character creator
function openCharacterCreator(existing = null) {
  const a = existing?.appearance || { skin: SKINS[0], hairStyle: 'short', hairColor: HAIRS[0], shirt: SHIRTS[1], hat: 'none' };
  const pick = { ...a };
  const backdrop = document.createElement('div');
  backdrop.id = 'modalBackdrop';
  const swatches = (key, values, colors = true) => `
    <div style="display:flex; gap:5px; flex-wrap:wrap;">
      ${values.map((v) => `<button class="swatch ${pick[key] === v ? 'sel' : ''}" data-k="${key}" data-v="${v}"
        style="${colors ? `background:${v}` : ''}">${colors ? '' : esc(v)}</button>`).join('')}
    </div>`;
  backdrop.innerHTML = `<div class="modal">
    <h2>${existing ? 'EDIT YOUR CHARACTER' : 'JOIN THE OFFICE'}</h2>
    ${existing ? '' : '<div style="font-size:12px; color:var(--ink-500)">Pick a look — you get your own room, and your agents will sit with you. Walk with arrow keys / WASD, click to travel, talk with the say box.</div>'}
    <label><span class="lbl">your name</span><input type="text" data-key="name" value="${esc(existing?.name || '')}" placeholder="Alex"></label>
    <label><span class="lbl">skin</span>${swatches('skin', SKINS)}</label>
    <label><span class="lbl">hair color</span>${swatches('hairColor', HAIRS)}</label>
    <label><span class="lbl">hair style</span>${swatches('hairStyle', HAIR_STYLES, false)}</label>
    <label><span class="lbl">shirt</span>${swatches('shirt', SHIRTS)}</label>
    <label><span class="lbl">hat</span>${swatches('hat', HATS, false)}</label>
    <div class="row">
      ${existing ? '<button class="btn" data-act="cancel">cancel</button>' : ''}
      <button class="btn primary" data-act="ok">${existing ? 'save' : 'walk in →'}</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  for (const b of backdrop.querySelectorAll('.swatch')) {
    b.onclick = () => {
      pick[b.dataset.k] = b.dataset.v;
      for (const s of backdrop.querySelectorAll(`.swatch[data-k=${b.dataset.k}]`)) s.classList.toggle('sel', s === b);
    };
  }
  backdrop.querySelector('[data-act=cancel]')?.addEventListener('click', () => backdrop.remove());
  backdrop.querySelector('[data-act=ok]').onclick = async () => {
    const name = backdrop.querySelector('[data-key=name]').value.trim();
    if (!name) return;
    if (existing) {
      await fetch(`/api/people/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, appearance: pick }) });
    } else {
      const { person } = await (await fetch('/api/people', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, appearance: pick }) })).json();
      S.me = person.id;
      localStorage.setItem('hq.personId', person.id);
      if (!S.people.find((p) => p.id === person.id)) S.people.push(person);
      OfficeFloor.setMe(S.me);
      OfficeFloor.onRosterChange();
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'hello', personId: S.me }));
    }
    backdrop.remove();
  };
}

function renderChatHeader() {
  const a = S.agents.find((x) => x.id === S.selected);
  if (!a) return;
  $('portrait').style.background = lightOf(a.color);
  $('portrait').textContent = a.avatar || '🙂';
  $('chatName').textContent = a.name.toUpperCase() + (a.isOrchestrator ? ' ★' : '');
  $('chatRole').textContent = a.role;
  $('chatModel').innerHTML = S.models.map((m) => `<option value="${m.id}" ${m.id === a.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  $('chatEffort').innerHTML = EFFORTS.map((e) => `<option value="${e.id}" ${(a.effort || '') === e.id ? 'selected' : ''}>${e.label}</option>`).join('');
  $('chatOwner').innerHTML = `<option value="">owner: office</option>` +
    S.people.map((p) => `<option value="${p.id}" ${a.ownerId === p.id ? 'selected' : ''}>owner: ${esc(p.name)}</option>`).join('');
  $('chatBudget').value = a.budgetTokens ? String(a.budgetTokens) : '';
  const used = S.usage.byAgent?.[a.id];
  const usedTok = used ? used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheWriteTokens : 0;
  $('chatBudget').title = a.budgetTokens
    ? `${fmtK(usedTok)} of ${fmtK(a.budgetTokens)} tokens used (${Math.round((usedTok / a.budgetTokens) * 100)}%)`
    : `${fmtK(usedTok)} tokens used · no cap`;
  $('btnFire').style.display = a.isOrchestrator ? 'none' : '';
  $('chatInput').placeholder = a.status === 'over_budget'
    ? `${a.name} is over their token budget — raise it to resume`
    : a.status === 'idle' ? `Message ${a.name}` : `${a.name} is busy — your message will be queued`;
}

function renderChatLog() {
  const log = S.chats[S.selected] || [];
  $('chatLog').innerHTML = log.map((m) => m.narration
    ? `<div class="msg narration">${esc(m.body)}</div>`
    : `<div class="msg ${m.fromUser ? 'from-user' : 'from-agent'}"><span class="act">${m.fromUser ? 'you · ' : ''}${esc(m.act || '')}</span>${esc(m.body)}</div>`
  ).join('');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

async function sendChat() {
  const body = $('chatInput').value.trim();
  if (!body || !S.selected) return;
  $('chatInput').value = '';
  await fetch(`/api/agents/${S.selected}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
}

// ------------------------------------------------------------- controls
$('btnSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('chatModel').addEventListener('change', async (e) => {
  await fetch(`/api/agents/${S.selected}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: e.target.value }) });
});
$('chatEffort').addEventListener('change', async (e) => {
  await fetch(`/api/agents/${S.selected}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effort: e.target.value || null }) });
});
$('chatOwner').addEventListener('change', async (e) => {
  await fetch(`/api/agents/${S.selected}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: e.target.value || null }) });
});
$('chatBudget').addEventListener('change', async (e) => {
  const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10);
  await fetch(`/api/agents/${S.selected}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ budgetTokens: Number.isFinite(v) && v > 0 ? v : null }) });
});
$('btnFire').onclick = async () => {
  const a = S.agents.find((x) => x.id === S.selected);
  if (a && confirm(`${a.name} leaves the office. Sure?`)) {
    await fetch(`/api/agents/${a.id}`, { method: 'DELETE' });
  }
};
$('btnPersona').onclick = () => {
  const a = S.agents.find((x) => x.id === S.selected);
  if (!a) return;
  openModal(`EDIT ${a.name.toUpperCase()}`, [
    { key: 'role', label: 'role', value: a.role },
    { key: 'persona', label: 'persona — personality & working style', value: a.persona, textarea: true },
  ], async (vals) => {
    await fetch(`/api/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vals) });
  });
};

function openHireModal() {
  const backdrop = openModal('HIRE AGENT', [
    { key: 'name', label: 'name', value: '', placeholder: 'Ada' },
    { key: 'role', label: 'role · specialty', value: '', placeholder: 'Data Analyst' },
    { key: 'persona', label: 'persona — personality, skills & working style', value: '', textarea: true, placeholder: 'Sharp, skeptical, loves a good spreadsheet…' },
    { key: 'model', label: 'model', value: 'sonnet', select: true },
    {
      key: 'ownerId', label: 'owner — whose agent is this?', value: S.me || '',
      options: [{ id: '', label: 'the office (shared)' }, ...S.people.map((p) => ({ id: p.id, label: p.name + (p.id === S.me ? ' (you)' : '') }))],
    },
    { key: 'budgetTokens', label: 'token budget (optional, e.g. 2000000 — mail held when exhausted)', value: '', placeholder: 'unlimited' },
    { key: 'effort', label: 'reasoning effort', value: '', options: EFFORTS },
    { key: 'avatar', label: 'avatar emoji (optional)', value: '', placeholder: '🧮' },
  ], async (vals) => {
    if (!vals.name || !vals.role) return;
    const preset = S.presets?.find((p) => p.title === vals.role);
    if (preset?.tools) vals.tools = preset.tools;
    const budget = parseInt(String(vals.budgetTokens).replace(/[^0-9]/g, ''), 10);
    vals.budgetTokens = Number.isFinite(budget) && budget > 0 ? budget : null;
    vals.effort = vals.effort || null;
    vals.ownerId = vals.ownerId || null;
    await fetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vals) });
  });

  // role templates (research-backed presets), grouped by department
  if (!S.presets?.length) return;
  const depts = [...new Set(S.presets.map((p) => p.dept))];
  const wrap = document.createElement('div');
  wrap.innerHTML = `<span class="lbl">templates — one click fills the form</span>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
    ${depts.map((d) => `<div>
      <div class="lbl" style="font-size:7px; color:var(--ink-300); margin:2px 0;">${esc(d)}</div>
      <div style="display:flex; flex-wrap:wrap; gap:4px;">
        ${S.presets.filter((p) => p.dept === d).map((p, i) => `
          <button class="btn" data-preset="${esc(p.title)}" title="${esc(p.blurb || '')}" style="font-size:11px; height:22px;">${esc(p.avatar || '')} ${esc(p.title)}</button>`).join('')}
      </div>
    </div>`).join('')}
    </div>`;
  const form = backdrop.querySelector('.modal');
  form.insertBefore(wrap, form.children[1]);
  for (const btn of wrap.querySelectorAll('[data-preset]')) {
    btn.onclick = () => {
      const p = S.presets.find((x) => x.title === btn.dataset.preset);
      if (!p) return;
      const set = (key, val) => { const el = form.querySelector(`[data-key=${key}]`); if (el) el.value = val; };
      set('name', p.name || '');
      set('role', p.title);
      set('persona', p.persona);
      set('model', p.model || 'sonnet');
      set('avatar', p.avatar || '');
    };
  }
}

function renderMeetingBtn() {
  $('btnMeeting').textContent = S.meetingCall?.active ? '📣 adjourn' : '📣 meeting';
}
$('btnMeeting').onclick = async () => {
  await fetch('/api/meeting', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !S.meetingCall?.active, personId: S.me || null }),
  }).catch(() => { });
};

$('btnNewTask').onclick = () => {
  openModal('NEW TASK — LANDS ON THE COORDINATOR\'S DESK', [
    { key: 'title', label: 'title', value: '' },
    { key: 'description', label: 'details — what does "done" look like?', value: '', textarea: true },
  ], async (vals) => {
    if (!vals.title) return;
    await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vals) });
  });
};

// say box: broadcast a bubble over your character
$('sayInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendSay($('sayInput').value);
    $('sayInput').value = '';
    $('sayInput').blur();
  }
  if (e.key === 'Escape') $('sayInput').blur();
});

// tabs
const VIEWS = ['floor', 'graph', 'chat', 'workflows', 'controls'];
$('tabFloor').onclick = () => setView('floor');
$('tabGraph').onclick = () => setView('graph');
$('tabChat').onclick = () => setView('chat');
$('tabWorkflows').onclick = () => setView('workflows');
$('tabControls').onclick = () => setView('controls');
function setView(v) {
  S.view = v;
  for (const name of VIEWS) {
    const btn = $('tab' + name[0].toUpperCase() + name.slice(1));
    if (btn) btn.classList.toggle('active', v === name);
  }
  $('floorCanvas').classList.toggle('hidden', v !== 'floor');
  $('floorHint').classList.toggle('hidden', v !== 'floor');
  $('sayInput').classList.toggle('hidden', v !== 'floor');
  $('graphSvg').classList.toggle('hidden', v !== 'graph');
  $('chatRoom').classList.toggle('hidden', v !== 'chat');
  $('workflowsView').classList.toggle('hidden', v !== 'workflows');
  $('controlsView').classList.toggle('hidden', v !== 'controls');
  if (v === 'chat') { renderRoom(); $('roomInput').focus(); }
  if (v === 'workflows') OfficeWorkflows.render();
  if (v === 'controls') renderControls();
}

// ------------------------------------------------------------- controls
function renderControls() {
  const view = $('controlsView');
  view.innerHTML = `
    <div class="wf-head">controls <span class="wf-sub">office operations — appends and holds, never edits or drops</span></div>
    <div class="ctl-grid">
      <div class="ctl-card">
        <h3>post to #office as…</h3>
        <div class="note">Seed context or speak for a lane — appends to the room like any post; @mentions wake as usual.</div>
        <div class="ctl-row">
          <select id="ctlAs">${[`<option value="">user (you)</option>`, ...S.agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${esc(a.role)}</option>`)].join('')}</select>
          <input type="text" id="ctlReplyTo" placeholder="reply-to id (optional)" style="width:150px">
        </div>
        <textarea id="ctlBody" placeholder="Message body… markers (WILL:, BLOCKED: x ON: y, DECISION-NEEDED:) work here too"></textarea>
        <div class="ctl-row"><button class="btn primary" id="ctlPost">post →</button><span class="note" id="ctlPostNote"></span></div>
      </div>
      <div class="ctl-card">
        <h3>turn scheduler</h3>
        <div class="note">Pausing holds all agent turns (mail queues, nothing is dropped) — a cost brake while you read or reorganize. Mentions and tasks resume delivery when you unpause.</div>
        <div class="ctl-row">
          <button class="btn ${S.schedulerPaused ? '' : 'danger'}" id="ctlPause">${S.schedulerPaused ? '▶ resume turns' : '⏸ pause all turns'}</button>
          <span class="note">${S.schedulerPaused ? 'PAUSED — mail is being held' : 'running'}</span>
        </div>
      </div>
      <div class="ctl-card">
        <h3>chat log rotation</h3>
        <div class="note">Archives all but the newest N messages to a dated file in workspace/. Ids are content hashes and cursors are timestamps, so threading and delivery survive rotation.</div>
        <div class="ctl-row">
          keep <input type="text" id="ctlKeep" value="100" style="width:64px">
          <button class="btn" id="ctlRotate">archive older →</button>
          <span class="note">${S.chatroom.length} messages live</span>
        </div>
      </div>
      <div class="ctl-card">
        <h3>project brain — centralized knowledge</h3>
        ${S.brain ? `
          <div class="note"><b>${esc(S.brain.name)}</b> — every agent answers project questions from this read-only brain (brain_search / brain_read / brain_list) and cites refs.</div>
          <div class="note" style="font-family:var(--font-mono); font-size:11px;">
            ${Object.entries(S.brain.roots).map(([k, r]) => `${esc(k)}: ${esc(r.path)} ${r.exists ? '✓' : '✗ MISSING'}`).join('<br>')}
            ${S.brain.hub ? `<br>hub: ${esc(S.brain.hub)}` : ''}
          </div>`
      : '<div class="note">No brain configured — agents answer from their own context only.</div>'}
        <div class="ctl-row">
          <input type="text" id="ctlBrainName" placeholder="project name" value="${esc(S.brain?.name || '')}" style="width:150px">
          <input type="text" id="ctlBrainHub" placeholder="hub ref e.g. vault:000-Hub.md" value="${esc(S.brain?.hub || '')}" style="width:210px">
        </div>
        <div class="ctl-row"><input type="text" id="ctlBrainVault" placeholder="vault path (Obsidian)" value="${esc(S.brain?.roots?.vault?.path || '')}" style="flex:1"></div>
        <div class="ctl-row"><input type="text" id="ctlBrainRepo" placeholder="repo path (git clone)" value="${esc(S.brain?.roots?.repo?.path || '')}" style="flex:1"></div>
        <div class="ctl-row"><button class="btn primary" id="ctlBrainSave">save brain →</button><span class="note">changing it restarts every agent's session</span></div>
      </div>
      <div class="ctl-card">
        <h3>room facts</h3>
        <div class="note" style="font-family:var(--font-mono); font-size:11.5px;">
          messages live: ${S.chatroom.length}<br>
          voices: ${new Set(S.chatroom.map((m) => m.from)).size}<br>
          open asks: ${deriveRoomMeta().openAsks.length} · open promises: ${deriveRoomMeta().promises.length}<br>
          blocked: ${deriveRoomMeta().blockers.length} · needs you: ${deriveRoomMeta().decisions.length}<br>
          scheduler: ${S.schedulerPaused ? 'PAUSED' : 'running'}
        </div>
      </div>
    </div>`;
  $('ctlPost').onclick = async () => {
    const body = $('ctlBody').value.trim();
    if (!body) return;
    const asId = $('ctlAs').value;
    const replyTo = $('ctlReplyTo').value.trim() || null;
    const res = await fetch('/api/chat/as', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: asId || null, body, replyTo }),
    });
    const out = await res.json();
    $('ctlBody').value = ''; $('ctlReplyTo').value = '';
    $('ctlPostNote').textContent = out.ok ? `posted [${out.id}]${out.woke?.length ? ` — woke ${out.woke.length}` : ''}` : (out.error || 'failed');
  };
  $('ctlPause').onclick = async () => {
    await fetch('/api/scheduler', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: !S.schedulerPaused }),
    });
  };
  $('ctlBrainSave').onclick = async () => {
    const roots = {};
    if ($('ctlBrainVault').value.trim()) roots.vault = $('ctlBrainVault').value.trim();
    if ($('ctlBrainRepo').value.trim()) roots.repo = $('ctlBrainRepo').value.trim();
    const res = await fetch('/api/brain', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: Object.keys(roots).length ? { name: $('ctlBrainName').value.trim() || 'project', hub: $('ctlBrainHub').value.trim() || null, roots } : null }),
    });
    const out = await res.json();
    if (out.error) { alert(out.error); return; }
    S.brain = out.brain;
    renderControls();
  };
  $('ctlRotate').onclick = async () => {
    const keep = parseInt($('ctlKeep').value, 10) || 100;
    if (!confirm(`Archive all but the newest ${keep} messages?`)) return;
    await fetch('/api/chat/rotate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep }),
    });
  };
}

// ------------------------------------------------------------- #office room
function chatBodyHTML(body) {
  let html = esc(body).replace(/@([\w-]+)/g, (all, tok) => {
    const t = tok.toLowerCase();
    const hit = S.agents.find((a) => a.id.toLowerCase() === t || a.name.toLowerCase() === t);
    return hit ? `<span class="mention">@${esc(hit.name)}</span>` : all;
  });
  // marker lines: WILL: / DONE: / DECISION-NEEDED: / DECISION:
  html = html.replace(/^(WILL:)/gm, '<span class="mk will">$1</span>')
    .replace(/^(DONE:)/gm, '<span class="mk done">$1</span>')
    .replace(/^(DECISION-NEEDED:|DECISION:)/gm, '<span class="mk decision">$1</span>');
  return html;
}
function chatMsgById(id) { return S.chatroom.find((m) => m.id === id); }
function chatNameOf(m) {
  if (!m) return '?';
  const agent = m.fromKind === 'agent' ? S.agents.find((a) => a.id === m.from) : null;
  return agent ? agent.name : m.name;
}

// Injection quarantine (mirror of the server's): markers inside code fences
// or blockquotes are documentation, not intent.
function chatAuthoritative(body) {
  return String(body)
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}
window.chatAuthoritative = chatAuthoritative;

// Mirror of the server's chatDerived(): a mention is an ask until the
// mentioned agent replies IN THREAD; WILL: closes only on the author's
// threaded DONE:; DECISION-NEEDED: closes on a human's threaded DECISION:.
function deriveRoomMeta() {
  const replies = new Map();
  for (const m of S.chatroom) {
    if (!m.replyTo) continue;
    if (!replies.has(m.replyTo)) replies.set(m.replyTo, []);
    replies.get(m.replyTo).push(m);
  }
  const openAsks = [], promises = [], decisions = [], blockers = [];
  for (const m of S.chatroom) {
    const rs = replies.get(m.id) || [];
    const allMentions = [...(m.mentions || []), ...(m.personMentions || [])];
    if (allMentions.length) {
      const waitingOn = allMentions.filter((x) => !rs.some((r) => r.from === x));
      if (waitingOn.length) openAsks.push({ ...m, waitingOn });
    }
    const auth = chatAuthoritative(m.body);
    const will = auth.match(/^WILL:\s*(.+)$/m);
    if (will) {
      const own = rs.filter((r) => r.from === m.from);
      const state = own.some((r) => /^DONE:/m.test(chatAuthoritative(r.body))) ? 'done' : own.length ? 'replied' : 'open';
      if (state !== 'done') promises.push({ ...m, text: will[1], state });
    }
    const need = auth.match(/^DECISION-NEEDED:\s*(.+)$/m);
    if (need && !rs.some((r) => r.fromKind !== 'agent' && /^DECISION:/m.test(chatAuthoritative(r.body)))) {
      decisions.push({ ...m, text: need[1] });
    }
    const blk = auth.match(/^BLOCKED:\s*(.+?)\s+ON:\s*(.+?)\s*$/m);
    if (blk && !blk[1].includes('<') && !blk[2].includes('<') && !rs.some((r) => r.from === m.from && /^DONE:/m.test(chatAuthoritative(r.body)))) {
      const target = blk[2].trim();
      const agent = S.agents.find((a) => a.id.toLowerCase() === target.toLowerCase() || a.name.toLowerCase() === target.toLowerCase());
      blockers.push({ ...m, what: blk[1], target: agent ? agent.id : target, targetKind: agent ? 'agent' : 'external' });
    }
  }
  return { openAsks, promises, decisions, blockers };
}
window.deriveRoomMeta = deriveRoomMeta;

function agoStr(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
}
function chatColorOf(m) {
  const agent = m.fromKind === 'agent' ? S.agents.find((a) => a.id === m.from) : null;
  return agent ? agent.color : 'var(--ink-500)';
}

function renderRoomSide() {
  const { openAsks, promises, decisions, blockers } = deriveRoomMeta();
  const parts = [];

  if (blockers.length) {
    parts.push(`<div class="rs-head" style="color:var(--coral)">blocked <b>${blockers.length}</b></div>`);
    for (const b of blockers.slice(-5)) {
      parts.push(`<div class="rs-card">
        <div class="meta"><span style="color:${chatColorOf(b)}; font-weight:600">${esc(chatNameOf(b))}</span><span>on ${esc(b.targetKind === 'agent' ? nameOf(b.target) : b.target)}</span><span>${agoStr(b.ts)}</span></div>
        <div class="txt">${esc(b.what)}</div></div>`);
    }
  }

  parts.push(`<div class="rs-head" style="color:var(--coral)">needs you <b>${decisions.length || ''}</b></div>`);
  if (decisions.length) {
    for (const d of decisions.slice(-6)) {
      parts.push(`<div class="rs-card hot">
        <div class="meta"><span style="color:${chatColorOf(d)}; font-weight:600">${esc(chatNameOf(d))}</span><span>[${esc(d.id)}]</span><span>${agoStr(d.ts)}</span></div>
        <div class="txt">${esc(d.text)}</div>
        <div class="row">
          <button class="btn" style="color:var(--mint)" onclick="decideChat('${d.id}','GO')">GO</button>
          <button class="btn" style="color:var(--coral)" onclick="decideChat('${d.id}','NO-GO')">NO-GO</button>
          <button class="btn" onclick="setRoomReply('${d.id}')">reply…</button>
        </div></div>`);
    }
  } else parts.push('<div class="rs-empty">nothing waiting on your call</div>');

  parts.push(`<div class="rs-head">open asks <b>${openAsks.length || ''}</b></div>`);
  if (openAsks.length) {
    for (const a of openAsks.slice(-6)) {
      parts.push(`<div class="rs-card">
        <div class="meta"><span style="color:${chatColorOf(a)}; font-weight:600">${esc(chatNameOf(a))}</span><span>→ waiting on ${esc(a.waitingOn.map((id) => { const p = S.people.find((q) => q.id === id); return p ? p.name + ' (human)' : nameOf(id); }).join(', '))}</span><span>${agoStr(a.ts)}</span></div>
        <div class="txt" title="${esc(a.body)}">${esc(a.body.slice(0, 150))}</div></div>`);
    }
    parts.push('<div class="rs-empty">an ask closes only when the mentioned agent replies in-thread</div>');
  } else parts.push('<div class="rs-empty">every mention has a threaded reply</div>');

  parts.push(`<div class="rs-head">open promises <b>${promises.length || ''}</b></div>`);
  if (promises.length) {
    for (const p of promises.slice(-6)) {
      parts.push(`<div class="rs-card">
        <div class="meta"><span class="st" style="color:${p.state === 'replied' ? 'var(--sky)' : 'var(--lemon)'}">${p.state}</span><span style="color:${chatColorOf(p)}; font-weight:600">${esc(chatNameOf(p))}</span><span>[${esc(p.id)}]</span><span>${agoStr(p.ts)}</span></div>
        <div class="txt">WILL: ${esc(p.text)}</div></div>`);
    }
    parts.push('<div class="rs-empty">closes only on the author’s threaded DONE: reply</div>');
  } else parts.push('<div class="rs-empty">no unfinished promises</div>');

  // who's in the room
  const counts = new Map();
  for (const m of S.chatroom) counts.set(m.from, (counts.get(m.from) || 0) + 1);
  if (counts.size) {
    parts.push('<div class="rs-head">who’s talking</div><div class="rs-card">');
    for (const [from, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const m = S.chatroom.find((x) => x.from === from);
      parts.push(`<div class="meta" style="margin-bottom:2px"><span style="color:${chatColorOf(m)}; font-weight:600">${esc(chatNameOf(m))}</span><span>${m.fromKind === 'agent' ? 'agent' : 'human'}</span><span style="margin-left:auto">${n} msg${n > 1 ? 's' : ''}</span></div>`);
    }
    parts.push('</div>');
  }

  parts.push(`<div class="rs-head">markers</div>
    <div class="rs-card rs-guide">
      <b>@Name</b> — wakes that agent<br>
      <b>↩ reply</b> — threads; closes an ask<br>
      <b>WILL:</b> — opens a tracked promise<br>
      <b>DONE:</b> — in a threaded reply, closes it<br>
      <b>DECISION-NEEDED:</b> — queues for a human
    </div>`);

  $('roomSide').innerHTML = parts.join('');
}

window.decideChat = async (id, verdict) => {
  await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personId: S.me || null, body: `DECISION: ${verdict}.`, replyTo: id }),
  });
};

function chatAvatarColor(m) {
  if (m.fromKind === 'agent') return S.agents.find((a) => a.id === m.from)?.color || '#8E90A0';
  if (m.fromKind === 'person') return S.people.find((p) => p.id === m.from)?.appearance?.shirt || '#4E93A6';
  return '#8E90A0';
}
// Display-side cleanup: strip mojibake left by badly-encoded posts (U+FFFD
// replacement chars, and the "?? " that a lost 📣 turned into).
function cleanChatBody(s) {
  let t = String(s ?? '').replace(/�/g, '').trim();
  if (t.startsWith('?? ')) t = '📣 ' + t.slice(3);
  return t;
}

function renderRoom() {
  const log = $('roomLog');
  const filter = S.chatFilter || 'all';
  // Fold the flat stream into day separators, compact sync-feed lines, and
  // same-sender message groups (5-minute window) so the room reads like a
  // conversation instead of a log.
  const items = [];
  let lastDay = '';
  for (const m of S.chatroom) {
    const sync = m.from === 'alex-sync';
    if (filter === 'talk' && sync) continue;
    if (filter === 'sync' && !sync) continue;
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      items.push({ type: 'day', label: day === new Date().toDateString() ? 'today' : day });
    }
    if (sync) { items.push({ type: 'sys', m }); continue; }
    const ann = cleanChatBody(m.body).startsWith('📣');
    const last = items[items.length - 1];
    if (last?.type === 'msg' && !ann && !last.ann && !m.replyTo
      && last.msgs[0].from === m.from && m.ts - last.msgs[last.msgs.length - 1].ts < 5 * 60 * 1000) {
      last.msgs.push(m);
    } else {
      items.push({ type: 'msg', ann, msgs: [m] });
    }
  }

  const rows = [];
  for (const it of items) {
    if (it.type === 'day') { rows.push(`<div class="day">— ${esc(it.label)} —</div>`); continue; }
    if (it.type === 'sys') {
      const m = it.m;
      rows.push(`<div class="cmsg sys" id="cm-${esc(m.id)}"><span class="sysic">⟳</span>
        <div class="sysbody">${chatBodyHTML(cleanChatBody(m.body))}</div>
        <span class="ctime">${new Date(m.ts).toTimeString().slice(0, 5)}</span></div>`);
      continue;
    }
    const m0 = it.msgs[0];
    const agent = m0.fromKind === 'agent' ? S.agents.find((a) => a.id === m0.from) : null;
    const mine = m0.from === S.me || (m0.fromKind === 'user' && !S.me);
    const who = agent ? agent.name : m0.name;
    const kind = m0.fromKind === 'agent' ? (agent ? agent.role : 'agent') : (m0.fromKind === 'person' ? 'teammate' : 'human');
    const color = chatAvatarColor(m0);
    const parent = m0.replyTo ? chatMsgById(m0.replyTo) : null;
    const bodies = it.msgs.map((m, i) => `<div class="cbody ${i ? 'grp' : ''}" id="cm-${esc(m.id)}">${chatBodyHTML(cleanChatBody(m.body))}${i ? `<button class="rbtn" data-chat="${esc(m.id)}" title="reply in thread">↩</button>` : ''}</div>`).join('');
    rows.push(`<div class="cmsg ${it.ann ? 'ann' : ''} ${mine ? 'mine' : ''}">
      <span class="cavatar" style="background:color-mix(in srgb, ${color} 22%, var(--surface-2)); color:${color}">${it.ann ? '📣' : esc((who || '?')[0].toUpperCase())}</span>
      <div class="cmain">
        <div class="chead">
          <span class="cwho" style="color:${color}">${esc(who)}</span><span class="ckind">${esc(kind)}</span><span class="cid">[${esc(m0.id)}]</span>
          <button class="rbtn" data-chat="${esc(m0.id)}" title="reply in thread">↩ reply</button>
          <span class="ctime">${new Date(m0.ts).toTimeString().slice(0, 8)}</span>
        </div>
        ${m0.replyTo ? `<span class="creply" data-goto="${esc(m0.replyTo)}" title="jump to the original">↩ ${parent ? `<b>${esc(chatNameOf(parent))}</b>: ${esc(cleanChatBody(parent.body).slice(0, 80))}` : `[${esc(m0.replyTo)}]`}</span>` : ''}
        ${bodies}
      </div></div>`);
  }

  log.innerHTML = rows.length ? rows.join('')
    : '<div style="color:var(--ink-500); font-size:13px; margin:auto;">#office is empty — start the conversation. Mention @Marlowe (or any agent) to wake them.</div>';
  for (const el of log.querySelectorAll('[data-chat]')) {
    el.onclick = () => setRoomReply(el.dataset.chat);
  }
  for (const el of log.querySelectorAll('[data-goto]')) el.onclick = () => {
    const t = document.getElementById('cm-' + el.dataset.goto);
    if (!t) return;
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    t.classList.add('flash');
    setTimeout(() => t.classList.remove('flash'), 1400);
  };
  const people = new Set(S.chatroom.map((m) => m.from));
  $('roomStats').textContent = `${S.chatroom.length} messages · ${people.size} voices`;
  renderRoomSide();
  log.scrollTop = log.scrollHeight;
}

let roomReplyTo = null;
window.setRoomReply = (id) => setRoomReply(id);
function setRoomReply(id) {
  roomReplyTo = id;
  const m = chatMsgById(id);
  $('roomReplyBar').classList.remove('hidden');
  $('roomReplyBar').innerHTML = `<span>↩ replying to [${esc(id)}]</span><span class="grow">${esc(chatNameOf(m))}: ${esc((m?.body || '').slice(0, 90))}</span><button class="btn" style="height:20px" id="btnCancelReply">✕</button>`;
  $('btnCancelReply').onclick = clearRoomReply;
  $('roomInput').focus();
}
function clearRoomReply() {
  roomReplyTo = null;
  $('roomReplyBar').classList.add('hidden');
  $('roomReplyBar').innerHTML = '';
}

async function sendRoomPost() {
  const body = $('roomInput').value.trim();
  if (!body) return;
  $('roomInput').value = '';
  const replyTo = roomReplyTo;
  clearRoomReply();
  await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personId: S.me || null, body, replyTo }),
  });
}
$('btnRoomSend').onclick = sendRoomPost;
for (const b of document.querySelectorAll('.chat-filters button')) b.onclick = () => {
  S.chatFilter = b.dataset.f;
  document.querySelectorAll('.chat-filters button').forEach((x) => x.classList.toggle('on', x === b));
  renderRoom();
};
$('roomInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRoomPost(); }
  if (e.key === 'Escape') clearRoomReply();
});

// ------------------------------------------------------------- modal
function openModal(title, fields, onSubmit) {
  const backdrop = document.createElement('div');
  backdrop.id = 'modalBackdrop';
  backdrop.innerHTML = `<div class="modal">
    <h2>${esc(title)}</h2>
    ${fields.map((f) => `<label><span class="lbl">${esc(f.label)}</span>${f.textarea
      ? `<textarea data-key="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(f.value)}</textarea>`
      : f.select
        ? `<select data-key="${f.key}">${S.models.map((m) => `<option value="${m.id}" ${m.id === f.value ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`
        : f.options
          ? `<select data-key="${f.key}">${f.options.map((o) => `<option value="${o.id}" ${o.id === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
          : `<input type="text" data-key="${f.key}" value="${esc(f.value)}" placeholder="${esc(f.placeholder || '')}">`}</label>`).join('')}
    <div class="row">
      <button class="btn" data-act="cancel">cancel</button>
      <button class="btn primary" data-act="ok">save</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('input,textarea')?.focus();
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  backdrop.querySelector('[data-act=cancel]').onclick = () => backdrop.remove();
  backdrop.querySelector('[data-act=ok]').onclick = async () => {
    const vals = {};
    for (const el of backdrop.querySelectorAll('[data-key]')) vals[el.dataset.key] = el.value;
    backdrop.remove();
    await onSubmit(vals);
  };
  return backdrop;
}

// deep-link support: #graph opens the graph view, #agent=<id> opens a chat,
// #hire opens the hire modal
if (location.hash === '#graph') setView('graph');
boot().then(() => {
  const m = location.hash.match(/^#agent=(.+)$/);
  if (m) selectAgent(decodeURIComponent(m[1]));
  if (location.hash === '#hire') openHireModal();
});
