/* Live graph view — the UNIFIED office network: runtime agents, external
   agents (cross-machine, presence-driven), and the humans, in one picture.
   Squares = agents, circles = people. Edges come from router DM traffic AND
   #office interactions (reply threads + @mentions). SVG, no deps.
   Minimal dot-grid paper, act-color legend, day/night aware. */
'use strict';

const LiveGraph = (() => {
  const ACT_COLORS = {
    request: '#4F9FAF', question: '#9482D3', inform: '#DCC58C',
    ack: '#5CA97A', escalate: '#D96A62',
    thread: '#8E9BC0', mention: '#DCAB3C',
  };
  const STATUS_COLORS = { idle: '#A199AB', thinking: '#4F9FAF', working: '#DCAB3C', online: '#5CA97A' };
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
    // rebuild edge weights from the backlogs: router DMs + #office chat
    for (const ev of S.events) if (ev.type === 'message_sent') addEdge(ev.message, true);
    for (const m of S.chatroom || []) addChatEdges(m, true);
    svg.addEventListener('click', (ev) => {
      const g = ev.target.closest('[data-node]');
      if (!g || g.dataset.node === 'user') return window.selectAgent(null);
      if (g.dataset.kind === 'person') window.selectPerson?.(g.dataset.node);
      else window.selectAgent(g.dataset.node);
    });
  }

  function addPair(a, b, act, ts, silent) {
    if (!a || !b || a === b) return;
    const k = pairKey(a, b);
    const e = edges.get(k) || { a, b, weight: 0 };
    e.weight++; e.lastAct = act; e.lastTs = ts;
    edges.set(k, e);
    if (!silent) pulses.push({ from: a, to: b, act, born: performance.now(), dur: 900 });
  }

  function addEdge(m, silent) { addPair(m.from, m.to, m.act, m.ts, silent); }

  // Chat interactions are edges too: a threaded reply links the two authors,
  // a @mention links the author to the mentioned agent or person.
  function chatNode(m) {
    if (!m || m.from === 'alex-sync') return null;   // sync feed is ambient, not a speaker
    return m.fromKind === 'user' ? 'user' : m.from;
  }
  function addChatEdges(m, silent) {
    const src = chatNode(m);
    if (!src) return;
    if (m.replyTo) {
      const parent = (S.chatroom || []).find((x) => x.id === m.replyTo);
      addPair(src, chatNode(parent), 'thread', m.ts, silent);
    }
    for (const to of m.mentions || []) addPair(src, to, 'mention', m.ts, silent);
    for (const to of m.personMentions || []) addPair(src, to, 'mention', m.ts, silent);
  }

  function allNodes() {
    return [
      { id: 'user', name: 'YOU', color: '#F4E9C7', kind: 'user' },
      ...S.people.map((p) => ({
        id: p.id, name: p.name, kind: 'person',
        color: p.appearance?.shirt || '#8E90A0', online: p.online,
      })),
      ...S.agents.map((a) => ({
        id: a.id, name: a.name, kind: 'agent', color: a.color,
        status: a.status, orch: a.isOrchestrator, external: !!a.external,
      })),
    ];
  }

  function layout(w, h) {
    positions.clear();
    const cx = w / 2, cy = h / 2 - 16;
    const orch = S.agents.find((a) => a.isOrchestrator);
    if (orch) positions.set(orch.id, { x: cx, y: cy });
    positions.set('user', { x: cx, y: h - 64 });
    // humans on the inner ring, every other agent on the outer ring
    const R1 = Math.min(w, h) * 0.18, R2 = Math.min(w, h) * 0.38;
    S.people.forEach((p, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(S.people.length, 3);
      positions.set(p.id, { x: cx + R1 * Math.cos(angle), y: cy + R1 * Math.sin(angle) });
    });
    const rest = S.agents.filter((a) => !a.isOrchestrator);
    rest.forEach((a, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(rest.length, 3);
      positions.set(a.id, { x: cx + R2 * Math.cos(angle), y: cy + R2 * Math.sin(angle) });
    });
  }

  function nodeSize(id) {
    let deg = 0;
    for (const e of edges.values()) if (e.a === id || e.b === id) deg += Math.min(e.weight, 4);
    const a = S.agents.find((x) => x.id === id);
    const base = id === 'user' ? 24 : a?.isOrchestrator ? 30 : a ? 20 : 24;
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
      const dash = (e.lastAct === 'thread' || e.lastAct === 'mention') ? ' stroke-dasharray="4 3"' : '';
      parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"
        stroke="${color}" stroke-width="${width}" opacity="${dim ? 0.12 : 0.8}"${dash}/>`);
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

    // nodes: YOU + people (circles) + agents (squares)
    for (const n of allNodes()) {
      const pos = positions.get(n.id);
      if (!pos) continue;
      const s = nodeSize(n.id);
      const x = pos.x - s / 2, y = pos.y - s / 2;
      const dim = selectedId && n.id !== selectedId && !isNeighbor(n.id, selectedId);
      parts.push(`<g data-node="${n.id}" data-kind="${n.kind}" style="cursor:pointer" opacity="${dim ? 0.25 : 1}">`);
      if (n.kind === 'person') {
        parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${s / 2}" fill="${n.color}"
          stroke="${INK}" stroke-width="1.5" stroke-opacity="0.35"/>`);
        if (n.online) parts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${s / 2 + 3}"
          fill="none" stroke="${STATUS_COLORS.online}" stroke-width="1.5"/>`);
      } else {
        parts.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="6" fill="${n.color}"
          stroke="${INK}" stroke-width="${n.orch ? 2 : 1.5}" stroke-opacity="0.35"${n.external ? ' fill-opacity="0.75"' : ''}/>`);
        if (n.orch || n.id === 'user') parts.push(`<rect x="${x + 3}" y="${y + 3}" width="${s - 6}" height="${s - 6}" rx="4"
          fill="none" stroke="${INK}" stroke-width="1" stroke-opacity="0.3"/>`);
        if (n.external) {
          // cross-machine agent: presence dot instead of a status ring
          parts.push(`<circle cx="${x + s}" cy="${y}" r="3.5"
            fill="${n.status === 'online' ? STATUS_COLORS.online : T.muted}" stroke="${T.paper}" stroke-width="1.5"/>`);
        } else if (n.status && n.kind === 'agent') {
          const sc = STATUS_COLORS[n.status] || '#A199AB';
          parts.push(`<rect x="${x - 3}" y="${y - 3}" width="${s + 6}" height="${s + 6}" rx="8"
            fill="none" stroke="${sc}" stroke-width="1.5"/>`);
        }
      }
      if (n.id === selectedId) parts.push(`<rect x="${x - 6}" y="${y - 6}" width="${s + 12}" height="${s + 12}" rx="10"
        fill="none" stroke="${T.text}" stroke-width="1" stroke-dasharray="3 2"/>`);
      parts.push(`<text x="${pos.x}" y="${y + s + 13}" text-anchor="middle"
        font-family="JetBrains Mono, monospace" font-size="9.5" fill="${T.text}">${escapeXml(n.name.slice(0, 14))}</text>`);
      parts.push(`</g>`);
    }

    // legend: message acts + chat edge types
    const acts = Object.entries(ACT_COLORS);
    parts.push(`<g transform="translate(14, ${h - 20 - acts.length * 14})">`);
    parts.push(`<text x="0" y="-6" font-family="Inter, sans-serif" font-weight="600" font-size="8" letter-spacing="1" fill="${T.muted}">EDGES · DM ACTS + #OFFICE</text>`);
    acts.forEach(([act, color], i) => {
      parts.push(`<rect x="0" y="${i * 14}" width="9" height="3" rx="1.5" fill="${color}"/>
        <text x="14" y="${i * 14 + 5}" font-family="JetBrains Mono, monospace" font-size="9" fill="${T.text}">${act}</text>`);
    });
    parts.push(`</g>`);
    parts.push(`<g transform="translate(14, 18)">
      <rect x="0" y="-7" width="9" height="9" rx="3" fill="${T.muted}"/><text x="14" y="1" font-family="JetBrains Mono, monospace" font-size="9" fill="${T.text}">agent</text>
      <circle cx="4.5" cy="12" r="4.5" fill="${T.muted}"/><text x="14" y="15" font-family="JetBrains Mono, monospace" font-size="9" fill="${T.text}">human</text>
    </g>`);

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
    onChat: (m) => addChatEdges(m),
    onRosterChange: () => { needsLayout = true; },
    setSelected: (id) => { selectedId = id; },
  };
})();
