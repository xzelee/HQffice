/* Office floor v2 — multiplayer edition.
   Renders the server-defined map (personal rooms, meeting room, cafeteria,
   hot desks), Claude agents at their desks, AND real teammates as playable
   characters: arrow-key/WASD + click-to-walk movement (Gather-style),
   presence, say-bubbles, and live Claude Code session indicators.
   All art procedural; 16px tiles. */
'use strict';

const OfficeFloor = (() => {
  const TILE = 16;
  const AGENT_SPEED = 48, HUMAN_SPEED = 88;   // px/sec
  const IDLE_LINGER = 30, DESK_REST = 30;

  const ACT_COLORS = {
    request: '#4F9FAF', question: '#9482D3', inform: '#F4E9C7',
    ack: '#5CA97A', escalate: '#D96A62',
  };
  const INK = '#1A1320', CREAM = '#FFFDF5', LEMON = '#DCAB3C';
  const SKINS = ['#E8C39E', '#D9A97C', '#B67F52', '#8A5A34'];
  const HAIRS = ['#4a3527', '#1A1320', '#B0623C', '#DCAB3C', '#8a8f98'];
  const HAIR_STYLES = ['short', 'long', 'spiky', 'buzz'];

  let canvas, ctx, S, M;                 // M = S.map from the server
  let GRID_W = 46, GRID_H = 28, WORLD_W, WORLD_H;
  let walk = null;
  let cast = new Map();                  // agentId -> agent sim
  let crowd = new Map();                 // personId -> person sim
  let envelopes = [];
  let selectedId = null;
  let lastT = 0;
  let me = null;                         // my personId
  const keys = new Set();

  // ------------------------------------------------------------- helpers
  const feetX = (tx) => tx * TILE + 8;
  const feetY = (ty) => ty * TILE + 16;
  const tileOf = (c) => ({ x: Math.round((c.x - 8) / TILE), y: Math.round((c.y - 16) / TILE) });
  function hash(str) { let h = 0; for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

  // ------------------------------------------------------------- map/walk
  function inMeeting(tx, ty) {
    const m = M.meeting;
    return tx > m.x0 && tx < m.x1 && ty > m.y0 && ty < m.y1;
  }

  function buildWalkGrid() {
    GRID_W = M.w; GRID_H = M.h;
    WORLD_W = GRID_W * TILE; WORLD_H = GRID_H * TILE;
    walk = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(true));
    const block = (x, y) => { if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) walk[y][x] = false; };
    // perimeter
    for (let x = 0; x < GRID_W; x++) { block(x, 0); block(x, GRID_H - 1); }
    for (let y = 0; y < GRID_H; y++) { block(0, y); block(GRID_W - 1, y); }
    walk[GRID_H - 1][M.entrance.x] = true; walk[GRID_H - 1][M.entrance.x + 1] = true;
    // personal rooms: dividing walls + bottom wall with a door
    for (const r of M.rooms) {
      for (let y = 1; y <= r.door.y; y++) block(r.x1 + 1, y);
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) block(x, r.door.y);
      walk[r.door.y][r.door.x] = true; walk[r.door.y][r.door.x + 1] = true;
      block(r.ownerDesk.x, r.ownerDesk.y - 1);              // desk furniture
      for (const d of r.agentDesks) block(d.x, d.y - 1);
    }
    // meeting room walls + door + table
    const m = M.meeting;
    for (let x = m.x0; x <= m.x1; x++) { block(x, m.y0); block(x, m.y1); }
    for (let y = m.y0; y <= m.y1; y++) { block(m.x0, y); block(m.x1, y); }
    walk[m.door.y][m.x0] = true; walk[m.door.y + 1][m.x0] = true;
    for (let x = m.table.x0; x <= m.table.x1; x++) for (let y = m.table.y0; y <= m.table.y1; y++) block(x, y);
    // cafeteria fixtures
    const c = M.cafe;
    for (let y = c.y0; y <= c.y0 + 3; y++) block(c.x1, y);
    block(c.x0 + 2, c.y0 + 3); block(c.x0 + 3, c.y0 + 3);
    block(c.x0 + 2, c.y0 + 5); block(c.x0 + 3, c.y0 + 5);
    // hot desks + front desk furniture
    for (const d of M.hotDesks) block(d.x, d.y - 1);
    block(M.frontDesk.x, M.frontDesk.y - 1);
    // plants + data archive (server rack + brain core)
    block(2, GRID_H - 3); block(33, 9); block(35, 9);
  }

  function walkable(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H && walk[y][x]; }

  function findPath(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    if (!walkable(tx, ty)) return null;
    const key = (x, y) => y * GRID_W + x;
    const prev = new Map([[key(sx, sy), null]]);
    const q = [[sx, sy]];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (!walkable(nx, ny) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), [x, y]);
        if (nx === tx && ny === ty) {
          const path = [[nx, ny]];
          let cur = [x, y];
          while (cur) { path.unshift(cur); cur = prev.get(key(cur[0], cur[1])); }
          path.shift();
          return path;
        }
        q.push([nx, ny]);
      }
    }
    return null;
  }

  // ------------------------------------------------------------- cast sync
  function agentAppearance(a) {
    const h = hash(a.id);
    return {
      skin: SKINS[h % SKINS.length],
      hairColor: HAIRS[(h >> 3) % HAIRS.length],
      hairStyle: HAIR_STYLES[(h >> 6) % HAIR_STYLES.length],
      shirt: a.color,
      hat: 'none',
    };
  }

  function charFor(agent) {
    let c = cast.get(agent.id);
    if (!c) {
      const home = agent.desk || M.entrance;
      c = {
        id: agent.id, kind: 'agent',
        x: feetX(home.x), y: feetY(home.y),
        path: [], face: 'up', phase: Math.random() * 10,
        idleTimer: Math.random() * IDLE_LINGER, idleMode: 'rest',
        bubble: null, alpha: 0,
        look: agentAppearance(agent),
      };
      cast.set(agent.id, c);
    }
    return c;
  }

  function personFor(p) {
    let c = crowd.get(p.id);
    if (!c) {
      c = {
        id: p.id, kind: 'person',
        x: feetX(p.pos?.x ?? M.entrance.x), y: feetY(p.pos?.y ?? M.entrance.y),
        path: [], face: 'down', phase: Math.random() * 10,
        bubble: null, alpha: 0,
      };
      crowd.set(p.id, c);
    }
    return c;
  }

  function syncCast() {
    buildWalkGrid();
    const liveA = new Set(S.agents.map((a) => a.id));
    for (const id of [...cast.keys()]) if (!liveA.has(id)) cast.delete(id);
    for (const a of S.agents) charFor(a);
    const liveP = new Set(S.people.map((p) => p.id));
    for (const id of [...crowd.keys()]) if (!liveP.has(id)) crowd.delete(id);
    for (const p of S.people) personFor(p);
  }

  function setDestination(c, tx, ty) {
    const cur = tileOf(c);
    const p = findPath(cur.x, cur.y, tx, ty);
    if (p) c.path = p.map(([x, y]) => ({ x: feetX(x), y: feetY(y) }));
  }

  function randomWalkableNear(tx, ty, r) {
    for (let i = 0; i < 14; i++) {
      const x = tx + Math.floor((Math.random() * 2 - 1) * r);
      const y = ty + Math.floor((Math.random() * 2 - 1) * r);
      if (walkable(x, y)) return { x, y };
    }
    return null;
  }

  // ------------------------------------------------------------- ticking
  function tickAgent(agent, c, dt, now) {
    c.alpha = Math.min(1, c.alpha + dt / 0.5);
    const busy = agent.status === 'thinking' || agent.status === 'working';
    const deskT = agent.desk || M.entrance;
    const atDesk = Math.abs(c.x - feetX(deskT.x)) < 2 && Math.abs(c.y - feetY(deskT.y)) < 2;

    if (busy) {
      if (!atDesk && c.path.length === 0) setDestination(c, deskT.x, deskT.y);
    } else {
      c.idleTimer -= dt;
      if (c.idleTimer <= 0) {
        c.idleMode = c.idleMode === 'rest' ? 'roam' : 'rest';
        c.idleTimer = c.idleMode === 'rest' ? DESK_REST : IDLE_LINGER;
        if (c.idleMode === 'rest') setDestination(c, deskT.x, deskT.y);
      }
      if (c.idleMode === 'roam' && c.path.length === 0 && Math.random() < dt / 2.5) {
        const t = Math.random() < 0.2
          ? randomWalkableNear(M.cafe.x0 + 3, M.cafe.y0 + 3, 3)
          : randomWalkableNear(deskT.x, deskT.y, 5);
        if (t) setDestination(c, t.x, t.y);
      }
    }
    advance(c, dt, AGENT_SPEED);
    if (!c.path.length && atDesk) c.face = 'up';
    if (c.bubble && now - c.bubble.born > c.bubble.life) c.bubble = null;
  }

  function tickPerson(p, c, dt, now) {
    c.alpha = Math.min(1, c.alpha + dt / 0.4);
    if (p.id === me) {
      // keyboard steering: continue in held direction when idle on a tile
      if (c.path.length === 0) {
        const dir = keys.has('ArrowUp') || keys.has('w') ? [0, -1]
          : keys.has('ArrowDown') || keys.has('s') ? [0, 1]
            : keys.has('ArrowLeft') || keys.has('a') ? [-1, 0]
              : keys.has('ArrowRight') || keys.has('d') ? [1, 0] : null;
        if (dir) {
          const cur = tileOf(c);
          const nx = cur.x + dir[0], ny = cur.y + dir[1];
          if (walkable(nx, ny)) c.path = [{ x: feetX(nx), y: feetY(ny) }];
          c.face = dir[1] < 0 ? 'up' : dir[1] > 0 ? 'down' : dir[0] < 0 ? 'left' : 'right';
        }
      }
      const before = tileOf(c);
      advance(c, dt, HUMAN_SPEED);
      const after = tileOf(c);
      if ((before.x !== after.x || before.y !== after.y) && window.sendPersonMove) {
        window.sendPersonMove(after.x, after.y, c.face);
      }
    } else {
      // remote: lerp toward last reported tile
      const target = { x: feetX(p.pos?.x ?? M.entrance.x), y: feetY(p.pos?.y ?? M.entrance.y) };
      if (Math.hypot(target.x - c.x, target.y - c.y) > 1 && c.path.length === 0) c.path = [target];
      advance(c, dt, HUMAN_SPEED);
    }
    if (c.bubble && now - c.bubble.born > c.bubble.life) c.bubble = null;
  }

  function advance(c, dt, speed) {
    if (!c.path.length) return;
    const t = c.path[0];
    const dx = t.x - c.x, dy = t.y - c.y;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= step) { c.x = t.x; c.y = t.y; c.path.shift(); }
    else { c.x += (dx / dist) * step; c.y += (dy / dist) * step; }
    if (dist > 0.5) c.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }

  // ------------------------------------------------------------- drawing
  function camera() {
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    const zoom = Math.min(w / WORLD_W, h / WORLD_H);
    return { zoom, ox: (w - WORLD_W * zoom) / 2, oy: (h - WORLD_H * zoom) / 2 };
  }

  function roomTint(i) {
    // lab bay tints — cool, desaturated
    const tints = ['#DCE6EE', '#DEE9E3', '#E2E1ED', '#DFE8EA', '#E7E4DB'];
    return tints[i % tints.length];
  }

  function drawMap(now) {
    // base floor — cool lab tile
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#E9ECEF' : '#E1E5EA';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    // room floors (personal lab bays)
    for (const r of M.rooms) {
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
        ctx.fillStyle = (x + y) % 2 ? roomTint(r.index) : shade(roomTint(r.index));
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    // meeting room = mission control (dark slate) + cafeteria floors
    const m = M.meeting, cf = M.cafe;
    for (let y = m.y0 + 1; y < m.y1; y++) for (let x = m.x0 + 1; x < m.x1; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#3E4652' : '#39404B';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    for (let y = cf.y0; y <= cf.y1; y++) for (let x = cf.x0; x <= cf.x1; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#EAE5DA' : '#E3DDD0';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    // walls from the walk grid — brushed steel
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      if (!walk[y][x] && isWallLike(x, y)) {
        ctx.fillStyle = '#55616E';
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        ctx.fillStyle = '#47525E'; ctx.fillRect(x * TILE, y * TILE + TILE - 4, TILE, 4);
      }
    }
    // space windows on the top wall above each lab bay
    for (const r of M.rooms) {
      const wx = Math.floor((r.x0 + r.x1) / 2) - 1;
      for (let i = 0; i < 2; i++) {
        const x = (wx + i) * TILE;
        ctx.fillStyle = '#0E1B33'; ctx.fillRect(x + 2, 3, TILE - 4, 10);
        ctx.fillStyle = 'rgba(234,242,255,0.9)';
        ctx.fillRect(x + 5, 6, 1, 1); ctx.fillRect(x + 9, 10, 1, 1); ctx.fillRect(x + 11, 5, 1, 1);
      }
    }
    // entrance — caution-striped airlock mat
    const ex = M.entrance.x * TILE, ey = (GRID_H - 1) * TILE;
    ctx.fillStyle = '#D9B23C'; ctx.fillRect(ex, ey, TILE * 2, TILE);
    ctx.fillStyle = '#2B2F36';
    for (let i = 0; i < 4; i++) ctx.fillRect(ex + 2 + i * 8, ey + 2, 4, TILE - 4);
    // mission control: console table with glowing rim + live blips
    const tx0 = m.table.x0 * TILE, ty0 = m.table.y0 * TILE;
    const tw = (m.table.x1 - m.table.x0 + 1) * TILE, th = (m.table.y1 - m.table.y0 + 1) * TILE;
    drawTable(tx0, ty0, tw, th, '#2E3640');
    ctx.strokeStyle = `rgba(110,205,225,${0.5 + 0.3 * Math.sin(now / 800)})`;
    ctx.lineWidth = 1; ctx.strokeRect(tx0 + 2.5, ty0 + 2.5, tw - 5, th - 5);
    for (let i = 0; i < 5; i++) {
      const on = Math.sin(now / 450 + i * 1.9) > 0.2;
      ctx.fillStyle = on ? '#6ECDE1' : '#465361';
      ctx.fillRect(tx0 + 6 + i * 9, ty0 + 6, 4, 3);
    }
    // telemetry wall screen across the mission-control top wall
    const sx0 = (m.x0 + 1) * TILE, sw = (m.x1 - m.x0 - 1) * TILE;
    ctx.fillStyle = '#0B1118'; ctx.fillRect(sx0 + 2, m.y0 * TILE + 2, sw - 4, 12);
    for (let i = 0; i < Math.floor((sw - 10) / 5); i++) {
      const hgt = 2 + 6 * Math.abs(Math.sin(now / 700 + i * 0.9));
      ctx.fillStyle = 'rgba(110,205,225,0.85)';
      ctx.fillRect(sx0 + 5 + i * 5, m.y0 * TILE + 13 - hgt, 3, hgt);
    }
    const meeters = S.people.filter((p) => p.online && p.pos && inMeeting(p.pos.x, p.pos.y));
    if (meeters.length >= 2) {
      const glow = 0.18 + 0.12 * Math.sin(now / 300);
      ctx.fillStyle = `rgba(110,205,225,${glow})`;
      ctx.fillRect((m.x0 + 1) * TILE, (m.y0 + 1) * TILE, (m.x1 - m.x0 - 1) * TILE, (m.y1 - m.y0 - 1) * TILE);
      pixelLabel('● BRIEFING IN PROGRESS', m.x0 * TILE + 10, m.y0 * TILE - 4, '#E58A80');
    }
    pixelLabel('MISSION CONTROL', m.x0 * TILE + 12, (m.y0 + 1) * TILE + 8, 'rgba(190,215,230,0.6)');
    pixelLabel('CAFETERIA', cf.x0 * TILE + 4, cf.y0 * TILE + 10);
    // cafeteria fixtures — steel counter + vending machine
    ctx.fillStyle = '#9AA5B1'; ctx.fillRect(cf.x1 * TILE, cf.y0 * TILE, TILE, 4 * TILE);
    ctx.fillStyle = '#1C232B'; ctx.fillRect(cf.x1 * TILE + 3, cf.y0 * TILE + 3, 10, 8);
    ctx.fillStyle = '#E5867E'; ctx.fillRect(cf.x1 * TILE + 5, cf.y0 * TILE + 5, 3, 3);
    drawTable((cf.x0 + 2) * TILE, (cf.y0 + 3) * TILE, TILE * 2, TILE);
    drawTable((cf.x0 + 2) * TILE, (cf.y0 + 5) * TILE, TILE * 2, TILE);
    // rooms: labels + desks
    for (const r of M.rooms) {
      const owner = S.people.find((p) => p.roomIndex === r.index);
      pixelLabel(owner ? `${owner.name.toUpperCase()}'S LAB` : `LAB ${r.index + 1}`, r.x0 * TILE + 3, r.y0 * TILE + 10);
      drawDesk(r.ownerDesk, owner ? (owner.sessions?.length > 0) : false, now, true);
      for (const d of r.agentDesks) if (deskOwnerAgent(d)) drawDesk(d, deskBusy(d), now);
    }
    // hot desks (only where an agent sits) + front desk
    for (const d of M.hotDesks) if (deskOwnerAgent(d)) drawDesk(d, deskBusy(d), now);
    drawDesk(M.frontDesk, deskBusy(M.frontDesk), now);
    pixelLabel('FRONT DESK', M.frontDesk.x * TILE - 10, (M.frontDesk.y - 1) * TILE - 3);
    // greenery + data archive: server rack + the project brain core
    drawPlant(2 * TILE + 8, (GRID_H - 3) * TILE + 14);
    drawRack(33, 9, now);
    drawBrainCore(35, 9, now);
  }

  function shade(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, v - 8);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  function isWallLike(x, y) {
    // walls are blocked tiles that aren't furniture (furniture drawn separately)
    if (y === 0 || y === GRID_H - 1 || x === 0 || x === GRID_W - 1) return true;
    for (const r of M.rooms) {
      if (x === r.x1 + 1 && y <= r.door.y) return true;
      if (y === r.door.y && x >= r.x0 - 1 && x <= r.x1 + 1) return true;
    }
    const m = M.meeting;
    if ((y === m.y0 || y === m.y1) && x >= m.x0 && x <= m.x1) return true;
    if ((x === m.x0 || x === m.x1) && y >= m.y0 && y <= m.y1) return true;
    return false;
  }

  function deskOwnerAgent(d) { return S.agents.find((a) => a.desk && a.desk.x === d.x && a.desk.y === d.y); }
  function deskBusy(d) {
    const a = deskOwnerAgent(d);
    if (!a) return false;
    const c = cast.get(a.id);
    return c && (a.status === 'thinking' || a.status === 'working')
      && Math.abs(c.x - feetX(d.x)) < 3 && Math.abs(c.y - feetY(d.y)) < 3;
  }

  function drawDesk(d, lit, now, isOwnerDesk = false) {
    // lab bench: white worktop, steel edge, glowing console when busy
    const dx = d.x * TILE, dy = (d.y - 1) * TILE;
    ctx.fillStyle = isOwnerDesk ? '#C4CDD6' : '#D2D9E0';
    ctx.fillRect(dx - 2, dy + 4, TILE + 4, TILE - 2);
    ctx.strokeStyle = 'rgba(30,40,52,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(dx - 1.5, dy + 4.5, TILE + 3, TILE - 3);
    ctx.fillStyle = '#1C232B'; ctx.fillRect(dx + 2, dy - 2, 12, 9);
    ctx.fillStyle = lit ? '#8FD8EA' : '#3A434F';
    ctx.fillRect(dx + 3, dy - 1, 10, 7);
    if (lit) {
      ctx.fillStyle = '#2E7D93';
      const t = now / 1000;
      for (let i = 0; i < 2; i++) {
        const ly = dy - 1 + ((t * 3.2 + i * 3.5) % 7);
        ctx.fillRect(dx + 4, ly, 6 - i * 2, 1);
      }
    }
  }

  function drawTable(x, y, w, h, color = '#D7DDE3') {
    ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(30,40,52,0.55)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  function drawPlant(x, y) {
    ctx.fillStyle = '#8D97A3'; ctx.fillRect(x - 3, y - 3, 6, 4);
    ctx.fillStyle = '#5CA97A';
    ctx.fillRect(x - 1, y - 9, 2, 6); ctx.fillRect(x - 4, y - 7, 3, 2); ctx.fillRect(x + 1, y - 8, 3, 2);
  }
  function drawBrainCore(tx, ty, now) {
    // the project brain, physically in the office: a pulsing core on a
    // pedestal. Click it to open the archive terminal (window.openBrain).
    const x = tx * TILE + 8, y = ty * TILE + 10;
    const p = (Math.sin(now / 600) + 1) / 2;
    ctx.fillStyle = '#8D97A3'; ctx.fillRect(x - 5, y - 2, 10, 6);
    ctx.fillStyle = '#6B7683'; ctx.fillRect(x - 5, y + 2, 10, 2);
    // glow halo
    ctx.fillStyle = `rgba(110,205,225,${0.10 + 0.14 * p})`;
    ctx.beginPath(); ctx.arc(x, y - 9, 8 + 2 * p, 0, Math.PI * 2); ctx.fill();
    // core orb
    ctx.fillStyle = '#6ECDE1';
    ctx.beginPath(); ctx.arc(x, y - 9, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.4 + 0.4 * p})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y - 9, 4.5, 0, Math.PI * 2); ctx.stroke();
    // synapse pixels
    ctx.fillStyle = '#9482D3';
    ctx.fillRect(x - 2, y - 11, 1.5, 1.5); ctx.fillRect(x + 0.5, y - 8.5, 1.5, 1.5); ctx.fillRect(x - 1, y - 9.5, 1, 1);
    pixelLabel('PROJECT BRAIN', x - 17, y + 12, 'rgba(78,147,166,0.75)');
  }
  function drawRack(tx, ty, now) {
    // server rack with blinking status LEDs (sits on an already-blocked tile)
    const x = tx * TILE, y = ty * TILE;
    ctx.fillStyle = '#252B33'; ctx.fillRect(x + 2, y - 8, 12, 22);
    ctx.strokeStyle = 'rgba(15,20,26,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(x + 2.5, y - 7.5, 11, 21);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = '#333B45'; ctx.fillRect(x + 4, y - 6 + i * 5, 8, 3);
      ctx.fillStyle = Math.sin(now / 300 + i * 1.7) > 0 ? '#6CBD92' : '#2E4A3C';
      ctx.fillRect(x + 10, y - 5.5 + i * 5, 1.5, 1.5);
    }
  }
  function pixelLabel(text, x, y, color = 'rgba(30,40,52,0.4)') {
    ctx.font = '5px monospace'; ctx.fillStyle = color; ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
  }

  // Rich character sprite: skin, hair style/color, shirt, hat. Humans are a
  // touch taller than agents so the two read differently at a glance.
  function drawFigure(c, look, now, opts = {}) {
    const t = now / 1000 + c.phase;
    const moving = c.path.length > 0;
    const bob = moving ? Math.sin(t * 14) * 1.2 : 0;
    const x = c.x, y = c.y + bob;
    const tall = opts.human ? 3 : 0;
    ctx.globalAlpha = c.alpha * (opts.offline ? 0.4 : 1);

    if (opts.halo) {
      const p = (Math.sin(Math.PI * (now / 600)) + 1) / 2;
      ctx.fillStyle = opts.halo;
      ctx.globalAlpha = c.alpha * (0.18 + 0.27 * p);
      ctx.beginPath(); ctx.arc(x, y - 8, 14 * (0.95 + 0.15 * p), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = c.alpha * (opts.offline ? 0.4 : 1);
    }
    if (opts.selected) {
      ctx.strokeStyle = INK; ctx.lineWidth = 1;
      ctx.strokeRect(x - 8.5, y - 22.5 - tall, 17, 25 + tall);
    }
    // shadow
    ctx.fillStyle = 'rgba(26,19,32,0.25)';
    ctx.beginPath(); ctx.ellipse(x, y, 6, 2.4, 0, 0, Math.PI * 2); ctx.fill();
    // legs
    const legShift = moving ? Math.sin(t * 14) * 2 : 0;
    ctx.fillStyle = '#3D2E4A';
    ctx.fillRect(x - 4, y - 6, 3, 6 + legShift * 0.5);
    ctx.fillRect(x + 1, y - 6, 3, 6 - legShift * 0.5);
    // body
    ctx.fillStyle = look.shirt;
    ctx.fillRect(x - 5, y - 14 - tall, 10, 9 + tall);
    ctx.strokeStyle = 'rgba(26,19,32,0.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(x - 5.5, y - 14.5 - tall, 11, 10 + tall);
    // head
    const hy = y - 21 - tall;
    ctx.fillStyle = look.skin; ctx.fillRect(x - 4, hy, 8, 7);
    // hair by style
    ctx.fillStyle = look.hairColor;
    if (look.hairStyle === 'long') {
      ctx.fillRect(x - 4, hy - 1, 8, 3);
      ctx.fillRect(x - 5, hy, 2, 7); ctx.fillRect(x + 3, hy, 2, 7);
    } else if (look.hairStyle === 'spiky') {
      ctx.fillRect(x - 4, hy - 1, 8, 2);
      for (let i = 0; i < 3; i++) ctx.fillRect(x - 3 + i * 3, hy - 3, 2, 2);
    } else if (look.hairStyle === 'buzz') {
      ctx.fillRect(x - 4, hy - 0.5, 8, 1.5);
    } else {
      ctx.fillRect(x - 4, hy - 1, 8, 3);
    }
    // hat over hair
    if (look.hat === 'cap') {
      ctx.fillStyle = shade(look.shirt);
      ctx.fillRect(x - 4, hy - 2, 8, 3);
      if (c.face !== 'up') ctx.fillRect(c.face === 'left' ? x - 6 : x - 4, hy, c.face === 'right' ? 10 : 8, 1.4);
    } else if (look.hat === 'beanie') {
      ctx.fillStyle = shade(look.shirt);
      ctx.fillRect(x - 4.5, hy - 2, 9, 4);
    }
    // eyes
    ctx.fillStyle = INK;
    if (c.face !== 'up') {
      const ex = c.face === 'left' ? -2.5 : c.face === 'right' ? 0.5 : -1;
      ctx.fillRect(x + ex - 1, hy + 3, 1.4, 1.6);
      if (c.face === 'down') ctx.fillRect(x + 1.6, hy + 3, 1.4, 1.6);
    }
    if (opts.crown) { ctx.fillStyle = LEMON; ctx.fillRect(x - 2, hy - 3, 4, 2); }
    // live-session badge above head
    if (opts.sessions > 0) {
      const pulse = 0.7 + 0.3 * Math.sin(now / 250);
      ctx.font = '600 6px monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(220,171,60,${pulse})`;
      ctx.fillText(`⚡${opts.sessions}`, x + 9, hy - 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawNameTag(name, c, color = CREAM) {
    ctx.font = '600 5.5px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(26,19,32,0.65)'; ctx.fillText(name, c.x + 0.5, c.y + 7.5);
    ctx.fillStyle = color; ctx.fillText(name, c.x, c.y + 7);
  }

  function drawBubble(status, c, now) {
    const thinking = status === 'thinking';
    let text = c.bubble?.text;
    if (!text && thinking) text = '.'.repeat(1 + Math.floor((now / 450) % 3));
    if (!text) return;
    let alpha = 1;
    if (c.bubble) {
      const age = now - c.bubble.born;
      if (age < 150) alpha = age / 150;
      else if (age > c.bubble.life - 300) alpha = Math.max(0, (c.bubble.life - age) / 300);
    }
    ctx.font = '600 6px monospace';
    const words = String(text).slice(0, 160).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > 138 && line) { lines.push(line); line = w; }
      else line = test;
      if (lines.length >= 4) break;
    }
    if (line && lines.length < 4) lines.push(line);
    const bw = Math.min(150, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12);
    const bh = lines.length * 8 + 6;
    let bx = c.x - bw / 2, by = c.y - 40 - bh;
    bx = Math.max(2, Math.min(WORLD_W - bw - 2, bx));
    by = Math.max(2, by);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = CREAM; ctx.strokeStyle = INK; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx + bw * 0.32, by + bh + 4, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3D2E4A'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + 10 + i * 8));
    ctx.globalAlpha = 1;
  }

  function drawEnvelopes(now) {
    for (const e of envelopes) {
      const t = Math.min(1, (now - e.born) / e.dur);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = e.x0 + (e.x1 - e.x0) * ease;
      const y = e.y0 + (e.y1 - e.y0) * ease - Math.sin(Math.PI * ease) * 38 - 22;
      if (t >= 1) {
        const bt = (now - e.born - e.dur) / 340;
        if (bt < 1) {
          ctx.strokeStyle = LEMON; ctx.lineWidth = 2; ctx.globalAlpha = 1 - bt;
          ctx.beginPath(); ctx.arc(e.x1, e.y1 - 12, 3 + 12 * bt, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        continue;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin((now / 1000) * 6) * 0.12);
      ctx.globalAlpha = Math.min(1, (now - e.born) / 140);
      ctx.fillStyle = e.color; ctx.strokeStyle = INK; ctx.lineWidth = 1;
      ctx.fillRect(-7, -5, 14, 10); ctx.strokeRect(-7, -5, 14, 10);
      ctx.beginPath(); ctx.moveTo(-7, -5); ctx.lineTo(0, 0); ctx.lineTo(7, -5); ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    envelopes = envelopes.filter((e) => now - e.born < e.dur + 360);
  }

  // ------------------------------------------------------------- API
  function init(cnv, state) {
    canvas = cnv; ctx = canvas.getContext('2d');
    S = state; M = S.map;
    syncCast();
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * devicePixelRatio);
      canvas.height = Math.max(1, r.height * devicePixelRatio);
    };
    fit();
    new ResizeObserver(fit).observe(canvas);

    canvas.addEventListener('click', (ev) => {
      const r = canvas.getBoundingClientRect();
      const cam = camera();
      const wx = (ev.clientX - r.left - cam.ox) / cam.zoom;
      const wy = (ev.clientY - r.top - cam.oy) / cam.zoom;
      // brain core terminal (fixed at tile 35,9 beside the server rack)
      if (Math.hypot(wx - (35 * TILE + 8), wy - (9 * TILE + 2)) < 14) {
        window.openBrain?.();
        return;
      }
      // nearest agent or person within reach
      let best = null, bestD = 20, bestKind = null;
      for (const a of S.agents) {
        const c = cast.get(a.id); if (!c) continue;
        const d = Math.hypot(c.x - wx, c.y - 12 - wy);
        if (d < bestD) { bestD = d; best = a.id; bestKind = 'agent'; }
      }
      for (const p of S.people) {
        const c = crowd.get(p.id); if (!c) continue;
        const d = Math.hypot(c.x - wx, c.y - 14 - wy);
        if (d < bestD) { bestD = d; best = p.id; bestKind = 'person'; }
      }
      if (bestKind === 'agent') window.selectAgent(best);
      else if (bestKind === 'person') window.selectPerson?.(best);
      else if (me) {
        // click-to-walk (Gather style)
        const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
        const c = crowd.get(me);
        if (c && walkable(tx, ty)) { const cur = tileOf(c); const p = findPath(cur.x, cur.y, tx, ty); if (p) c.path = p.map(([x, y]) => ({ x: feetX(x), y: feetY(y) })); }
        window.selectAgent(null);
      } else window.selectAgent(null);
    });

    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
        keys.add(e.key);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key));
  }

  function draw(now) {
    if (!ctx) return;
    const dt = Math.min(0.1, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const cam = camera();
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(cam.ox, cam.oy); ctx.scale(cam.zoom, cam.zoom);
    ctx.imageSmoothingEnabled = false;

    drawMap(now);

    const order = [
      ...S.agents.map((a) => ({ kind: 'agent', a, c: cast.get(a.id) })),
      ...S.people.map((p) => ({ kind: 'person', p, c: crowd.get(p.id) })),
    ].filter((x) => x.c).sort((u, v) => u.c.y - v.c.y);

    for (const o of order) o.kind === 'agent' ? tickAgent(o.a, o.c, dt, now) : tickPerson(o.p, o.c, dt, now);
    for (const o of order) {
      if (o.kind === 'agent') {
        const busy = o.a.status === 'thinking' || o.a.status === 'working';
        drawFigure(o.c, o.c.look, now, {
          halo: busy ? o.a.color : null,
          selected: o.a.id === selectedId,
          crown: o.a.isOrchestrator,
        });
        drawNameTag(o.a.name, o.c);
      } else {
        drawFigure(o.c, o.p.appearance, now, {
          human: true,
          offline: !o.p.online,
          selected: o.p.id === selectedId,
          sessions: o.p.sessions?.length || 0,
        });
        drawNameTag(o.p.name + (o.p.id === me ? ' (you)' : ''), o.c, o.p.online ? '#D2E7DA' : '#A899B5');
      }
    }
    drawEnvelopes(now);
    for (const o of order) drawBubble(o.kind === 'agent' ? o.a.status : null, o.c, now);
  }

  function onMessage(m) {
    const from = cast.get(m.from), to = cast.get(m.to);
    const x0 = from ? from.x : feetX(M.entrance.x), y0 = from ? from.y : feetY(M.entrance.y);
    const x1 = to ? to.x : feetX(M.entrance.x), y1 = to ? to.y : feetY(M.entrance.y);
    if (m.from === m.to || envelopes.length >= 16) return;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    envelopes.push({
      x0, y0, x1, y1, born: performance.now(),
      dur: Math.max(800, Math.min(2000, (dist / 230) * 1000)),
      color: ACT_COLORS[m.act] || '#F4E9C7',
    });
    const c = cast.get(m.from);
    if (c) c.bubble = { text: m.body.slice(0, 90), born: performance.now(), life: 3500 };
  }

  return {
    init, draw, onMessage,
    onNarration: (agentId, text) => {
      const c = cast.get(agentId);
      if (c) c.bubble = { text: text.slice(0, 140), born: performance.now(), life: 4200 };
    },
    onSay: (personId, text) => {
      const c = crowd.get(personId);
      if (c) c.bubble = { text: text.slice(0, 160), born: performance.now(), life: 5000 };
    },
    onSpawn: (agentId) => {
      syncCast();
      const c = cast.get(agentId);
      if (c) { c.x = feetX(M.entrance.x); c.y = feetY(M.entrance.y - 1); c.alpha = 0; }
    },
    onRosterChange: () => syncCast(),
    onPersonMoved: (personId) => { /* position read from S.people each frame */ },
    setSelected: (id) => { selectedId = id; },
    setMe: (personId) => { me = personId; },
  };
})();
