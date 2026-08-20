/* PLAYER CARDS 🎴 — click any character (lee, teammates, agents, sub-agents)
   and an RPG-style card pops up: role, LEVEL + XP bar, status, last-active,
   equipped skills (from the Skills Shop), and contribution stats.
   Self-contained: injects styles + DOM, wraps window.selectAgent /
   window.selectPerson (original sidebar behavior is preserved — the card
   rides on top). Data: /api/state (xp, agents, people, chat) + /api/shop.
   XP award table and level curve are v1 — balancing pass planned. */
'use strict';

(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (ts) => {
    if (!ts) return 'never';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
  };
  const PROVIDER_COLOR = { claude: 'var(--coral, #D96A62)', openclaw: 'var(--sky, #4E93A6)', hermes: 'var(--lemon, #B08428)' };

  const css = `
  #pcView { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--bg, #111) 45%, transparent); }
  #pcView.hidden { display: none !important; }
  .pc-card { width: 400px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
    background: var(--surface, #fff); color: var(--text, #111); border: 1px solid var(--border-strong, #bbb);
    border-radius: 14px; box-shadow: var(--shadow-pop, 0 14px 40px rgba(0,0,0,.4)); }
  .pc-head { display: flex; gap: 12px; align-items: center; padding: 16px 18px 12px; border-bottom: 1px solid var(--border, #ddd); }
  .pc-avatar { width: 52px; height: 52px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    font-size: 26px; border: 2px solid var(--border-strong, #bbb); flex: 0 0 auto; }
  .pc-name { font-weight: 700; font-size: 16px; }
  .pc-role { font-size: 12px; color: var(--text-3, #888); }
  .pc-lvl { margin-left: auto; text-align: center; flex: 0 0 auto; }
  .pc-lvl .n { font-size: 22px; font-weight: 800; line-height: 1; }
  .pc-lvl .t { font-size: 9px; letter-spacing: .12em; color: var(--text-3, #888); }
  .pc-xp { padding: 10px 18px 4px; }
  .pc-bar { height: 8px; border-radius: 999px; background: var(--surface-3, #eee); overflow: hidden; }
  .pc-bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--sky, #4E93A6), var(--mint, #4E9E74)); }
  .pc-xp .lbl2 { display: flex; justify-content: space-between; font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--text-3, #888); margin-top: 4px; }
  .pc-sec { padding: 10px 18px; }
  .pc-sec h4 { margin: 0 0 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3, #888); }
  .pc-row { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; padding: 2px 0; }
  .pc-row .k { color: var(--text-3, #888); flex: 0 0 92px; }
  .pc-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; margin-right: 5px; }
  .pc-skill { display: inline-flex; align-items: center; gap: 6px; margin: 0 6px 6px 0; padding: 4px 10px;
    border: 1px solid var(--border, #ddd); border-radius: 999px; font-size: 11.5px; }
  .pc-skill i { width: 7px; height: 7px; border-radius: 999px; }
  .pc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .pc-stat { text-align: center; padding: 8px 4px; background: var(--surface-2, #f4f4f4); border-radius: 10px; }
  .pc-stat .v { font-weight: 700; font-size: 15px; }
  .pc-stat .k { font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3, #888); }
  .pc-none { color: var(--text-4, #aaa); font-size: 12px; }
  .pc-foot { padding: 8px 18px 12px; font-size: 10.5px; color: var(--text-4, #aaa); }`;

  let skillsCatalog = null;

  function ensureDom() {
    if (document.getElementById('pcView')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const view = document.createElement('div');
    view.id = 'pcView';
    view.className = 'hidden';
    view.innerHTML = '<div class="pc-card" id="pcCard"></div>';
    document.body.appendChild(view);
    view.addEventListener('click', (e) => { if (e.target === view) close(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  const close = () => document.getElementById('pcView')?.classList.add('hidden');

  async function openCard(kind, id) {
    ensureDom();
    if (!skillsCatalog) {
      try { skillsCatalog = (await (await fetch('/api/shop')).json()).skills || []; } catch { skillsCatalog = []; }
    }
    const d = await (await fetch('/api/state')).json();
    const xp = (d.xp || {})[id] || { xp: 0, level: 1, into: 0, need: 100, awards: {}, lastActiveTs: 0 };
    const msgs = (d.chat || []).filter((m) => m.from === id).length;
    let html = '';

    if (kind === 'agent') {
      const a = (d.agents || []).find((x) => x.id === id);
      if (!a) return;
      const owner = a.ownerId ? (d.people || []).find((p) => p.id === a.ownerId)?.name : null;
      const usage = (d.usage?.byAgent || {})[id];
      const statusColor = a.status === 'idle' ? 'var(--text-4,#aaa)' : a.status === 'over_budget' ? 'var(--coral,#D96A62)' : 'var(--mint,#4E9E74)';
      const skills = (a.skills || []).map((sid) => skillsCatalog.find((s) => s.id === sid)).filter(Boolean);
      html = `
        <div class="pc-head">
          <div class="pc-avatar" style="border-color:${esc(a.color)}; background: color-mix(in srgb, ${esc(a.color)} 18%, var(--surface,#fff))">${esc(a.avatar || '🤖')}</div>
          <div><div class="pc-name">${esc(a.name)}${a.isOrchestrator ? ' ★' : ''}</div>
            <div class="pc-role">${esc(a.role)}${a.parentId ? ' · sub-agent' : ''} · ${esc(a.model)}${owner ? ` · owner: ${esc(owner)}` : ''}</div></div>
          <div class="pc-lvl"><div class="n">Lv ${xp.level}</div><div class="t">LEVEL</div></div>
        </div>
        <div class="pc-xp"><div class="pc-bar"><i style="width:${Math.min(100, Math.round((xp.into / xp.need) * 100))}%"></i></div>
          <div class="lbl2"><span>${xp.xp} XP</span><span>${xp.into}/${xp.need} to Lv ${xp.level + 1}</span></div></div>
        <div class="pc-sec">
          <div class="pc-row"><span class="k">status</span><span><span class="pc-dot" style="background:${statusColor}"></span>${esc(a.status === 'thinking' ? 'working' : a.status.replace('_', ' '))}</span></div>
          <div class="pc-row"><span class="k">last active</span><span>${ago(xp.lastActiveTs)}</span></div>
        </div>
        <div class="pc-sec"><h4>skills</h4>
          ${skills.length ? skills.map((s) => `<span class="pc-skill" title="${esc(s.blurb)}"><i style="background:${PROVIDER_COLOR[s.provider] || '#999'}"></i>${esc(s.name)}</span>`).join('')
        : '<span class="pc-none">no skills yet — buy them one at the Skills Shop</span>'}</div>
        <div class="pc-sec"><h4>contribution</h4><div class="pc-stats">
          <div class="pc-stat"><div class="v">${xp.awards.memory_write || 0}</div><div class="k">memory writes</div></div>
          <div class="pc-stat"><div class="v">${msgs}</div><div class="k">#office msgs</div></div>
          <div class="pc-stat"><div class="v">${usage?.turns || 0}</div><div class="k">turns worked</div></div>
        </div></div>
        <div class="pc-foot">XP table v1 — balancing pass coming. Memory-store writes weigh most: knowledge compounds.</div>`;
    } else {
      const p = (d.people || []).find((x) => x.id === id);
      if (!p) return;
      const ownedAgents = (d.agents || []).filter((a) => a.ownerId === id);
      const room = p.roomIndex != null ? `Room ${p.roomIndex + 1}` : 'roaming';
      html = `
        <div class="pc-head">
          <div class="pc-avatar" style="border-color:${esc(p.appearance?.shirt || '#888')}; background: color-mix(in srgb, ${esc(p.appearance?.shirt || '#888')} 18%, var(--surface,#fff))">🧑‍🚀</div>
          <div><div class="pc-name">${esc(p.name)}</div>
            <div class="pc-role">teammate · ${esc(room)} · ${ownedAgents.length} agent${ownedAgents.length === 1 ? '' : 's'}</div></div>
          <div class="pc-lvl"><div class="n">Lv ${xp.level}</div><div class="t">LEVEL</div></div>
        </div>
        <div class="pc-xp"><div class="pc-bar"><i style="width:${Math.min(100, Math.round((xp.into / xp.need) * 100))}%"></i></div>
          <div class="lbl2"><span>${xp.xp} XP</span><span>${xp.into}/${xp.need} to Lv ${xp.level + 1}</span></div></div>
        <div class="pc-sec">
          <div class="pc-row"><span class="k">status</span><span><span class="pc-dot" style="background:${p.online ? 'var(--mint,#4E9E74)' : 'var(--text-4,#aaa)'}"></span>${p.online ? 'in the office' : 'away'}</span></div>
          <div class="pc-row"><span class="k">last active</span><span>${ago(xp.lastActiveTs || p.lastSeen)}</span></div>
          <div class="pc-row"><span class="k">live sessions</span><span>${p.sessions?.length ? p.sessions.map((s) => '⚡' + esc(s.project)).join('  ') : '<span class="pc-none">none reported</span>'}</span></div>
          <div class="pc-row"><span class="k">own agents</span><span>${(p.connections || []).length
        ? p.connections.map((c) => `<span class="pc-skill" title="last ping ${ago(c.ts)}"><i style="background:${c.kind === 'claude' ? 'var(--coral,#D96A62)' : c.kind === 'codex' ? 'var(--mint,#4E9E74)' : 'var(--sky,#4E93A6)'}"></i>${esc(c.kind)}${c.label ? ' · ' + esc(c.label) : ''} <b style="color:var(--mint,#4E9E74)">●</b></span>`).join(' ')
        : `<span class="pc-none">nothing connected — office-bridge / Codex / OpenClaw (see 🧠 team-agent-bridge.md)</span>`}</span></div>
        </div>
        <div class="pc-sec"><h4>agents</h4>
          ${ownedAgents.length ? ownedAgents.map((a) => `<span class="pc-skill"><i style="background:${esc(a.color)}"></i>${esc(a.avatar || '')} ${esc(a.name)} · ${esc(a.role)}</span>`).join('')
        : '<span class="pc-none">no agents yet — hire one with owner = ' + esc(p.name) + '</span>'}</div>
        <div class="pc-sec"><h4>contribution</h4><div class="pc-stats">
          <div class="pc-stat"><div class="v">${xp.awards.memory_write || 0}</div><div class="k">memory writes</div></div>
          <div class="pc-stat"><div class="v">${msgs}</div><div class="k">#office msgs</div></div>
          <div class="pc-stat"><div class="v">${(xp.awards.chat_done || 0) + (xp.awards.task_done || 0)}</div><div class="k">closed work</div></div>
        </div></div>
        <div class="pc-foot">XP table v1 — balancing pass coming. Memory-store writes weigh most: knowledge compounds.</div>`;
    }
    document.getElementById('pcCard').innerHTML = html;
    document.getElementById('pcView').classList.remove('hidden');
  }
  window.openPlayerCard = openCard;

  // Ride on the existing click handlers: sidebar behavior stays, card pops on top.
  const origAgent = window.selectAgent;
  window.selectAgent = (id) => { origAgent?.(id); if (id) openCard('agent', id); };
  const origPerson = window.selectPerson;
  window.selectPerson = (id) => { origPerson?.(id); if (id) openCard('person', id); };
})();
