/* Skills Shop — the storefront behind the SKILLS SHOP counter on the floor.
   Catalog from GET /api/shop, grouped by provider (claude / openclaw /
   hermes). Buying POSTs /api/shop/buy: the skill's instruction lands in the
   agent's system prompt server-side, so this is a real capability change. */
'use strict';

const OfficeShop = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PROV = {
    claude: { color: 'var(--coral)' },
    openclaw: { color: 'var(--sky)' },
    hermes: { color: 'var(--lilac)' },
  };
  const SUB_DEFAULT = 'equip an agent with new working habits — a bought skill lands in their system prompt';
  let catalog = null;

  async function open() {
    $('shopView').classList.remove('hidden');
    $('shopSub').textContent = SUB_DEFAULT;
    if (!catalog) {
      try { catalog = (await (await fetch('/api/shop')).json()).skills || []; }
      catch { catalog = []; }
    }
    fillAgents();
    render();
  }

  function close() { $('shopView').classList.add('hidden'); }

  function fillAgents() {
    const sel = $('shopAgent');
    const cur = sel.value;
    sel.innerHTML = S.agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${esc(a.role)}</option>`).join('');
    if (cur && S.agents.some((a) => a.id === cur)) sel.value = cur;
  }

  function render() {
    const agent = S.agents.find((a) => a.id === $('shopAgent').value);
    const owned = new Set(agent?.skills || []);
    $('shopBody').innerHTML = Object.keys(PROV).map((p) => {
      const items = (catalog || []).filter((s) => s.provider === p);
      if (!items.length) return '';
      return `<div class="sk-prov"><span class="nm" style="color:${PROV[p].color}">${p}</span><span class="ln"></span></div>
        <div class="sk-grid">${items.map((s) => `
          <div class="sk-card ${owned.has(s.id) ? 'owned' : ''}" style="border-top-color:${PROV[p].color}">
            <div class="t"><b>${esc(s.name)}</b><span class="price">₵${s.price}</span></div>
            <div class="blurb">${esc(s.blurb)}</div>
            <div class="row">${owned.has(s.id)
              ? '<button class="btn" disabled>equipped ✓</button>'
              : `<button class="btn primary" data-buy="${esc(s.id)}">equip →</button>`}</div>
          </div>`).join('')}</div>`;
    }).join('');
    for (const b of $('shopBody').querySelectorAll('[data-buy]')) b.onclick = () => buy(b.dataset.buy);
  }

  async function buy(skillId) {
    const agentId = $('shopAgent').value;
    if (!agentId) return;
    try {
      const r = await fetch('/api/shop/buy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, skillId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'purchase failed');
      const i = S.agents.findIndex((a) => a.id === j.agent.id);
      if (i >= 0) S.agents[i] = j.agent;
      $('shopSub').textContent = `${j.agent.name} equipped "${skillId}" — their session restarts with the new skill.`;
      render();
    } catch (e) {
      $('shopSub').textContent = `⚠ ${e.message}`;
    }
  }

  // ------------------------------------------------------------- wiring
  $('btnShopClose').onclick = close;
  $('shopAgent').onchange = render;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('shopView').classList.contains('hidden')) close();
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', close);

  window.openShop = open;
  return { open, close };
})();
