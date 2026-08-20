/* Project Brain browser — the archive terminal behind the BRAIN CORE on the
   floor. A read-only window over /api/brain/* (the same bounded reads every
   agent already has: list / read / search — no write path exists).
   Left pane: root chips + directory listing, or search hits.
   Right pane: mono reader with markdown headings tinted. */
'use strict';

const OfficeBrain = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let curRef = null;      // ref currently in the reader
  let nextOffset = null;  // "load more" offset when the server truncated

  async function api(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  const brain = () => (typeof S !== 'undefined' ? S.brain : null);
  const rootKeys = () => Object.keys(brain()?.roots || {});
  const parentOf = (ref) => {
    const m = String(ref).match(/^([\w-]+):(.*)$/);
    if (!m) return null;
    const parts = m[2].replace(/\/+$/, '').split('/').filter(Boolean);
    parts.pop();
    return `${m[1]}:${parts.join('/')}`;
  };

  // ------------------------------------------------------------- open/close
  function open() {
    $('brainView').classList.remove('hidden');
    const b = brain();
    $('brainName').textContent = b ? `${b.name}${b.hub ? ` · hub: ${b.hub}` : ''}` : 'not configured';
    if (!b) {
      $('brainSide').innerHTML = '<div class="bn-empty">No project brain configured yet — set the knowledge roots in the <b>Controls</b> tab, then come back to the core.</div>';
      $('brainCrumb').textContent = '';
      $('brainDoc').innerHTML = '';
      $('btnBrainMore').classList.add('hidden');
      return;
    }
    goHub();
    setTimeout(() => $('brainSearch').focus(), 0);
  }

  function close() { $('brainView').classList.add('hidden'); }

  function goHub() {
    const b = brain();
    if (b?.hub) loadFile(b.hub);
    else if (rootKeys().length) loadDir(`${rootKeys()[0]}:`);
  }

  // ------------------------------------------------------------- side pane
  function rootChips(activeKey) {
    return `<div class="bn-roots">${rootKeys().map((k) =>
      `<button class="btn" data-root="${esc(k)}" style="${k === activeKey ? 'border-color:var(--sky);color:var(--sky)' : ''}">${esc(k)}</button>`).join('')}</div>`;
  }

  function wireSide() {
    for (const el of $('brainSide').querySelectorAll('[data-root]')) el.onclick = () => loadDir(`${el.dataset.root}:`);
    for (const el of $('brainSide').querySelectorAll('[data-dir]')) el.onclick = () => loadDir(el.dataset.dir);
    for (const el of $('brainSide').querySelectorAll('[data-file]')) el.onclick = () => loadFile(el.dataset.file, +(el.dataset.offset || 1));
  }

  async function loadDir(ref) {
    const key = String(ref).split(':')[0];
    try {
      const { listing } = await api(`/api/brain/list?ref=${encodeURIComponent(ref)}`);
      const items = listing.split('\n').map((l) => {
        const m = l.match(/^(dir |file)\s+(.+)$/);
        return m ? { dir: m[1].trim() === 'dir', ref: m[2] } : null;
      }).filter(Boolean);
      const up = parentOf(ref.replace(/:$/, ':')) ;
      const showUp = /:.+/.test(ref);
      $('brainSide').innerHTML = rootChips(key)
        + (showUp ? `<div class="bn-item dir" data-dir="${esc(up)}"><span class="ic">▲</span><span class="nm">..</span></div>` : '')
        + (items.length ? items.map((it) => {
          const name = it.ref.split(':')[1].replace(/\/$/, '').split('/').pop() || it.ref;
          return `<div class="bn-item ${it.dir ? 'dir' : ''}" data-${it.dir ? 'dir' : 'file'}="${esc(it.ref)}">
            <span class="ic">${it.dir ? '▸' : '·'}</span><span class="nm">${esc(name)}</span></div>`;
        }).join('') : '<div class="bn-empty">(empty)</div>');
      wireSide();
    } catch (e) {
      $('brainSide').innerHTML = rootChips(key) + `<div class="bn-empty">${esc(e.message)}</div>`;
      wireSide();
    }
  }

  async function search(q) {
    try {
      const { hits } = await api(`/api/brain/search?q=${encodeURIComponent(q)}`);
      if (/^No matches/.test(hits)) {
        $('brainSide').innerHTML = rootChips(null) + `<div class="bn-empty">${esc(hits)}</div>`;
        return wireSide();
      }
      const rows = hits.split('\n').map((l) => {
        const m = l.match(/^([\w-]+):(.+?):(\d+)\s+(.*)$/);
        return m ? { root: m[1], rel: m[2], line: +m[3], text: m[4] } : null;
      }).filter(Boolean);
      $('brainSide').innerHTML = rootChips(null) + rows.map((h) =>
        `<div class="bn-hit" data-file="${esc(`${h.root}:${h.rel}`)}" data-offset="${Math.max(1, h.line - 4)}">
          <div class="where">${esc(h.root)}:${esc(h.rel)}:${h.line}</div>
          <div class="line">${esc(h.text)}</div></div>`).join('');
      wireSide();
    } catch (e) {
      $('brainSide').innerHTML = rootChips(null) + `<div class="bn-empty">${esc(e.message)}</div>`;
      wireSide();
    }
  }

  // ------------------------------------------------------------- reader
  async function loadFile(ref, offset = 1, append = false) {
    try {
      const { body } = await api(`/api/brain/read?ref=${encodeURIComponent(ref)}&offset=${offset}`);
      const lines = body.split('\n');
      nextOffset = null;
      const last = lines[lines.length - 1] || '';
      const more = last.match(/^… \(\d+ more lines — call again with offset (\d+)\)$/);
      if (more) { nextOffset = +more[1]; lines.pop(); }
      const html = lines.map((l) => {
        const stripped = l.replace(/^\d+\t/, '');
        return /^#{1,6}\s/.test(stripped) ? `<b class="md-h">${esc(stripped)}</b>` : esc(stripped);
      }).join('\n');
      curRef = ref;
      $('brainCrumb').innerHTML = `<b>${esc(ref)}</b>${offset > 1 && !append ? ` · from line ${offset}` : ''}`;
      if (append) $('brainDoc').innerHTML += '\n' + html;
      else { $('brainDoc').innerHTML = html; $('brainMain').scrollTop = 0; }
      $('btnBrainMore').classList.toggle('hidden', !nextOffset);
      if (!append) loadDir(parentOf(ref));   // keep the side pane in context
    } catch (e) {
      $('brainCrumb').innerHTML = `<b>${esc(ref)}</b>`;
      $('brainDoc').textContent = e.message;
      $('btnBrainMore').classList.add('hidden');
    }
  }

  // ------------------------------------------------------------- wiring
  $('btnBrainClose').onclick = close;
  $('btnBrainHub').onclick = goHub;
  $('btnBrainMore').onclick = () => { if (curRef && nextOffset) loadFile(curRef, nextOffset, true); };
  $('brainSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = $('brainSearch').value.trim();
      if (q.length >= 2) search(q);
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('brainView').classList.contains('hidden')) close();
  });
  // switching main tabs closes the terminal so it never sits over another view
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', close);

  window.openBrain = open;
  return { open, close };
})();
