(function () {
  'use strict';
  const S = window.Swarm;
  const $ = (id) => document.getElementById(id);

  // connect-card tabs: pick the app; "Setup steps" opens that app's steps on the Connect page
  const tabs = document.querySelectorAll('.ptab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
    $('setup-link').href = '/connect.html?c=' + encodeURIComponent(t.dataset.c);
  }));

  // If the hero photo can't load, fall back to the procedural canvas globe.
  (function heroFallback() {
    const img = $('hero-img');
    if (!img) return;
    let done = false;
    function fall() {
      if (done) return; done = true;
      img.hidden = true;
      const c = S.el('canvas', 'hero-canvas'); c.id = 'earth'; c.setAttribute('aria-hidden', 'true');
      img.parentNode.insertBefore(c, img);
      const sc = document.createElement('script'); sc.src = '/js/earth.js'; document.body.appendChild(sc);
    }
    img.addEventListener('error', fall);
    if (img.complete && img.naturalWidth === 0) fall();
  })();

  // vote donut: the example split
  (function donut() {
    const seg = $('donut-seg'), key = $('donut-key');
    let cum = 0;
    S.META.forEach((m) => {
      const c = S.svg('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: m.color, 'stroke-width': 24, pathLength: 100, 'stroke-dasharray': (m.voted - 0.5) + ' ' + (100 - m.voted + 0.5), 'stroke-dashoffset': -cum });
      seg.appendChild(c); cum += m.voted;
      const li = S.el('li'); const dot = S.el('i'); dot.style.background = m.color; li.appendChild(dot);
      li.appendChild(S.el('b', null, String(m.voted))); li.appendChild(S.el('span', null, m.name));
      key.appendChild(li);
    });
  })();

  function bar(value, color) {
    const b = S.el('span', 'bar'); const i = S.el('i'); i.style.background = color; S.setBar(i, Math.min(100, value * 2.1)); b.appendChild(i); return b;
  }
  // A "Voted"/"Routed" cell: the figure, its bar and, for the live row, a small caption saying what the figure is.
  function barCell(value, color, caption) {
    const c = S.el('td', 'c-bar'); c.appendChild(S.el('b', null, S.pct(value))); c.appendChild(bar(value, color));
    if (caption) c.appendChild(S.el('small', 'cap', caption));
    return c;
  }
  function row(p, n) {
    const tr = S.el('tr', p.preview ? 'preview-row' : 'live');
    tr.appendChild(S.el('td', 'c-n', String(n)));
    const name = S.el('td', 'c-name'); const wrap = S.el('span', 'pname');
    const ic = S.icon(p.icon, 'pic'); ic.style.color = p.color; wrap.appendChild(ic);
    wrap.appendChild(S.el('strong', null, p.name));
    wrap.appendChild(S.el('em', p.preview ? 'tag' : 'tag live', p.preview ? 'Example' : 'Live'));
    name.appendChild(wrap); tr.appendChild(name);
    tr.appendChild(S.el('td', 'c-focus', p.focus));
    // Real row: allocation share (provisional) and the real routed share with its units. Example rows: made-up figures.
    tr.appendChild(barCell(p.voted, p.color, p.preview ? '' : (p.provisional ? 'share, provisional' : 'share')));
    tr.appendChild(barCell(p.routed, '#f48a4c', p.preview ? '' : S.n0(p.routedUnits) + (p.routedUnits === 1 ? ' unit' : ' units') + ' this week'));
    const a = S.el('td', 'c-pill'); a.appendChild(S.el('span', 'cell green', S.n0(p.accepted))); tr.appendChild(a);
    const o = S.el('td', 'c-pill'); o.appendChild(S.el('span', 'cell blue', S.n0(p.open))); tr.appendChild(o);
    const go = S.el('td', 'c-act');
    if (!p.preview) { const l = S.el('a', 'btn btn-coral btn-sm'); l.href = '/connect.html'; l.appendChild(document.createTextNode('Point your AI here ')); l.appendChild(S.icon('arrow')); go.appendChild(l); }
    else { const l = S.el('a', 'btn btn-outline-dark btn-sm preview'); l.href = '#projects'; l.title = 'Example project: preview only'; l.appendChild(document.createTextNode('Preview ')); l.appendChild(S.icon('arrow')); go.appendChild(l); }
    tr.appendChild(go);
    return tr;
  }
  // Real projects first, then a divider, then the examples. A row is either all real or all example.
  function board(list) {
    const tb = $('board-body'); S.clear(tb);
    const real = list.filter((p) => !p.preview), examples = list.filter((p) => p.preview);
    real.forEach((p, i) => tb.appendChild(row(p, i + 1)));
    const div = S.el('tr', 'divider'); const dc = S.el('td', null, S.PREVIEW_LABEL); dc.colSpan = 8; div.appendChild(dc); tb.appendChild(div);
    examples.forEach((p, i) => tb.appendChild(row(p, real.length + i + 1)));
    const openLive = real.reduce((t, p) => t + p.open, 0);
    $('board-count').textContent = real.length + ' live project · ' + S.n0(openLive) + ' open tasks · ' + examples.length + ' examples';
  }

  // If the API fails, show nothing rather than a guess (Town Hall's numbers are only ever the live ones).
  async function load() {
    try {
      const [stats, rec] = await Promise.all([S.getJson('/api/stats'), S.getJson('/api/receipts?limit=5')]);
      const list = S.projects(stats);
      S.renderStamp($('how-stamp'), stats);
      S.flow($('flow-host'), list, { lite: true, onSelect: (id) => { window.location.href = '/live.html#' + id; } });
      board(list);
      const real = S.renderReceipts($('receipts-host'), rec, { limit: 4 });
      $('rec-pill').textContent = real ? 'Live' : 'Example data';
    } catch (e) {
      S.errorNote($('flow-host'));
      const tb = $('board-body'); S.clear(tb);
      const tr = S.el('tr'); const td = S.el('td', null, 'Couldn’t load the live numbers just now. Nothing is shown rather than a guess.'); td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr);
      $('board-count').textContent = 'Live numbers unavailable';
      S.renderReceipts($('receipts-host'), { receipts: [] }, { limit: 4 });
    }
  }
  load();
  setInterval(load, 60000);
})();
