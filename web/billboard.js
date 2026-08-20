/* Office billboard — the wall TV in the HQ hall, wired to the shared
   blackboard. Read: GET /api/blackboard (kept fresh by the
   blackboard_updated event via app.js). Pin: POST /api/blackboard —
   appends through the same audited path agents use (blackboard_append),
   so a pinned note reaches every agent's turn context. */
'use strict';

const OfficeBillboard = (() => {
  const $ = (id) => document.getElementById(id);

  function render() {
    const text = (typeof S !== 'undefined' ? String(S.blackboard || '') : '').trim();
    $('bbText').textContent = text
      || 'The billboard is empty — agents post here with blackboard_append, or pin the first note below.';
  }

  async function open() {
    $('billboardView').classList.remove('hidden');
    try {
      const j = await (await fetch('/api/blackboard')).json();
      if (typeof S !== 'undefined') S.blackboard = j.blackboard || '';
    } catch { /* render whatever state has */ }
    render();
    $('bbBody').scrollTop = $('bbBody').scrollHeight;
    setTimeout(() => $('bbInput').focus(), 0);
  }

  function close() { $('billboardView').classList.add('hidden'); }

  async function pin() {
    const text = $('bbInput').value.trim();
    if (!text) return;
    try {
      const r = await fetch('/api/blackboard', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, personId: (typeof S !== 'undefined' && S.me) || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'pin failed');
      if (typeof S !== 'undefined') S.blackboard = j.blackboard || '';
      $('bbInput').value = '';
      render();
      $('bbBody').scrollTop = $('bbBody').scrollHeight;
    } catch (e) {
      $('bbText').textContent += `\n⚠ ${e.message}`;
    }
  }

  // ------------------------------------------------------------- wiring
  $('btnBbClose').onclick = close;
  $('btnBbPin').onclick = pin;
  $('bbInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pin(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('billboardView').classList.contains('hidden')) close();
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', close);

  window.openBillboard = open;
  window.renderBillboard = render;
  return { open, close };
})();
