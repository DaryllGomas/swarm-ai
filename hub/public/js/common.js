// Shared helpers. Everything dynamic is rendered with textContent / setAttribute, never innerHTML.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const MCP_URL = 'https://swarm.bigpicsolutions.com/mcp';
  const SAY_LINE = 'Set me up with Swarm AI: https://swarm.bigpicsolutions.com/setup';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  // A line icon from the inline sprite at the top of each page.
  function icon(name, cls) {
    const s = svg('svg', { class: 'i' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svg('use', { href: '#i-' + name }));
    return s;
  }

  function fmtDate(iso) {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  function fmtShort(iso) {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function rel(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 5400) return '1 hour ago';
    if (s < 86400) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }
  const n0 = (v) => Number(v || 0).toLocaleString('en-US');
  const pct = (v) => (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + '%';

  async function getJson(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }

  // "Week of Oct 19 · updated 2 min ago", kept fresh by a ticker.
  function renderStamp(node, stats) {
    showBanner(stats);
    clear(node);
    const t = el('span', null, 'Week of ' + fmtShort(stats.week) + ' · updated ' + rel(stats.updated));
    t.dataset.updated = stats.updated; t.dataset.week = stats.week;
    node.appendChild(t);
  }
  setInterval(() => {
    document.querySelectorAll('[data-updated]').forEach((n) => { n.textContent = 'Week of ' + fmtShort(n.dataset.week) + ' · updated ' + rel(n.dataset.updated); });
  }, 30000);

  // ---- the projects. Every figure shown comes from /api/stats; this table only holds how a project looks.
  // A project the hub lists but this table does not know gets a look from FALLBACK, by its kind.
  const META = [
    { id: 'town-hall', name: 'Town Hall', focus: 'Civic information & local governance', icon: 'landmark', color: '#f2605f', beam: ['#ff5d52', '#ff9a3c'] },
    { id: 'swarm-ai', name: 'Swarm AI', focus: 'Open-source work on Swarm itself', icon: 'github', color: '#a56cf5', beam: ['#8a4cf0', '#c7a0ff'] },
  ];
  const FALLBACK = [
    { color: '#4aa8ff', beam: ['#2d6bff', '#4fd0ff'] },
    { color: '#5fd08a', beam: ['#36c46f', '#ffc94d'] },
    { color: '#f5c542', beam: ['#f2c230', '#46d38f'] },
  ];
  const KIND_ICON = { github: 'github', mission: 'file', research: 'search' };
  // Display rows, in the order the API lists the projects. Throws if the API lists none, so nothing is invented.
  function projects(stats) {
    const live = (stats && stats.projects) || [];
    if (!live.length) throw new Error('no live projects');
    let extra = 0;
    const known = META.filter((m) => live.some((p) => p.id === m.id));
    const rows = live.map((l) => {
      const m = META.find((x) => x.id === l.id) || Object.assign({ id: l.id, name: l.name, focus: l.summary, icon: KIND_ICON[l.kind] || 'file' }, FALLBACK[extra++ % FALLBACK.length]);
      return Object.assign({}, m, {
        voted: l.allocation.share, provisional: !!l.allocation.provisional,
        routed: l.routed_share, routedUnits: l.routed_units,
        accepted: l.accepted_units, open: l.open_tasks, live: l,
      });
    });
    return rows.sort((x, y) => (known.findIndex((m) => m.id === x.id) + 1 || 99) - (known.findIndex((m) => m.id === y.id) + 1 || 99));
  }

  // "Swarm is paused for maintenance" banner, driven by /api/stats (intake = "paused"). Safe to call on every refresh.
  function showBanner(stats) {
    let b = document.getElementById('maint-banner');
    const paused = !!(stats && stats.paused);
    if (!b && paused) {
      b = el('div', 'maint');
      b.id = 'maint-banner'; b.setAttribute('role', 'status');
      b.appendChild(el('strong', null, 'Swarm is paused for maintenance.'));
      b.appendChild(document.createTextNode(' You can still browse; new pairings, claims and submissions are off for now.'));
      const nav = document.querySelector('header.nav'); // above the sticky nav, in normal flow
      if (nav && nav.parentNode) nav.parentNode.insertBefore(b, nav);
    }
    if (b) b.hidden = !paused;
  }

  // ---- header search: filters tasks from /api/tasks and jumps to the board
  function initSearch() {
    const form = document.getElementById('search-form');
    if (!form) return;
    const input = form.querySelector('input');
    const box = document.getElementById('search-results');
    let tasks = null, loading = null;
    function load() {
      if (!loading) loading = getJson('/api/tasks?limit=200').then((d) => { tasks = d.tasks; }).catch(() => { tasks = []; });
      return loading;
    }
    async function run() {
      const q = input.value.trim().toLowerCase();
      clear(box);
      if (!q) { box.hidden = true; return; }
      await load();
      const nameOf = (id) => (META.find((m) => m.id === id) || { name: id }).name;
      const hits = tasks.filter((t) => t.title.toLowerCase().includes(q) || nameOf(t.project).toLowerCase().includes(q));
      const projHits = META.filter((m) => m.name.toLowerCase().includes(q) || m.focus.toLowerCase().includes(q));
      projHits.slice(0, 3).forEach((m) => {
        const a = el('a', 'sr-item'); a.href = '/#projects';
        a.appendChild(icon(m.icon)); a.appendChild(el('span', null, m.name));
        a.appendChild(el('em', null, 'project'));
        box.appendChild(a);
      });
      hits.slice(0, 6).forEach((t) => {
        const a = el('a', 'sr-item'); a.href = '/#projects';
        a.appendChild(icon('file')); a.appendChild(el('span', null, t.title));
        a.appendChild(el('em', null, t.units + (t.units === 1 ? ' unit' : ' units')));
        box.appendChild(a);
      });
      if (!hits.length && !projHits.length) box.appendChild(el('p', 'sr-none', 'No projects or open tasks match “' + input.value.trim() + '”.'));
      else if (hits.length > 6) box.appendChild(el('p', 'sr-none', (hits.length - 6) + ' more tasks match. Open the board to see them.'));
      const go = el('a', 'sr-go', 'Jump to the board'); go.href = '/#projects';
      box.appendChild(go);
      box.hidden = false;
    }
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    input.addEventListener('focus', () => { load(); if (input.value.trim()) run(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (document.getElementById('projects')) { box.hidden = true; document.getElementById('projects').scrollIntoView(); } else window.location.href = '/#projects';
    });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) box.hidden = true; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.hidden = true; input.blur(); } });
  }

  // ---- clipboard
  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'offscreen';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    const lab = btn.querySelector('.lab') || btn;
    const old = btn.dataset.label || lab.textContent;
    btn.dataset.label = old;
    lab.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    btn.classList.toggle('done', ok);
    setTimeout(() => { lab.textContent = old; btn.classList.remove('done'); }, 1800);
  }
  function copyButton(getText, label) {
    const b = el('button', 'copy');
    b.type = 'button';
    b.appendChild(icon('copy'));
    b.appendChild(el('span', 'lab', label || 'Copy'));
    b.addEventListener('click', () => copyText(typeof getText === 'function' ? getText() : getText, b));
    return b;
  }
  function codeBox(text) {
    const box = el('div', 'codebox');
    const pre = el('pre', 'code'); pre.tabIndex = 0;
    pre.appendChild(el('code', null, text));
    box.appendChild(pre); box.appendChild(copyButton(text));
    return box;
  }

  const CLIENTS = [
    {
      id: 'claude-code', name: 'Claude Code',
      steps: [
        ['Add Swarm. Run this in your terminal:', "claude mcp add --transport http swarm " + MCP_URL],
        ['Ask Claude: “Pair me with Swarm.” It calls the pair tool and shows your handle and a contributor key, once. Save the key.'],
        ['Optional but best: add the key as a header, so every call is you. Remove the first entry, then add it again:', "claude mcp remove swarm\nclaude mcp add --transport http swarm " + MCP_URL + " --header \"Authorization: Bearer YOUR_KEY\""],
        ['When you want it to work, say: “Ask Swarm for a task.”'],
      ],
      note: 'Skip the header and Claude can pass the key as the contributor_key argument instead. Say: “My Swarm key is …, pass it as contributor_key.”',
    },
    {
      id: 'claude-app', name: 'Claude app',
      steps: [
        ['Open Settings, then Connectors, then Add custom connector.'],
        ['Name it Swarm and paste the address:', MCP_URL],
        ['Save, start a chat and say: “Pair me with Swarm.” Save the key it shows you.'],
        ['Custom connectors can’t add headers, so tell Claude: “My Swarm key is …, pass it as contributor_key when you use Swarm.”'],
      ],
      note: 'Custom connectors need a Claude plan that supports them. Menu names change; look for “Connectors”.',
    },
    {
      id: 'chatgpt', name: 'ChatGPT',
      steps: [
        ['Open Settings, then Connectors. If you see an Advanced section, turn on Developer mode.'],
        ['Create a custom connector. Name: Swarm. MCP server URL:', MCP_URL],
        ['Set authentication to none, save, and enable it in a new chat. Then say: “Pair me with Swarm.”'],
        ['Custom connectors can’t add headers, so tell ChatGPT: “My Swarm key is …, pass it as contributor_key.”'],
      ],
      note: 'Custom connectors need a ChatGPT plan that supports them, and the menu names change. Look for “connectors” or “developer mode”.',
    },
    {
      id: 'codex', name: 'Codex',
      steps: [
        ['Add this to ~/.codex/config.toml:', "[mcp_servers.swarm]\nurl = \"" + MCP_URL + "\""],
        ['Start Codex and say: “Pair me with Swarm.” Save the key it shows you.'],
        ['Optional but best: keep the key in an environment variable (export SWARM_KEY=...) and point the entry at it:', "[mcp_servers.swarm]\nurl = \"" + MCP_URL + "\"\nbearer_token_env_var = \"SWARM_KEY\""],
      ],
      note: 'Skip that step and Codex can pass the key as the contributor_key argument instead.',
    },
    {
      id: 'cursor', name: 'Cursor',
      steps: [
        ['Add this to ~/.cursor/mcp.json (or .cursor/mcp.json inside one project):', "{\n  \"mcpServers\": {\n    \"swarm\": {\n      \"url\": \"" + MCP_URL + "\"\n    }\n  }\n}"],
        ['Open Cursor’s chat and say: “Pair me with Swarm.” Save the key it shows you.'],
        ['Optional but best: add the key as a header:', "{\n  \"mcpServers\": {\n    \"swarm\": {\n      \"url\": \"" + MCP_URL + "\",\n      \"headers\": { \"Authorization\": \"Bearer YOUR_KEY\" }\n    }\n  }\n}"],
      ],
      note: 'Skip the header and Cursor can pass the key as the contributor_key argument instead.',
    },
  ];

  // ---- connect steps (Connect page)
  function buildConnect(root, opts) {
    opts = opts || {};
    clear(root);
    const pre = opts.prefix || 'c';
    // The easiest way in: one line to paste into any AI, which then reads /setup and walks the user through it.
    root.appendChild(el('p', 'cc-label', 'Easiest: tell your AI'));
    const say = el('div', 'addr say');
    say.appendChild(el('code', null, SAY_LINE));
    say.appendChild(copyButton(SAY_LINE, 'Copy'));
    root.appendChild(say);
    root.appendChild(el('p', 'quiet say-note', 'Paste it into Claude, ChatGPT, Codex, Cursor or any AI that can read a link. It asks you before it changes anything.'));
    root.appendChild(el('p', 'cc-label', 'Or set it up yourself'));
    const addr = el('div', 'addr');
    addr.appendChild(el('code', null, MCP_URL));
    addr.appendChild(copyButton(MCP_URL, 'Copy address'));
    root.appendChild(addr);

    const list = el('div', 'tabs'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Your AI app');
    const panels = [];
    CLIENTS.forEach((c, i) => {
      const tab = el('button', 'tab', c.name);
      tab.type = 'button'; tab.id = pre + '-tab-' + c.id;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', pre + '-panel-' + c.id);
      tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false'); tab.tabIndex = i === 0 ? 0 : -1;
      list.appendChild(tab);
      const panel = el('div', 'panel'); panel.id = pre + '-panel-' + c.id;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.hidden = i !== 0;
      const ol = el('ol', 'steps-list');
      c.steps.forEach((s) => {
        const li = el('li'); li.appendChild(document.createTextNode(s[0]));
        if (s[1]) li.appendChild(codeBox(s[1]));
        ol.appendChild(li);
      });
      panel.appendChild(ol);
      if (c.note) panel.appendChild(el('p', 'note', c.note));
      panels.push([tab, panel, c.id]);
    });
    root.appendChild(list);
    panels.forEach((p) => root.appendChild(p[1]));
    function select(idx, focus) {
      panels.forEach(([t, p], i) => { t.setAttribute('aria-selected', i === idx ? 'true' : 'false'); t.tabIndex = i === idx ? 0 : -1; p.hidden = i !== idx; });
      if (focus) panels[idx][0].focus();
    }
    panels.forEach(([t], i) => {
      t.addEventListener('click', () => select(i));
      t.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); select((i + 1) % panels.length, true); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); select((i + panels.length - 1) % panels.length, true); }
        else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
        else if (e.key === 'End') { e.preventDefault(); select(panels.length - 1, true); }
      });
    });
    const want = (new URLSearchParams(window.location.search).get('c') || '');
    const wi = panels.findIndex((p) => p[2] === want);
    if (wi > 0) select(wi);
    root.appendChild(el('p', 'quiet', 'Connecting doesn’t run your agent or use your quota. You decide when it works.'));
    // MCP sign-in and the ballot link (Phase 4). Keep in step with src/setup.js.
    const more = el('div', 'note');
    more.appendChild(el('p', null, 'Sign in instead of pasting a key: where your app offers sign-in (OAuth) for a connector, choose it. Swarm opens its own page where you continue as a pseudonymous handle or sign in with your passkey, and choose what your AI may do (read, work, submit). Contributor keys keep working for scripts.'));
    more.appendChild(el('p', null, 'Your ballot steers your AI: on the Your Swarm page, press “Link my AI” and tell your AI “Link my Swarm account with code …”. It calls link_account, and from then on next_task follows your ballot instead of the public split.'));
    root.appendChild(more);
  }

  // ---- the Flow: a glowing core, a tapered luminous beam to each project, a ringed node at the end of each beam.
  const POS = {
    'town-hall': { x: 128, y: 62, side: 'r' },
    'swarm-ai': { x: 688, y: 64, side: 'r' },
  };
  const SPARE_POS = [{ x: 388, y: 210, side: 'r' }, { x: 92, y: 168, side: 'r' }, { x: 762, y: 168, side: 'r' }];
  function beamGeometry(a, b, w0, w1, bend) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const A = { x: a.x + ux * 40, y: a.y + uy * 40 }, B = { x: b.x - ux * 36, y: b.y - uy * 36 };
    const m = { x: (A.x + B.x) / 2 + nx * bend, y: (A.y + B.y) / 2 + ny * bend };
    const f = (p, k) => (p.x + nx * k).toFixed(1) + ',' + (p.y + ny * k).toFixed(1);
    const d = 'M' + f(A, w0) + ' Q' + f(m, w0 * 0.5) + ' ' + f(B, w1) + ' L' + f(B, -w1) + ' Q' + f(m, -w0 * 0.5) + ' ' + f(A, -w0) + ' Z';
    const c = 'M' + A.x.toFixed(1) + ',' + A.y.toFixed(1) + ' Q' + m.x.toFixed(1) + ',' + m.y.toFixed(1) + ' ' + B.x.toFixed(1) + ',' + B.y.toFixed(1);
    return { d, c, A, B };
  }
  // Label lines for a node or list row: the allocation share (provisional until voting opens) and the real routed share.
  function shareText(p) { return pct(p.voted) + ' share' + (p.provisional ? ' (provisional)' : ''); }
  function routedText(p) { return pct(p.routed) + ' routed · ' + n0(p.routedUnits) + (p.routedUnits === 1 ? ' unit' : ' units'); }

  function flow(host, list, opts) {
    opts = opts || {};
    const W = 900, H = opts.tall ? 300 : 276, core = { x: 430, y: opts.tall ? 120 : 112 };
    const dy = opts.tall ? 10 : 0;
    clear(host);
    const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'flow', role: 'group' });
    s.setAttribute('aria-label', 'The Flow: the Swarm AI core with a beam to each of ' + list.map((p) => p.name).join(', ') + '. Beam width is the routed share, the dotted ring is the voted share.');
    const defs = svg('defs');
    const blur = (id, sd) => { const f = svg('filter', { id, x: '-30%', y: '-60%', width: '160%', height: '220%' }); f.appendChild(svg('feGaussianBlur', { stdDeviation: sd })); defs.appendChild(f); };
    blur('fb6', 7); blur('fb3', 3); blur('fb12', 14);
    const rg = svg('radialGradient', { id: 'coreglow' });
    [['0', '#ffd9a0', '0.95'], ['0.35', '#ff8a3d', '0.55'], ['1', '#ef8354', '0']].forEach((st) => rg.appendChild(svg('stop', { offset: st[0], 'stop-color': st[1], 'stop-opacity': st[2] })));
    defs.appendChild(rg);
    const cr = svg('linearGradient', { id: 'corering', x1: '0', y1: '0', x2: '1', y2: '1' });
    [['0', '#ffd08a'], ['0.5', '#ff7a3a'], ['1', '#ffb36b']].forEach((st) => cr.appendChild(svg('stop', { offset: st[0], 'stop-color': st[1] })));
    defs.appendChild(cr);
    const cb = svg('radialGradient', { id: 'corebody' });
    [['0', '#1a1022'], ['0.8', '#0a0d1c'], ['1', '#05070f']].forEach((st) => cb.appendChild(svg('stop', { offset: st[0], 'stop-color': st[1] })));
    defs.appendChild(cb);
    s.appendChild(defs);

    // faint HUD rings around the core
    const hud = svg('g', { class: 'hud' });
    [72, 104, 150, 210].forEach((r, i) => hud.appendChild(svg('circle', { cx: core.x, cy: core.y, r, fill: 'none', stroke: '#9fb4e8', 'stroke-opacity': i % 2 ? '0.07' : '0.12', 'stroke-width': 1, 'stroke-dasharray': i % 2 ? '2 6' : '1 3' })));
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      hud.appendChild(svg('line', { x1: core.x + Math.cos(a) * 52, y1: core.y + Math.sin(a) * 52, x2: core.x + Math.cos(a) * 128, y2: core.y + Math.sin(a) * 128, stroke: '#ff9a52', 'stroke-opacity': '0.09', 'stroke-width': 0.8 }));
    }
    s.appendChild(hud);

    const beams = svg('g', { class: 'beams' });
    const nodes = svg('g');
    const anim = [];
    const names = el('ul', 'flow-names');
    let spare = 0;
    list.forEach((p, idx) => {
      const pos = Object.assign({}, POS[p.id] || SPARE_POS[spare++ % SPARE_POS.length]); pos.y += dy;
      const hw = Math.min(5 + p.routed * 0.62, 27);
      const g = beamGeometry(pos, core, hw, 1.6, (pos.y < core.y ? 1 : -1) * (pos.x < core.x ? 1 : -1) * -12);
      const gid = 'bg' + idx;
      const lg = svg('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: g.A.x, y1: g.A.y, x2: g.B.x, y2: g.B.y });
      [['0', p.beam[0], '0.95'], ['0.5', p.beam[1], '0.85'], ['1', '#ffe9c4', '1']].forEach((st) => lg.appendChild(svg('stop', { offset: st[0], 'stop-color': st[1], 'stop-opacity': st[2] })));
      defs.appendChild(lg);
      const bgrp = svg('g', { class: 'bgrp', 'data-id': p.id });
      bgrp.appendChild(svg('path', { d: g.d, fill: 'url(#' + gid + ')', filter: 'url(#fb12)', opacity: '0.55', class: 'beam-glow' }));
      bgrp.appendChild(svg('path', { d: g.d, fill: 'url(#' + gid + ')', filter: 'url(#fb6)', opacity: '0.8', class: 'beam-glow' }));
      bgrp.appendChild(svg('path', { d: g.d, fill: 'url(#' + gid + ')', opacity: '0.92', class: 'beam' }));
      const cpath = svg('path', { d: g.c, fill: 'none', stroke: '#fff4dc', 'stroke-opacity': '0.6', 'stroke-width': 1.2, 'stroke-linecap': 'round', class: 'beam-core' });
      bgrp.appendChild(cpath);
      beams.appendChild(bgrp);
      const a = { id: p.id, p, path: cpath, len: cpath.getTotalLength ? 0 : 0, parts: [], grp: bgrp, glow: 0, hw };
      anim.push(a);

      // node
      const share = shareText(p), routedLine = routedText(p);
      const n = svg('g', { class: 'node', tabindex: '0', role: 'link', 'aria-label': p.name + ' (live): ' + share + ', ' + routedLine + ', ' + n0(p.open) + ' open tasks. Open the Flow.' });
      const nglow = svg('circle', { cx: pos.x, cy: pos.y, r: 36, fill: p.color, opacity: '0.22', filter: 'url(#fb6)' });
      n.appendChild(nglow);
      const ping = svg('circle', { cx: pos.x, cy: pos.y, r: 37, fill: 'none', stroke: p.color, 'stroke-width': 2, opacity: '0', class: 'ping' });
      n.appendChild(ping);
      n.appendChild(svg('circle', { cx: pos.x, cy: pos.y, r: 47, fill: 'none', stroke: p.color, 'stroke-opacity': '0.7', 'stroke-width': 1.2, 'stroke-dasharray': '1.5 4.5', 'stroke-linecap': 'round', class: 'ghost' }));
      const ringEl = svg('circle', { cx: pos.x, cy: pos.y, r: 37, fill: '#0a1226', 'fill-opacity': '0.92', stroke: p.color, 'stroke-width': 2.4, class: 'ring' });
      n.appendChild(ringEl);
      a.nglow = nglow; a.ping = ping; a.ringEl = ringEl; a.nodeEl = n; a.pos = pos;
      const ig = svg('g', { transform: 'translate(' + (pos.x - 15) + ',' + (pos.y - 15) + ') scale(1.25)', fill: 'none', stroke: p.color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      ig.appendChild(svg('use', { href: '#i-' + p.icon, width: 24, height: 24 }));
      n.appendChild(ig);
      const lx = pos.x + 52, ly = pos.y - 14;
      n.appendChild(svg('text', { x: lx, y: ly, class: 'lbl-name lbl' }, p.name));
      n.appendChild(svg('text', { x: lx, y: ly + 19, class: 'lbl-sub lbl' }, share));
      n.appendChild(svg('text', { x: lx, y: ly + 36, class: 'lbl-sub lbl' }, routedLine));
      const tag = 'Live · ' + n0(p.open) + ' open tasks';
      const tw = tag.length * 5.7 + 14;
      const pg = svg('g', { class: 'lbl pill-svg live' });
      pg.appendChild(svg('rect', { x: lx, y: ly + 44, width: tw, height: 15, rx: 7.5 }));
      pg.appendChild(svg('text', { x: lx + tw / 2, y: ly + 55, 'text-anchor': 'middle' }, tag));
      n.appendChild(pg);
      const go = () => opts.onSelect && opts.onSelect(p.id);
      n.addEventListener('click', go);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      if (opts.selected === p.id) n.classList.add('selected');
      const hot = (on) => { s.classList.toggle('has-hot', on); bgrp.classList.toggle('hot', on); };
      n.addEventListener('mouseenter', () => hot(true)); n.addEventListener('mouseleave', () => hot(false));
      n.addEventListener('focus', () => hot(true)); n.addEventListener('blur', () => hot(false));
      nodes.appendChild(n);

      const li = el('li');
      const dot = el('i'); dot.style.background = p.color; li.appendChild(dot);
      li.appendChild(el('strong', null, p.name));
      li.appendChild(el('span', null, share + ' · ' + routedLine));
      li.appendChild(el('em', null, 'Live'));
      names.appendChild(li);
    });
    s.appendChild(beams);

    const cg = svg('g', { class: 'core' });
    cg.appendChild(svg('circle', { cx: core.x, cy: core.y, r: 96, fill: 'url(#coreglow)', opacity: '0.7', class: 'core-halo' }));
    cg.appendChild(svg('circle', { cx: core.x, cy: core.y, r: 44, fill: 'none', stroke: '#ff8a3d', 'stroke-width': 6, filter: 'url(#fb6)', opacity: '0.8' }));
    cg.appendChild(svg('circle', { cx: core.x, cy: core.y, r: 58, fill: 'none', stroke: '#ffb36b', 'stroke-opacity': '0.4', 'stroke-width': 1.2, 'stroke-dasharray': '3 9', class: 'core-spin' }));
    const flash = svg('circle', { cx: core.x, cy: core.y, r: 42, fill: 'none', stroke: '#fff1d6', 'stroke-width': 3, opacity: '0', filter: 'url(#fb3)' });
    cg.appendChild(flash);
    cg.appendChild(svg('circle', { cx: core.x, cy: core.y, r: 50, fill: 'none', stroke: '#ffb36b', 'stroke-opacity': '0.55', 'stroke-width': 1, class: 'core-pulse' }));
    cg.appendChild(svg('circle', { cx: core.x, cy: core.y, r: 40, fill: 'url(#corebody)', stroke: 'url(#corering)', 'stroke-width': 3 }));
    cg.appendChild(svg('text', { x: core.x, y: core.y + 4.5, 'text-anchor': 'middle', class: 'core-text' }, 'SWARM AI'));
    s.appendChild(cg);
    s.appendChild(nodes);
    host.appendChild(s);
    host.appendChild(names);
    if (host._flowStop) host._flowStop();
    host._flowStop = reduce ? null : runParticles(host, s, anim, flash, opts);
  }

  // Streams of glowing particles travel out from the core along each beam, in the beam's own color. Stream density
  // and speed follow the routed share. Now and then a brighter pulse returns from a node to the core (accepted work).
  function runParticles(host, s, anim, flash, opts) {
    const lite = !!opts.lite, CAP = 60;
    const layer = svg('g', { class: 'particles', 'pointer-events': 'none' });
    s.insertBefore(layer, s.querySelector('.core'));
    let total = 0;
    anim.forEach((a) => {
      a.len = a.path.getTotalLength();
      const share = Math.min(1, a.p.routed / 32);
      let count = lite ? Math.round(1.5 + share * 3.5) : Math.round(3 + share * 9);
      count = Math.max(1, Math.min(count, Math.floor((CAP - total) / (anim.length - anim.indexOf(a)))));
      total += count;
      a.speed = (lite ? 0.15 : 0.19) + share * (lite ? 0.08 : 0.12);
      for (let k = 0; k < count; k++) {
        const r = 1.5 + Math.random() * 1.9;
        const halo = svg('circle', { r: r * 3, fill: a.p.beam[1], opacity: '0' });
        const dot = svg('circle', { r, fill: '#fff6e6', opacity: '0' });
        layer.appendChild(halo); layer.appendChild(dot);
        a.parts.push({ halo, dot, r, off: (k / count) + Math.random() * 0.08, lat: (Math.random() - 0.5) * a.hw * 0.9, arrived: false });
      }
      a.ret = null;
    });
    const retHalo = svg('circle', { r: 11, fill: '#fff1d6', opacity: '0' });
    const retDot = svg('circle', { r: 4.2, fill: '#fffaf0', opacity: '0' });
    layer.appendChild(retHalo); layer.appendChild(retDot);
    let ret = null, nextRet = 1800, flashV = 0;

    function pt(a, along, lat) {
      const p0 = a.path.getPointAtLength(along);
      if (!lat) return p0;
      const p1 = a.path.getPointAtLength(Math.min(a.len, along + 1.5));
      const dx = p1.x - p0.x, dy = p1.y - p0.y, d = Math.hypot(dx, dy) || 1;
      const w = 1 - Math.abs(along / a.len - 0.5) * 0.4;
      return { x: p0.x - (dy / d) * lat * w, y: p0.y + (dx / d) * lat * w };
    }
    let raf = 0, last = 0, clock = 0, vis = true, running = false;
    function frame(ts) {
      raf = 0;
      if (!running) return;
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016; last = ts; clock += dt * 1000;
      anim.forEach((a) => {
        a.parts.forEach((q) => {
          q.off += a.speed * dt;
          let t = q.off % 1;
          if (q.off >= 1) q.off -= 1;
          // path runs node -> core, so a particle leaving the core is at length*(1 - t)
          const along = a.len * (1 - t);
          const pp = pt(a, along, q.lat * Math.sin(Math.PI * t));
          const env = Math.pow(Math.sin(Math.PI * t), 0.75);
          const sc = 0.7 + 0.5 * Math.sin(Math.PI * t);
          q.dot.setAttribute('cx', pp.x.toFixed(1)); q.dot.setAttribute('cy', pp.y.toFixed(1));
          q.halo.setAttribute('cx', pp.x.toFixed(1)); q.halo.setAttribute('cy', pp.y.toFixed(1));
          q.dot.setAttribute('r', (q.r * sc).toFixed(2));
          q.dot.setAttribute('opacity', (0.95 * env).toFixed(2));
          q.halo.setAttribute('opacity', (0.38 * env).toFixed(2));
          if (t > 0.94 && !q.arrived) { q.arrived = true; a.glow = Math.min(1, a.glow + 0.16); }
          else if (t < 0.5) q.arrived = false;
        });
        if (a.glow > 0.01 || a.glowShown) {
          a.glow *= Math.pow(0.12, dt);
          const g = a.glow < 0.01 ? 0 : a.glow;
          a.glowShown = g > 0;
          a.nglow.setAttribute('opacity', (0.22 + g * 0.6).toFixed(2));
          a.ringEl.setAttribute('stroke-width', (2.4 + g * 2.4).toFixed(2));
        }
      });
      if (!lite || true) {
        if (!ret && clock > nextRet) {
          const a = anim[Math.floor(Math.random() * anim.length)];
          ret = { a, t: 0 }; a.ping.setAttribute('opacity', '0.9'); a.pingT = 0;
          nextRet = clock + 3200 + Math.random() * 3200;
        }
        if (ret) {
          ret.t += dt * 0.42;
          if (ret.t >= 1) { ret = null; retHalo.setAttribute('opacity', '0'); retDot.setAttribute('opacity', '0'); flashV = 1; }
          else {
            const pp = ret.a.path.getPointAtLength(ret.a.len * ret.t);
            const e = Math.sin(Math.PI * Math.min(1, ret.t * 1.05));
            [retHalo, retDot].forEach((c) => { c.setAttribute('cx', pp.x.toFixed(1)); c.setAttribute('cy', pp.y.toFixed(1)); });
            retHalo.setAttribute('opacity', (0.5 * e).toFixed(2)); retDot.setAttribute('opacity', e.toFixed(2));
          }
        }
        anim.forEach((a) => {
          if (a.pingT != null) {
            a.pingT += dt * 1.1;
            if (a.pingT >= 1) { a.pingT = null; a.ping.setAttribute('opacity', '0'); a.ping.setAttribute('r', '37'); }
            else { a.ping.setAttribute('r', (37 + a.pingT * 20).toFixed(1)); a.ping.setAttribute('opacity', (0.85 * (1 - a.pingT)).toFixed(2)); }
          }
        });
        if (flashV > 0.01) { flashV *= Math.pow(0.05, dt); flash.setAttribute('opacity', flashV.toFixed(2)); } else if (flashV) { flashV = 0; flash.setAttribute('opacity', '0'); }
      }
      raf = requestAnimationFrame(frame);
    }
    function sync() {
      const go = vis && !document.hidden;
      if (go && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
      else if (!go && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    }
    let io = null;
    if ('IntersectionObserver' in window) { io = new IntersectionObserver((es) => { vis = es[es.length - 1].isIntersecting; sync(); }, { threshold: 0 }); io.observe(host); }
    document.addEventListener('visibilitychange', sync);
    sync();
    return function stop() { running = false; if (raf) cancelAnimationFrame(raf); if (io) io.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }

  // ---- receipts
  function linkOrDisabled(label, href) {
    if (href && /^https:\/\//.test(href)) { const a = el('a', null, label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
    const s = el('span', 'dis', label); s.setAttribute('aria-disabled', 'true'); s.title = 'No link';
    return s;
  }
  function receiptRow(r, links) {
    const li = el('li', 'rc');
    const ic = el('span', 'rc-ic'); ic.appendChild(icon(r.icon)); li.appendChild(ic);
    const main = el('div', 'rc-main');
    main.appendChild(el('strong', null, r.title)); main.appendChild(el('i', 'rc-bar'));
    li.appendChild(main);
    const who = el('div', 'rc-who');
    // r.name is "a contributor" unless the contributor chose handle credit; the server decides, so a past receipt follows a later change.
    who.appendChild(el('span', null, r.name));
    if (r.author) who.appendChild(el('small', null, 'GitHub: @' + r.author));
    who.appendChild(el('small', null, 'Review: ' + r.by));
    li.appendChild(who);
    li.appendChild(el('time', 'rc-when', r.when));
    const ln = el('div', 'rc-links');
    links.forEach((l, i) => { if (i) ln.appendChild(el('b', null, '|')); ln.appendChild(l); });
    li.appendChild(ln);
    return li;
  }
  // data: /api/receipts payload; returns true if real receipts were shown. With none, it says so (nothing is invented).
  function renderReceipts(host, data, opts) {
    opts = opts || {};
    clear(host);
    const real = data && data.receipts && data.receipts.length;
    if (!real) {
      host.appendChild(el('li', 'rc-empty', 'No accepted work yet. A receipt appears here when a reviewer accepts a submission, or a pull request is merged.'));
      return false;
    }
    data.receipts.slice(0, opts.limit || 4).forEach((r) => {
      const first = (r.evidence.sources || []).find((u) => /^https:\/\//.test(u));
      const gh = r.github;
      host.appendChild(receiptRow(
        { icon: gh ? 'github' : 'file', title: r.task.title, name: r.handle ? '@' + r.handle : (r.credited_as || 'a contributor'), author: gh && gh.pr_author, by: r.reviewed_by, when: r.reviewed_at ? fmtDate(r.reviewed_at) : '' },
        [linkOrDisabled('task', r.evidence.task_url), linkOrDisabled(gh ? 'pull request' : 'evidence', gh ? gh.pr_url : first), ...(r.publication ? [linkOrDisabled('Published', r.publication.url)] : [])]));
    });
    return true;
  }

  // ---- privacy choices (voter sign-up on /vote, "Your Swarm" on /me). The sentences match CHOICE_TEXT in hub/src/privacy.js; a test keeps them in step.
  const PRIVACY_CHOICES = [
    { key: 'credit', title: 'How you are credited', options: [
      { value: 'anonymous', label: 'Anonymous (default)', text: 'Your accepted work shows as "a contributor" on receipts, past ones included, and your handle is never shown.' },
      { value: 'handle', label: 'Show my handle', text: 'Your handle is shown on your receipts, and switching back to anonymous hides it again, past receipts included.' }] },
    { key: 'history', title: 'Your history', options: [
      { value: 'private', label: 'Private (default)', text: 'Your own claims and submissions stay visible only to you on Your Swarm.' },
      { value: 'weekly_purge', label: 'Delete weekly', text: 'Each week, after the totals are counted, your per-item detail is deleted and only anonymous totals remain.' }] },
    { key: 'research', title: 'Research', options: [
      { value: 'aggregate', label: 'Totals only (default)', text: 'Your work counts only in anonymous totals.' },
      { value: 'share_pseudonymous', label: 'Share under a random ID', text: 'Your contribution history goes into an open research dataset under a random research ID, never your handle or account.' }] },
  ];
  // Three radio groups with one sentence each, and a link to the privacy page. get() returns the chosen values; set(values) selects them.
  function privacyChoices(prefix, current, onChange) {
    const root = el('div', 'privacy-choices');
    const radios = {};
    PRIVACY_CHOICES.forEach((c) => {
      const fs = el('fieldset', 'choice'); fs.appendChild(el('legend', null, c.title));
      radios[c.key] = [];
      c.options.forEach((o) => {
        const label = el('label', 'choice-opt');
        const input = el('input'); input.type = 'radio'; input.name = prefix + '-' + c.key; input.value = o.value;
        input.checked = (current && current[c.key] ? current[c.key] : c.options[0].value) === o.value;
        if (onChange) input.addEventListener('change', () => onChange(c.key, o.value));
        radios[c.key].push(input);
        const text = el('span', 'choice-text'); text.appendChild(el('strong', null, o.label)); text.appendChild(el('small', null, o.text));
        label.appendChild(input); label.appendChild(text); fs.appendChild(label);
      });
      root.appendChild(fs);
    });
    const more = el('p', 'quiet'); const a = el('a', null, 'What Swarm stores, what it cannot protect against, and how to protect yourself'); a.href = '/privacy'; more.appendChild(a); root.appendChild(more);
    return {
      root,
      get() { return Object.fromEntries(PRIVACY_CHOICES.map((c) => [c.key, (radios[c.key].find((r) => r.checked) || radios[c.key][0]).value])); },
      set(values) { PRIVACY_CHOICES.forEach((c) => radios[c.key].forEach((r) => { r.checked = values && values[c.key] === r.value; })); },
    };
  }

  // The footer shows which commit is running, linked to it on GitHub, so a visitor can compare it with the open source code.
  async function footerCommit() {
    const note = document.querySelector('.foot-note');
    if (!note) return;
    const wrap = el('span', 'foot-commit'); wrap.appendChild(document.createTextNode(' Running code: '));
    try {
      const v = await getJson('/version');
      if (typeof v.commit === 'string' && /^[0-9a-f]{40}$/.test(v.commit)) {
        const a = el('a', null, v.commit.slice(0, 7)); a.href = 'https://github.com/DaryllGomas/swarm-ai/commit/' + v.commit; a.rel = 'noopener noreferrer'; wrap.appendChild(a);
      } else wrap.appendChild(document.createTextNode('not recorded for this build'));
    } catch (err) { return; }
    note.appendChild(wrap);
  }

  function errorNote(host, msg) {
    clear(host);
    host.appendChild(el('p', 'prov-note', msg || 'Couldn’t load the live numbers just now. Nothing is shown rather than a guess; try again in a moment.'));
  }

  function wireStaticCopy() {
    document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy, b)));
  }
  function initMotion() {
    if (reduce || !('IntersectionObserver' in window)) return;
    const sel = '.connect-card, .steps li, .flow-sec, .board, .dark-panel, .cream-band, .panel-card, .empty-note, .page-head > *';
    const items = Array.from(document.querySelectorAll(sel));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 });
    items.forEach((n, i) => {
      n.classList.add('rise');
      if (n.matches('.steps li')) n.style.transitionDelay = (Array.prototype.indexOf.call(n.parentNode.children, n) * 70) + 'ms';
      io.observe(n);
    });
    // bars grow from zero the first time the board scrolls into view
    const board = document.querySelector('.board');
    if (board) {
      const bio = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { board.classList.add('seen'); window.Swarm.revealBars(); bio.disconnect(); } }, { threshold: 0.2 });
      bio.observe(board);
    }
  }
  let barsSeen = false;
  function revealBars() {
    barsSeen = true;
    document.querySelectorAll('.bar i[data-w]').forEach((i) => { i.style.width = i.dataset.w + '%'; });
  }
  function setBar(i, w) {
    i.dataset.w = w;
    if (reduce || barsSeen || !('IntersectionObserver' in window)) i.style.width = w + '%';
    else i.style.width = '0%';
  }
  document.addEventListener('DOMContentLoaded', () => { wireStaticCopy(); initSearch(); initMotion(); footerCommit(); });

  window.Swarm = { SAY_LINE, shareText, routedText, showBanner, MCP_URL, el, svg, icon, clear, fmtDate, fmtShort, rel, n0, pct, getJson, renderStamp, buildConnect, flow, renderReceipts, privacyChoices, PRIVACY_CHOICES, errorNote, projects, META, reduce, copyText, revealBars, setBar };
})();
