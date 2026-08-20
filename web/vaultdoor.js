/* BRAIN VAULT access panel — the keypad on the vault door. Identification
   required before the door opens: your NAME + PASSWORD (default 123,
   validated by POST /api/vault/unlock). On ACCESS GRANTED the door unlocks
   for THIS viewer (OfficeFloor.setVaultUnlocked → walk grid reopens; kept
   in sessionStorage). Self-contained: injects its own styles + DOM. */
'use strict';

(() => {
  const css = `
  #vdView { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center;
    background: rgba(8, 10, 14, 0.6); backdrop-filter: blur(3px); }
  #vdView.hidden { display: none !important; }
  .vd-card { width: min(360px, 92vw); border-radius: 14px; padding: 22px 22px 18px;
    background: linear-gradient(180deg, #141821, #0c0f15); color: #E9E9EC;
    border: 1px solid #2A3442; box-shadow: 0 0 0 1px rgba(110,205,225,.15), 0 0 40px rgba(110,205,225,.12), 0 24px 60px rgba(0,0,0,.6);
    font-family: "JetBrains Mono", ui-monospace, monospace; }
  .vd-card.shake { animation: vdShake .3s; }
  @keyframes vdShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-7px)} 75%{transform:translateX(7px)} }
  .vd-title { font-size: 13px; font-weight: 700; letter-spacing: .18em; color: #6ECDE1; display: flex; align-items: center; gap: 8px; }
  .vd-title .dot { width: 8px; height: 8px; border-radius: 999px; background: #E5867E; animation: vdBlink 1.1s infinite; }
  @keyframes vdBlink { 50% { opacity: .25; } }
  .vd-sub { margin-top: 6px; font-size: 10.5px; color: #6E7686; letter-spacing: .06em; }
  .vd-field { margin-top: 14px; }
  .vd-field label { display: block; font-size: 9.5px; letter-spacing: .14em; color: #6E7686; margin-bottom: 5px; }
  .vd-field input { width: 100%; box-sizing: border-box; background: #0a0d12; color: #CFF3FA;
    border: 1px solid #263140; border-radius: 8px; padding: 9px 11px; font-family: inherit; font-size: 13px; letter-spacing: .08em; }
  .vd-field input:focus { outline: none; border-color: #6ECDE1; box-shadow: 0 0 0 3px rgba(110,205,225,.14); }
  .vd-hint { margin-top: 8px; font-size: 10px; color: #4C5566; }
  .vd-row { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
  .vd-btn { flex: 1; cursor: pointer; border: 1px solid #2E5A66; border-radius: 8px; padding: 9px 0;
    background: linear-gradient(180deg, #14424d, #0e3038); color: #9FE8F5; font-family: inherit;
    font-size: 12px; font-weight: 700; letter-spacing: .16em; }
  .vd-btn:hover { border-color: #6ECDE1; color: #fff; }
  .vd-x { cursor: pointer; border: 1px solid #263140; background: none; border-radius: 8px; padding: 9px 13px;
    color: #6E7686; font-family: inherit; font-size: 12px; }
  .vd-x:hover { color: #E9E9EC; }
  .vd-status { margin-top: 12px; min-height: 16px; font-size: 11px; letter-spacing: .12em; }
  .vd-status.ok { color: #6CBD92; }
  .vd-status.bad { color: #E5867E; }`;

  function ensureDom() {
    if (document.getElementById('vdView')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const view = document.createElement('div');
    view.id = 'vdView';
    view.className = 'hidden';
    view.innerHTML = `
      <div class="vd-card" id="vdCard">
        <div class="vd-title"><span class="dot" id="vdDot"></span>BRAIN VAULT · ACCESS CONTROL</div>
        <div class="vd-sub">IDENTIFICATION REQUIRED — AUTHORIZED PERSONNEL ONLY</div>
        <div class="vd-field"><label>NAME</label><input id="vdName" autocomplete="off" spellcheck="false" placeholder="lee"></div>
        <div class="vd-field"><label>PASSWORD</label><input id="vdPass" type="password" autocomplete="off" placeholder="•••"></div>
        <div class="vd-hint">default password: 123</div>
        <div class="vd-row">
          <button class="vd-btn" id="vdAuth">AUTHENTICATE</button>
          <button class="vd-x" id="vdCancel">✕</button>
        </div>
        <div class="vd-status" id="vdStatus"></div>
      </div>`;
    document.body.appendChild(view);
    view.addEventListener('click', (e) => { if (e.target === view) close(); });
    document.getElementById('vdCancel').onclick = close;
    document.getElementById('vdAuth').onclick = auth;
    for (const id of ['vdName', 'vdPass']) {
      document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') auth(); });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !view.classList.contains('hidden')) close();
    });
  }

  function open() {
    ensureDom();
    document.getElementById('vdView').classList.remove('hidden');
    document.getElementById('vdStatus').textContent = '';
    document.getElementById('vdStatus').className = 'vd-status';
    // prefill the viewer's own character name
    const me = (typeof S !== 'undefined') && S.people?.find((p) => p.id === S.me);
    if (me) document.getElementById('vdName').value = me.name;
    setTimeout(() => document.getElementById(me ? 'vdPass' : 'vdName').focus(), 0);
  }
  function close() { document.getElementById('vdView')?.classList.add('hidden'); }

  async function auth() {
    const name = document.getElementById('vdName').value.trim();
    const password = document.getElementById('vdPass').value;
    const status = document.getElementById('vdStatus');
    if (!name) { status.className = 'vd-status bad'; status.textContent = 'ENTER YOUR NAME'; return; }
    status.className = 'vd-status'; status.textContent = 'VERIFYING…';
    try {
      const r = await fetch('/api/vault/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'ACCESS DENIED');
      status.className = 'vd-status ok'; status.textContent = '✓ ACCESS GRANTED — DOOR UNLOCKED';
      document.getElementById('vdDot').style.background = '#6CBD92';
      OfficeFloor.setVaultUnlocked?.(true);
      setTimeout(close, 900);
    } catch (e) {
      status.className = 'vd-status bad'; status.textContent = `✗ ${e.message}`;
      const card = document.getElementById('vdCard');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      document.getElementById('vdPass').value = '';
      document.getElementById('vdPass').focus();
    }
  }

  window.openVaultDoor = open;
})();
