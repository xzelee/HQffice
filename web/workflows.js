/* Workflows view — ported from the Chatroom Lab's WORK-GRAPHS + DEPENDENCY
   GRAPH tabs, rebuilt over the #office chat ledger.

   Work-graphs: the chat log is append-only; the WORK graph is implicit in
   it. Each thread root = one workflow card; swimlanes = who spoke; dots =
   messages by time; edges TYPED by what actually connects two nodes:
     reply   — B threads onto A
     closes  — B is A's author closing A's own WILL: (promise fulfilled)
     decides — B carries a DECISION: on A (authority edge)
     blocks  — A declares BLOCKED: X ON: Y (dependency edge)
   Dependency graph: OPEN coordination state only — typed BLOCKED: x ON: y
   edges, open promises, decisions awaiting the humans. Prose draws nothing. */
'use strict';

const OfficeWorkflows = (() => {
  const EDGE = { reply: '#4F9FAF', closes: '#5CA97A', decides: '#DCAB3C', blocks: '#D96A62' };
  let el, S;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const auth = (s) => (window.chatAuthoritative ? window.chatAuthoritative(s) : String(s ?? ''));

  function init(container, state) { el = container; S = state; }

  function laneName(from, fromKind) {
    if (fromKind === 'agent') return S.agents.find((a) => a.id === from)?.name || from;
    if (from === 'user') return 'user';
    return S.people.find((p) => p.id === from)?.name || from;
  }
  // A post prefixed "[local-alex] ..." (the bridge convention for a
  // teammate's own agent) gets its OWN swimlane — the unified view shows
  // every speaking agent across every machine, not just office characters.
  function laneOf(m) {
    const pre = /^\[([\w-]{2,24})\]/.exec(m.body || '');
    if (pre) return pre[1];
    return laneName(m.from, m.fromKind);
  }

  function laneColor(from, fromKind) {
    // literal fallback (not a CSS var) — used in SVG presentation attributes;
    // mid-gray reads on both day and night paper
    if (fromKind === 'agent') return S.agents.find((a) => a.id === from)?.color || '#8E90A0';
    return '#8E90A0';
  }

  // Thread roots via replyTo chains; an orphan reply is its own root.
  function rootsOf(msgs) {
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const rootOf = (m) => {
      const seen = new Set();
      while (m.replyTo && byId.has(m.replyTo) && !seen.has(m.id)) { seen.add(m.id); m = byId.get(m.replyTo); }
      return m.id;
    };
    const map = new Map();
    for (const m of msgs) map.set(m.id, rootOf(m));
    return { rootMap: map, byId };
  }

  function buildGraphs(msgs) {
    const { rootMap, byId } = rootsOf(msgs);
    const graphs = new Map();
    for (const m of msgs) {
      const gid = rootMap.get(m.id);
      if (!graphs.has(gid)) graphs.set(gid, { id: gid, nodes: [], edges: [] });
      graphs.get(gid).nodes.push(m);
    }
    for (const m of msgs) {
      const g = graphs.get(rootMap.get(m.id));
      if (m.replyTo && byId.has(m.replyTo)) {
        const parent = byId.get(m.replyTo);
        const closes = parent.from === m.from && /^WILL:/m.test(auth(parent.body)) && /^DONE:/m.test(auth(m.body));
        g.edges.push({ from: parent.id, to: m.id, type: closes ? 'closes' : 'reply' });
        if (/^DECISION:/m.test(auth(m.body))) g.edges.push({ from: m.id, to: parent.id, type: 'decides' });
      }
      const b = auth(m.body).match(/^BLOCKED:\s*(.+?)\s+ON:\s*(.+?)\s*$/m);
      if (b && !b[1].includes('<') && !b[2].includes('<')) g.edges.push({ from: m.id, to: null, type: 'blocks', label: b[2].trim().slice(0, 30) });
    }
    // Deterministic ordering (the lab's rule: a coordination view holds
    // still) — ts desc, then stable id tiebreak so equal stamps never flip.
    return [...graphs.values()].sort((a, b) =>
      (Math.max(...b.nodes.map((n) => n.ts)) - Math.max(...a.nodes.map((n) => n.ts))) || a.id.localeCompare(b.id));
  }

  // ---------------------------------------------------------- work-graphs
  function workGraphCard(g) {
    const lanes = [];
    for (const n of g.nodes) {
      const key = laneOf(n);
      if (!lanes.some((l) => l.key === key)) lanes.push({ key, name: key, color: laneColor(n.from, n.fromKind) });
    }
    const X0 = 150, DX = 64, DY = 44, R = 6;
    const w = X0 + g.nodes.length * DX + 40, h = 26 + lanes.length * DY;
    const pos = new Map();
    const parts = [];
    // lane rows
    lanes.forEach((l, i) => {
      const y = 30 + i * DY;
      parts.push(`<text x="10" y="${y + 4}" font-family="JetBrains Mono, monospace" font-size="11" fill="${l.color}">${esc(l.name.slice(0, 18))}</text>`);
      parts.push(`<line x1="${X0 - 16}" y1="${y}" x2="${w - 14}" y2="${y}" stroke-width="1" style="stroke:var(--border)"/>`);
    });
    g.nodes.forEach((n, i) => {
      const li = lanes.findIndex((l) => l.key === laneOf(n));
      pos.set(n.id, { x: X0 + i * DX, y: 30 + li * DY });
    });
    // edges under nodes
    for (const e of g.edges) {
      const p1 = pos.get(e.from);
      if (!p1) continue;
      if (e.type === 'blocks') {
        parts.push(`<text x="${p1.x + 10}" y="${p1.y - 12}" font-family="JetBrains Mono, monospace" font-size="9" fill="${EDGE.blocks}">⛔ on: ${esc(e.label)}</text>`);
        continue;
      }
      const p2 = pos.get(e.to);
      if (!p2) continue;
      const mx = (p1.x + p2.x) / 2;
      const dash = e.type === 'decides' ? ' stroke-dasharray="4 3"' : '';
      parts.push(`<path d="M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}" fill="none" stroke="${EDGE[e.type]}" stroke-width="1.6"${dash} opacity="0.85"/>`);
    }
    // nodes on top
    for (const n of g.nodes) {
      const p = pos.get(n.id);
      const nb = auth(n.body);
      const ring = /^WILL:/m.test(nb) ? EDGE.closes : /^DECISION-NEEDED:/m.test(nb) ? EDGE.decides : null;
      if (ring) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${R + 3.5}" fill="none" stroke="${ring}" stroke-width="1.6"/>`);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${R}" fill="${laneColor(n.from, n.fromKind)}" stroke-width="1" style="stroke:var(--ink-900);stroke-opacity:.35">
        <title>[${esc(n.id)}] ${esc(laneName(n.from, n.fromKind))} · ${new Date(n.ts).toLocaleTimeString()}\n${esc(n.body.slice(0, 220))}</title></circle>`);
      parts.push(`<text x="${p.x}" y="${p.y - 12}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8" style="fill:var(--ink-300)">${esc(n.id.slice(0, 6))}</text>`);
    }
    const t0 = new Date(Math.min(...g.nodes.map((n) => n.ts)));
    return `<div class="wf-card">
      <div class="wf-title"><span class="wf-id">[${esc(g.id)}]</span> ${g.nodes.length} messages · ${g.edges.length} edges · ${lanes.length} lane${lanes.length > 1 ? 's' : ''}
        <span class="wf-when">${t0.toLocaleDateString()} ${t0.toTimeString().slice(0, 5)}</span></div>
      <div class="wf-scroll"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg></div>
    </div>`;
  }

  // ------------------------------------------------------ dependency graph
  function depGraphSVG(meta) {
    const lanes = new Map();     // owner lanes (left)
    const items = [];            // middle: blockers, promises, decisions
    const targets = new Map();   // right: blocker targets + 'user'
    const addLane = (from, kind) => {
      if (!lanes.has(from)) lanes.set(from, { id: from, name: laneName(from, kind), color: laneColor(from, kind) });
      return 'lane:' + from;
    };
    for (const b of meta.blockers || []) {
      addLane(b.from, 'agent');
      // normalized key so the same external target from different lanes
      // merges into ONE node — or convergence can never appear (lab gotcha)
      const tid = b.targetKind === 'agent' ? 'lane:' + b.target : 'ext:' + String(b.target).toLowerCase();
      if (b.targetKind === 'agent') addLane(b.target, 'agent');
      else if (!targets.has(tid)) targets.set(tid, { id: tid, label: b.target });
      items.push({ id: 'blk:' + b.id, kind: 'blocked', label: b.what, owner: 'lane:' + b.from, to: tid });
    }
    // Promise nodes deliberately EXCLUDED here (the lab builder's cut list:
    // they duplicate the rail's promise panel and bloat the middle layer —
    // the dependency graph reads best as blockers + decisions only).
    for (const d of meta.decisions || []) {
      addLane(d.from, 'agent');
      items.push({ id: 'dec:' + d.id, kind: 'decision', label: d.text, owner: 'lane:' + d.from, to: 'user' });
      if (!targets.has('user')) targets.set('user', { id: 'user', label: 'YOU', human: true });
    }
    if (!items.length) return '<div class="wf-empty">No open coordination state — nothing blocked, no unkept promises, nothing awaiting a decision. The typed line "BLOCKED: &lt;what&gt; ON: &lt;target&gt;" draws an edge here.</div>';

    const laneArr = [...lanes.values()];
    const tgtArr = [...targets.values()];
    const ROW = 54, W = 900;
    const h = 40 + Math.max(laneArr.length, items.length, tgtArr.length) * ROW;
    const posL = new Map(), posI = new Map(), posT = new Map();
    laneArr.forEach((l, i) => posL.set('lane:' + l.id, { x: 120, y: 44 + i * ROW }));
    items.forEach((it, i) => posI.set(it.id, { x: W / 2, y: 44 + i * ROW }));
    tgtArr.forEach((t, i) => posT.set(t.id, { x: W - 130, y: 44 + i * ROW }));
    const findPos = (id) => posL.get(id) || posT.get(id) || null;

    // convergence: a target with 2+ incoming blocked_on edges gets the amber ring
    const indeg = new Map();
    for (const it of items) if (it.kind === 'blocked' && it.to) indeg.set(it.to, (indeg.get(it.to) || 0) + 1);

    const parts = [];
    for (const it of items) {
      const pi = posI.get(it.id);
      const po = findPos(it.owner);
      if (po) parts.push(`<path d="M ${po.x + 46} ${po.y} C ${(po.x + pi.x) / 2} ${po.y}, ${(po.x + pi.x) / 2} ${pi.y}, ${pi.x - 86} ${pi.y}" fill="none" stroke-width="1.3" opacity="0.7" style="stroke:var(--ink-300)"/>`);
      if (it.to) {
        const pt = findPos(it.to);
        if (pt) parts.push(`<path d="M ${pi.x + 86} ${pi.y} C ${(pi.x + pt.x) / 2} ${pi.y}, ${(pi.x + pt.x) / 2} ${pt.y}, ${pt.x - 46} ${pt.y}" fill="none" stroke="${it.kind === 'blocked' ? EDGE.blocks : EDGE.decides}" stroke-width="1.6" ${it.kind === 'decision' ? 'stroke-dasharray="4 3"' : ''}/>`);
      }
    }
    for (const l of laneArr) {
      const p = posL.get('lane:' + l.id);
      const conv = (indeg.get('lane:' + l.id) || 0) >= 2;
      if (conv) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="${EDGE.decides}" stroke-width="1.6" stroke-dasharray="5 4"/>`);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="18" fill="${l.color}" fill-opacity="0.25" stroke="${l.color}" stroke-width="2"/>`);
      parts.push(`<text x="${p.x}" y="${p.y - 24}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" style="fill:var(--ink-700)">${esc(l.name.slice(0, 16))}</text>`);
    }
    const KIND = { blocked: EDGE.blocks, promise: EDGE.closes, decision: EDGE.decides };
    for (const it of items) {
      const p = posI.get(it.id);
      parts.push(`<rect x="${p.x - 86}" y="${p.y - 15}" width="172" height="30" rx="7" stroke="${KIND[it.kind]}" stroke-width="1.4" style="fill:var(--surface)"/>`);
      parts.push(`<text x="${p.x}" y="${p.y - 2}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8" fill="${KIND[it.kind]}">${it.kind.toUpperCase()}</text>`);
      parts.push(`<text x="${p.x}" y="${p.y + 10}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" style="fill:var(--ink-700)">${esc(it.label.slice(0, 30))}<title>${esc(it.label)}</title></text>`);
    }
    for (const t of tgtArr) {
      const p = posT.get(t.id);
      const conv = (indeg.get(t.id) || 0) >= 2;
      if (conv) parts.push(`<circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="${EDGE.decides}" stroke-width="1.6" stroke-dasharray="5 4"/>`);
      parts.push(t.human
        ? `<circle cx="${p.x}" cy="${p.y}" r="18" stroke-width="2" style="fill:var(--lemon-light);stroke:var(--ink-900)"/>`
        : `<rect x="${p.x - 42}" y="${p.y - 14}" width="84" height="28" rx="7" stroke-width="1.4" style="fill:var(--surface-2);stroke:var(--ink-500)"/>`);
      parts.push(`<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" style="fill:var(--ink-900)">${esc(String(t.label).slice(0, 12))}</text>`);
    }
    return `<div class="wf-scroll"><svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${parts.join('')}</svg></div>`;
  }

  function render() {
    if (!el) return;
    const meta = window.deriveRoomMeta ? window.deriveRoomMeta() : { openAsks: [], promises: [], decisions: [], blockers: [] };
    const graphs = buildGraphs(S.chatroom || []);
    const multi = graphs.filter((g) => g.nodes.length >= 2);
    const singles = graphs.length - multi.length;
    el.innerHTML = `
      <div class="wf-section">
        <div class="wf-head">dependency graph <span class="wf-sub">open state only · edges = typed BLOCKED: x ON: y, filed decisions, open promises — prose draws nothing</span></div>
        ${depGraphSVG(meta)}
      </div>
      <div class="wf-section">
        <div class="wf-head">work-graphs <span class="wf-sub">reconstructed thread DAGs — each card is one workflow; rings: <span style="color:${EDGE.closes}">promise</span> / <span style="color:${EDGE.decides}">decision-needed</span></span>
          <span class="wf-legend">
            <i style="background:${EDGE.reply}"></i>reply
            <i style="background:${EDGE.closes}"></i>closes
            <i style="background:${EDGE.decides}"></i>decides
            <i style="background:${EDGE.blocks}"></i>blocks
          </span></div>
        ${multi.length ? multi.map(workGraphCard).join('') : '<div class="wf-empty">No multi-message workflows yet — threads appear here once conversations chain replies.</div>'}
        ${singles ? `<div class="wf-empty">${singles} single-message topic${singles > 1 ? 's' : ''} hidden.</div>` : ''}
      </div>`;
  }

  return { init, render };
})();
