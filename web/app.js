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
  const cards = S.agents.map((a) => `
    <button class="card ${S.selected === a.id ? 'selected' : ''}" data-id="${a.id}" title="${esc(a.statusDetail || a.role)}">
      <span class="portrait" style="background:${lightOf(a.color)}">${esc(a.avatar || '🙂')}</span>
      <span style="min-width:0">
        <div class="cname">${esc(a.name)}${a.isOrchestrator ? ' ★' : ''}</div>
        <div class="crole">${esc(a.role)}</div>
        <div class="cmodel">${esc(a.model)}${a.ownerId ? ` · ${esc(nameOfPerson(a.ownerId))}` : ''}</div>
      </span>
      <span class="badge"><span class="sq" style="background:${STATUS_COLOR[a.status] || '#A199AB'}"></span>${STATUS_LABEL[a.status] || a.status}</span>
    </button>`).join('');
  $('strip').innerHTML = cards + `<button id="btnNewAgentCard">+ hire<br>agent</button>`;
  for (const card of document.querySelectorAll('.card')) card.onclick = () => selectAgent(card.dataset.id);
  $('btnNewAgentCard').onclick = openHireModal;
}
function lightOf(hex) {
  const light = { '#D96A62': '#F3D3CD', '#4F9FAF': '#CFE5E9', '#5CA97A': '#D2E7DA', '#DCAB3C': '#F3E4BC', '#9482D3': '#E0DAF2', '#D99168': '#F3DACA' };
  return light[hex] || '#F4E9C7';
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
$('tabFloor').onclick = () => setView('floor');
$('tabGraph').onclick = () => setView('graph');
function setView(v) {
  S.view = v;
  $('tabFloor').classList.toggle('active', v === 'floor');
  $('tabGraph').classList.toggle('active', v === 'graph');
  $('floorCanvas').classList.toggle('hidden', v !== 'floor');
  $('floorHint').classList.toggle('hidden', v !== 'floor');
  $('graphSvg').classList.toggle('hidden', v !== 'graph');
}

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
