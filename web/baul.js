/* HQ MEMORY SERVICE 🧠 — UI for the office's team memory store (the tweet-pattern
   memory mount: topic files, content hashes, synced both ways).
   Self-contained on purpose: injects its own styles, builds its own DOM,
   and adds its own header button — the only wiring needed elsewhere is the
   <script> tag. Uses the design-system tokens so it follows day/night.
   Reads: GET /api/state (list) + /api/memory/raw (content).
   Writes: POST /api/memory — same audited path the agents' memory_write uses. */
'use strict';

(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
  };
  const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B');

  const css = `
  #baulView { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--bg, #111) 62%, transparent); backdrop-filter: blur(2px); }
  #baulView.hidden { display: none !important; }
  .baul-card { width: min(1060px, 94vw); height: min(680px, 88vh); display: flex; flex-direction: column;
    background: var(--surface, #fff); color: var(--text, #111); border: 1px solid var(--border, #ddd);
    border-radius: var(--r, 12px); box-shadow: var(--shadow-pop, 0 14px 40px rgba(0,0,0,.3)); overflow: hidden; }
  .baul-head { flex: 0 0 auto; display: flex; align-items: baseline; gap: 12px; padding: 13px 18px;
    border-bottom: 1px solid var(--border, #ddd); }
  .baul-head b { font-size: 13px; letter-spacing: .07em; }
  .baul-head .sub { font-size: 12px; color: var(--text-3, #888); }
  .baul-head .x { margin-left: auto; cursor: pointer; border: none; background: none; color: var(--text-3, #888); font-size: 15px; }
  .baul-head .x:hover { color: var(--text, #111); }
  .baul-body { flex: 1; display: flex; min-height: 0; }
  .baul-list { flex: 0 0 330px; overflow-y: auto; border-right: 1px solid var(--border, #ddd); padding: 10px; }
  .baul-item { padding: 9px 11px; border-radius: var(--r-sm, 8px); cursor: pointer; border: 1px solid transparent; }
  .baul-item:hover { background: var(--surface-2, #f2f2f2); }
  .baul-item.sel { background: var(--surface-2, #f2f2f2); border-color: var(--border-strong, #bbb); }
  .baul-item .row1 { display: flex; gap: 8px; align-items: baseline; }
  .baul-item .name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .baul-item .hash { margin-left: auto; font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--text-3, #888); }
  .baul-item .row2 { display: flex; gap: 8px; font-size: 11.5px; color: var(--text-3, #888); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .baul-new { margin: 6px 0 2px; width: 100%; }
  .baul-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .baul-toolbar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border, #ddd); }
  .baul-toolbar .t-name { font-family: var(--font-mono, monospace); font-size: 12.5px; font-weight: 600; }
  .baul-toolbar .t-hash { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-3, #888); }
  .baul-toolbar .grow { flex: 1; }
  .baul-status { font-size: 11.5px; color: var(--text-3, #888); }
  #baulEditor { flex: 1; resize: none; border: none; outline: none; padding: 14px 16px;
    background: var(--surface, #fff); color: var(--text, #111);
    font-family: var(--font-mono, monospace); font-size: 12.8px; line-height: 1.6; }
  .baul-foot { flex: 0 0 auto; padding: 7px 16px; border-top: 1px solid var(--border, #ddd);
    font-size: 11px; color: var(--text-3, #888); }
  #btnBaul { border: 1px solid var(--border, #ddd); background: var(--surface, #fff); color: var(--text-2, #555);
    height: 28px; padding: 0 10px; border-radius: 999px; cursor: pointer; font-size: 13px; }
  #btnBaul:hover { color: var(--text, #111); border-color: var(--border-strong, #bbb); }
  .baul-empty { padding: 24px; color: var(--text-3, #888); font-size: 13px; }`;

  let topics = [], selected = null, dirty = false, refreshTimer = null;

  function ensureDom() {
    if (document.getElementById('baulView')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const view = document.createElement('div');
    view.id = 'baulView';
    view.className = 'hidden';
    view.innerHTML = `
      <div class="baul-card">
        <div class="baul-head">
          <b>🧠 MEMORY STORE</b> <span class="t-hash" style="font-family:var(--font-mono,monospace); font-size:11px; color:var(--text-3,#888)">memstore_hq01</span> <span style="font-size:10px; border:1px solid var(--border,#ddd); border-radius:999px; padding:1px 8px; color:var(--text-3,#888)">read_write</span>
          <span class="sub">HQ Memory Service — mounted both ways: agents at kayo, iisang store, hash-versioned</span>
          <button class="x" id="baulClose" title="close (Esc)">✕</button>
        </div>
        <div class="baul-body">
          <div class="baul-list" id="baulList"></div>
          <div class="baul-main">
            <div class="baul-toolbar">
              <span class="t-name" id="baulName">—</span><span class="t-hash" id="baulHash"></span>
              <span class="grow"></span>
              <span class="baul-status" id="baulStatus"></span>
              <button class="btn primary" id="baulSave">save</button>
            </div>
            <textarea id="baulEditor" placeholder="Pick a topic on the left — or create a new one. Whatever you save here is read by every agent on their next turn." spellcheck="false"></textarea>
            <div class="baul-foot">Edits here go through the same audited write path as the agents' memory_write. Markdown · 64KB max per topic · Memo 🗄️ curates this store (our EnvironmentWorker).</div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(view);
    view.addEventListener('click', (e) => { if (e.target === view) close(); });
    document.getElementById('baulClose').onclick = close;
    document.getElementById('baulSave').onclick = save;
    document.getElementById('baulEditor').addEventListener('input', () => { dirty = true; setStatus('unsaved changes'); });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !view.classList.contains('hidden')) close();
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && !view.classList.contains('hidden')) { e.preventDefault(); save(); }
    });
  }

  const setStatus = (t) => { const el = document.getElementById('baulStatus'); if (el) el.textContent = t; };

  async function refreshList(keepSelection = true) {
    const d = await (await fetch('/api/state')).json();
    topics = d.memoryStore || [];
    if (!keepSelection || (selected && !topics.some((t) => t.topic === selected))) selected = null;
    renderList();
  }

  function renderList() {
    const list = document.getElementById('baulList');
    list.innerHTML = `<button class="btn baul-new" id="baulNew">+ new topic</button>` + (topics.length
      ? topics.map((t) => `
        <div class="baul-item ${t.topic === selected ? 'sel' : ''}" data-t="${esc(t.topic)}">
          <div class="row1"><span class="name">${esc(t.topic)}</span><span class="hash">${esc(t.hash)}</span></div>
          <div class="row2"><span>${kb(t.bytes)}</span><span>· ${ago(t.mtime)} ago</span><span>· ${esc(t.hint)}</span></div>
        </div>`).join('')
      : '<div class="baul-empty">The Baul is empty.</div>');
    document.getElementById('baulNew').onclick = newTopic;
    for (const el of list.querySelectorAll('.baul-item')) el.onclick = () => openTopic(el.dataset.t);
  }

  async function openTopic(topic) {
    if (dirty && !confirm('May unsaved changes — discard?')) return;
    const r = await fetch('/api/memory/raw?topic=' + encodeURIComponent(topic));
    if (!r.ok) { setStatus('failed to load'); return; }
    const d = await r.json();
    selected = d.topic; dirty = false;
    document.getElementById('baulName').textContent = d.topic;
    document.getElementById('baulHash').textContent = `[${d.hash}]`;
    document.getElementById('baulEditor').value = d.content;
    setStatus('');
    renderList();
  }

  function newTopic() {
    const name = prompt('Topic name (magiging <name>.md):');
    if (!name) return;
    selected = null; dirty = true;
    document.getElementById('baulName').textContent = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') + '.md';
    document.getElementById('baulHash').textContent = '[new]';
    document.getElementById('baulEditor').value = `# ${name}\n\n`;
    setStatus('unsaved — hit save to create');
    document.getElementById('baulEditor').focus();
  }

  async function save() {
    const topic = document.getElementById('baulName').textContent;
    if (!topic || topic === '—') return;
    const content = document.getElementById('baulEditor').value;
    const r = await fetch('/api/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, content, personId: localStorage.getItem('hq.personId') || null }),
    });
    const d = await r.json();
    if (d.error) { setStatus(d.error); return; }
    dirty = false; selected = d.topic;
    document.getElementById('baulHash').textContent = `[${d.hash}]`;
    setStatus(`saved [${d.hash}] — visible to all agents next turn`);
    refreshList();
  }

  function open() {
    ensureDom();
    document.getElementById('baulView').classList.remove('hidden');
    refreshList();
    refreshTimer = setInterval(() => { if (!dirty) refreshList(); }, 10000);
  }
  function close() {
    if (dirty && !confirm('May unsaved changes — isara pa rin?')) return;
    dirty = false;
    document.getElementById('baulView').classList.add('hidden');
    clearInterval(refreshTimer);
  }
  window.openBaul = open;

  // Header button — self-installs next to the theme toggle (fallback: fixed).
  const btn = document.createElement('button');
  btn.id = 'btnBaul';
  btn.title = 'HQ Memory Service — team memory store';
  btn.textContent = '🧠';
  btn.onclick = open;
  const theme = document.getElementById('btnTheme');
  if (theme && theme.parentNode) theme.parentNode.insertBefore(btn, theme);
  else {
    btn.style.cssText += ';position:fixed;right:14px;bottom:14px;z-index:55;height:34px;font-size:16px;';
    document.body.appendChild(btn);
  }
})();
