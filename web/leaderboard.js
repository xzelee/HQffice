/* HQ LEADERBOARD 🏆 — the hall billboard. Podium of top XP earners, category
   leaders, and recent level-ups. Self-contained (styles + DOM + header
   button); exposes window.openLeaderboard() so the floor's TV/billboard
   object can open it (same pattern as openBrain/openShop). Data comes
   entirely from /api/state (xp ledger + roster) — no extra endpoints.
   Auto-refreshes every 15s while open. */
'use strict';

(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const css = `
  #lbView { position: fixed; inset: 0; z-index: 65; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--bg, #111) 55%, transparent); backdrop-filter: blur(2px); }
  #lbView.hidden { display: none !important; }
  .lb-card { width: min(880px, 94vw); max-height: 88vh; overflow-y: auto; border-radius: 16px;
    background: linear-gradient(180deg, #14161c, #0d0e12); color: #E9E9EC;
    border: 1px solid #2A2B31; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  .lb-head { display: flex; align-items: baseline; gap: 12px; padding: 18px 22px 10px; }
  .lb-head b { font-size: 15px; letter-spacing: .14em; }
  .lb-head .sub { font-size: 12px; color: #83848C; }
  .lb-head .x { margin-left: auto; cursor: pointer; border: none; background: none; color: #83848C; font-size: 15px; }
  .lb-head .x:hover { color: #fff; }
  .lb-podium { display: flex; gap: 14px; align-items: flex-end; justify-content: center; padding: 12px 22px 20px; }
  .lb-pod { flex: 0 0 190px; text-align: center; border-radius: 14px; padding: 14px 10px 12px;
    background: #191b22; border: 1px solid #2A2B31; }
  .lb-pod.p1 { transform: translateY(-12px); border-color: #D2A855; box-shadow: 0 0 24px rgba(210,168,85,.15); }
  .lb-pod .medal { font-size: 22px; }
  .lb-pod .av { font-size: 30px; margin: 4px 0; }
  .lb-pod .nm { font-weight: 700; font-size: 15px; }
  .lb-pod .rl { font-size: 11px; color: #83848C; }
  .lb-pod .lv { margin-top: 6px; font-family: var(--font-mono, monospace); font-size: 12px; color: #D2A855; }
  .lb-sec { padding: 4px 22px 14px; }
  .lb-sec h4 { margin: 8px 0 8px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #83848C; }
  .lb-cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .lb-cat { background: #191b22; border: 1px solid #2A2B31; border-radius: 12px; padding: 10px 12px; }
  .lb-cat .t { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #83848C; }
  .lb-cat .w { font-weight: 700; font-size: 14px; margin-top: 3px; }
  .lb-cat .d { font-family: var(--font-mono, monospace); font-size: 11px; color: #6FB4C6; }
  .lb-rows { display: flex; flex-direction: column; }
  .lb-row { display: flex; gap: 10px; align-items: baseline; padding: 6px 4px; border-bottom: 1px solid #1e2027; font-size: 13px; }
  .lb-row .rank { flex: 0 0 26px; font-family: var(--font-mono, monospace); color: #5C5D65; }
  .lb-row .who { font-weight: 600; }
  .lb-row .kind { font-size: 11px; color: #5C5D65; }
  .lb-row .bar { flex: 1; height: 6px; border-radius: 999px; background: #23242A; overflow: hidden; align-self: center; }
  .lb-row .bar i { display: block; height: 100%; background: linear-gradient(90deg, #6FB4C6, #6CBD92); }
  .lb-row .pts { flex: 0 0 110px; text-align: right; font-family: var(--font-mono, monospace); font-size: 12px; color: #B2B3BA; }
  .lb-foot { padding: 10px 22px 16px; font-size: 10.5px; color: #5C5D65; }
  #btnLb { border: 1px solid var(--border, #ddd); background: var(--surface, #fff); color: var(--text-2, #555);
    height: 28px; padding: 0 10px; border-radius: 999px; cursor: pointer; font-size: 13px; }
  #btnLb:hover { color: var(--text, #111); border-color: var(--border-strong, #bbb); }`;

  let refreshTimer = null;

  function ensureDom() {
    if (document.getElementById('lbView')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const view = document.createElement('div');
    view.id = 'lbView';
    view.className = 'hidden';
    view.innerHTML = '<div class="lb-card" id="lbCard"></div>';
    document.body.appendChild(view);
    view.addEventListener('click', (e) => { if (e.target === view) close(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  function close() {
    document.getElementById('lbView')?.classList.add('hidden');
    clearInterval(refreshTimer);
  }

  function resolveEntity(id, d) {
    const a = (d.agents || []).find((x) => x.id === id);
    if (a) return { name: a.name, kind: a.parentId ? 'sub-agent' : 'agent', sub: a.role, avatar: a.avatar || '🤖', color: a.color };
    const p = (d.people || []).find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
    if (p) return { name: p.name, kind: 'teammate', sub: p.roomIndex != null ? `Room ${p.roomIndex + 1}` : 'roaming', avatar: '🧑‍🚀', color: p.appearance?.shirt || '#888' };
    if (id === 'user') return { name: 'dashboard user', kind: 'human', sub: '', avatar: '🖥️', color: '#888' };
    return { name: String(id), kind: 'guest', sub: 'from the HALM board', avatar: '🌐', color: '#666' };
  }

  async function render() {
    const d = await (await fetch('/api/state')).json();
    const xp = d.xp || {};
    const rows = Object.entries(xp)
      .map(([id, v]) => ({ id, ...v, ...resolveEntity(id, d) }))
      .sort((a, b) => b.xp - a.xp);
    const top = rows.slice(0, 3);
    const rest = rows.slice(3, 10);
    const maxXp = rows[0]?.xp || 1;

    const catLeader = (fn, label, icon, unit) => {
      const best = rows.map((r) => ({ r, v: fn(r) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)[0];
      return `<div class="lb-cat"><div class="t">${icon} ${esc(label)}</div>
        <div class="w">${best ? esc(best.r.name) : '—'}</div>
        <div class="d">${best ? `${best.v} ${unit}` : 'wala pa'}</div></div>`;
    };

    const medals = ['🥇', '🥈', '🥉'];
    const order = top.length === 3 ? [top[1], top[0], top[2]] : top;   // podium: 2nd, 1st, 3rd
    const levelUps = (d.events || []).filter((e) => e.type === 'level_up').slice(-4).reverse()
      .map((e) => `<span style="margin-right:14px">⬆ <b>${esc(resolveEntity(e.entityId, d).name)}</b> reached Lv ${e.level}</span>`).join('') || '<span style="color:#5C5D65">no level-ups yet today</span>';

    document.getElementById('lbCard').innerHTML = `
      <div class="lb-head"><b>🏆 HQ LEADERBOARD</b><span class="sub">live from the XP ledger · outcomes over chatter</span>
        <button class="x" id="lbClose">✕</button></div>
      <div class="lb-podium">
        ${order.map((r) => {
          const rank = top.indexOf(r);
          return `<div class="lb-pod ${rank === 0 ? 'p1' : ''}">
            <div class="medal">${medals[rank]}</div>
            <div class="av">${esc(r.avatar)}</div>
            <div class="nm" style="color:${esc(r.color)}">${esc(r.name)}</div>
            <div class="rl">${esc(r.kind)}${r.sub ? ' · ' + esc(r.sub) : ''}</div>
            <div class="lv">Lv ${r.level} · ${r.xp} XP</div>
          </div>`;
        }).join('')}
      </div>
      <div class="lb-sec"><h4>category leaders</h4><div class="lb-cats">
        ${catLeader((r) => r.awards?.memory_write || 0, 'Top Archivist', '🧠', 'memory writes')}
        ${catLeader((r) => (r.awards?.task_done || 0) + (r.awards?.chat_done || 0), 'Top Closer', '✅', 'closed')}
        ${catLeader((r) => r.awards?.skill || 0, 'Most Skilled', '🎓', 'skills')}
        ${catLeader((r) => r.awards?.spawn || 0, 'Top Recruiter', '🤝', 'hires')}
      </div></div>
      ${rest.length ? `<div class="lb-sec"><h4>the chase</h4><div class="lb-rows">
        ${rest.map((r, i) => `<div class="lb-row"><span class="rank">#${i + 4}</span>
          <span class="who" style="color:${esc(r.color)}">${esc(r.name)}</span><span class="kind">${esc(r.kind)}</span>
          <span class="bar"><i style="width:${Math.max(3, Math.round((r.xp / maxXp) * 100))}%"></i></span>
          <span class="pts">Lv ${r.level} · ${r.xp} XP</span></div>`).join('')}
      </div></div>` : ''}
      <div class="lb-sec"><h4>recent level-ups</h4><div style="font-size:12.5px">${levelUps}</div></div>
      <div class="lb-foot">XP: memory writes +25 · tasks done +30 · DONE receipts +15 · skills +20 · hires +10. Balancing pass coming — outcomes lang ang binabayaran, hindi ingay.</div>`;
    document.getElementById('lbClose').onclick = close;
  }

  function open() {
    ensureDom();
    document.getElementById('lbView').classList.remove('hidden');
    render();
    refreshTimer = setInterval(render, 15000);
  }
  window.openLeaderboard = open;

  // Header button (interim entry point — the floor billboard can call
  // window.openLeaderboard() once the designer wires the TV object).
  const btn = document.createElement('button');
  btn.id = 'btnLb';
  btn.title = 'HQ Leaderboard';
  btn.textContent = '🏆';
  btn.onclick = open;
  const anchor = document.getElementById('btnBaul') || document.getElementById('btnTheme');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
  else { btn.style.cssText += ';position:fixed;right:60px;bottom:14px;z-index:55;height:34px;font-size:16px;'; document.body.appendChild(btn); }
})();
