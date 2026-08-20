/* Live graph view — agents as soft square nodes, messages as
   act-colored weighted edges with traveling pulses. SVG, no deps.
   Minimal dot-grid paper, act-color legend, day/night aware. */
'use strict';

const LiveGraph = (() => {
  const ACT_COLORS = {
    request: '#4F9FAF', question: '#9482D3', inform: '#DCC58C',
    ack: '#5CA97A', escalate: '#D96A62',
  };
  const STATUS_COLORS = { idle: '#A199AB', thinking: '#4F9FAF', working: '#DCAB3C' };
  // resolved per draw() so day/night switches apply live
  function themeColors() {
    return document.documentElement.dataset.theme === 'dark'
      ? { paper: '#17181C', dot: '#26272D', ink: '#0B0C0E', text: '#C6C7CD', muted: '#6E6F76' }
      : { paper: '#FAFAF8', dot: '#E2E1DC', ink: '#1E1F22', text: '#3F4045', muted: '#8A8B92' };
  }

  let svg, S;
  let edges = new Map();     // "a|b" sorted pair -> {a, b, weight, lastAct, lastTs}
  let pulses = [];           // {from, to, act, born, dur}
  let positions = new Map(); // nodeId -> {x, y}
  let selectedId = null;
  let needsLayout = true;

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  function init(el, state) {
    svg = el; S = state;
    // rebuild edge weights from the event backlog
    for (const ev of S.events) if (ev.type === 'message_sent') addEdge(ev.message, true);
    svg.addEventListener('click', (ev) => {
      const g = ev.target.closest('[data-node]');
      window.selectAgent(g ? (g.dataset.node === 'user' ? null : g.dataset.node) : null);
    });
  }

  function addEdge(m, silent) {
    if (m.from === m.to) return;
    const k = pairKey(m.from, m.to);
    const e = edges.get(k) || { a: m.from, b: m.to, weight: 0 };
    e.weight++; e.lastAct = m.act; e.lastTs = m.ts;
    edges.set(k, e);
    if (!silent) pulses.push({ from: m.from, to: m.to, act: m.act, born: performance.now(), dur: 900 });
  }

  function layout(w, h) {
    positions.clear();
    const cx = w / 2, cy = h / 2 - 20;
    const orch = S.agents.find((a) => a.isOrchestrator);
    if (orch) positions.set(orch.id, { x: cx, y: cy });
    positions.set('user', { x: cx, y: h - 70 });
    const rest = S.agents.filter((a) => !a.isOrchestrator);
    const R = Math.min(w, h) * 0.33;
    rest.forEach((a, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(rest.length, 3);
      positions.set(a.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
    });
  }

  function nodeSize(id) {
    let deg = 0;
    for (const e of edges.values()) if (e.a === id || e.b === id) deg += Math.min(e.weight, 4);
    const base = id === 'user' ? 24 : (S.agents.find((a) => a.id === id)?.isOrchestrator ? 30 : 22);
    return base + Math.min(deg, 10);
  }

  function draw(now) {
    if (!svg || svg.classList.contains('hidden')) return;
    const r = svg.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (needsLayout || !positions.size) { layout(w, h); needsLayout = false; }

    const T = themeColors();
    const INK = T.ink;
    const parts = [];
    // paper + dot grid
    parts.push(`<rect width="100%" height="100%" fill="${T.paper}"/>`);
    parts.push(`<defs><pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${T.dot}"/></pattern></defs>
      <rect width="100%" height="100%" fill="url(#dots)"/>`);

    // edges
    for (const e of edges.values()) {
      const p1 = positions.get(e.a), p2 = positions.get(e.b);
      if (!p1 || !p2) continue;
      const color = ACT_COLORS[e.lastAct] || '#A899B5';
      const width = 1 + Math.min(e.weight, 4) * 0.6;
      const dim = selectedId && e.a !== selectedId && e.b !== selectedId;
      parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"
        stroke="${color}" stroke-width="${width}" opacity="${dim ? 0.12 : 0.85}"/>`);
    }

    // traveling pulses
    const alive = [];
    for (const p of pulses) {
      const t = (now - p.born) / p.dur;
      if (t >= 1) continue;
      alive.push(p);
      const p1 = positions.get(p.from), p2 = positions.get(p.to);
      if (!p1 || !p2) continue;
      const x = p1.x + (p2.x - p1.x) * t, y = p1.y + (p2.y - p1.y) * t;
      parts.push(`<rect x="${x - 4}" y="${y - 3}" width="8" height="6"
        fill="${ACT_COLORS[p.act] || '#F4E9C7'}" stroke="${INK}" stroke-width="1"/>`);
    }
    pulses = alive;

    // nodes: user + agents
    const nodes = [{ id: 'user', name: 'YOU', color: '#F4E9C7', status: null, orch: false },
      ...S.agents.map((a) => ({ id: a.id, name: a.name, color: a.color, status: a.status, orch: a.isOrchestrator }))];
    for (const n of nodes) {
      const pos = positions.get(n.id);
      if (!pos) continue;
      const s = nodeSize(n.id);
      const x = pos.x - s / 2, y = pos.y - s / 2;
      const dim = selectedId && n.id !== selectedId && !isNeighbor(n.id, selectedId);
      parts.push(`<g data-node="${n.id}" style="cursor:pointer" opacity="${dim ? 0.25 : 1}">`);
      parts.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="6" fill="${n.color}"
        stroke="${INK}" stroke-width="${n.orch ? 2 : 1.5}" stroke-opacity="0.35"/>`);
      if (n.orch || n.id === 'user') parts.push(`<rect x="${x + 3}" y="${y + 3}" width="${s - 6}" height="${s - 6}" rx="4"
        fill="none" stroke="${INK}" stroke-width="1" stroke-opacity="0.3"/>`);
      if (n.status) {
        const sc = STATUS_COLORS[n.status] || '#A199AB';
        parts.push(`<rect x="${x - 3}" y="${y - 3}" width="${s + 6}" height="${s + 6}" rx="8"
          fill="none" stroke="${sc}" stroke-width="1.5"/>`);
      }
      if (n.id === selectedId) parts.push(`<rect x="${x - 6}" y="${y - 6}" width="${s + 12}" height="${s + 12}" rx="10"
        fill="none" stroke="${T.text}" stroke-width="1" stroke-dasharray="3 2"/>`);
      parts.push(`<text x="${pos.x}" y="${y + s + 14}" text-anchor="middle"
        font-family="JetBrains Mono, monospace" font-size="10" fill="${T.text}">${escapeXml(n.name.slice(0, 16))}</text>`);
      parts.push(`</g>`);
    }

    // legend
    const acts = Object.entries(ACT_COLORS);
    parts.push(`<g transform="translate(14, ${h - 20 - acts.length * 14})">`);
    parts.push(`<text x="0" y="-6" font-family="Inter, sans-serif" font-weight="600" font-size="8" letter-spacing="1" fill="${T.muted}">MESSAGE ACTS</text>`);
    acts.forEach(([act, color], i) => {
      parts.push(`<rect x="0" y="${i * 14}" width="9" height="3" rx="1.5" fill="${color}"/>
        <text x="14" y="${i * 14 + 5}" font-family="JetBrains Mono, monospace" font-size="9" fill="${T.text}">${act}</text>`);
    });
    parts.push(`</g>`);

    if (!edges.size) {
      parts.push(`<text x="${w / 2}" y="${h / 2}" text-anchor="middle"
        font-family="JetBrains Mono, monospace" font-size="12" fill="${T.muted}">No messages yet — the office is quiet. Give someone a task.</text>`);
    }

    svg.innerHTML = parts.join('');
  }

  function isNeighbor(id, sel) {
    for (const e of edges.values()) if ((e.a === id && e.b === sel) || (e.b === id && e.a === sel)) return true;
    return false;
  }

  function escapeXml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  return {
    init, draw,
    onMessage: (m) => addEdge(m),
    onRosterChange: () => { needsLayout = true; },
    setSelected: (id) => { selectedId = id; },
  };
})();
