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

  // Allocation from the live snapshot; fallback shares stay clearly provisional.
  function donut(list) {
    const seg = $('donut-seg'), key = $('donut-key');
    S.clear(seg); S.clear(key);
    let cum = 0;
    list.forEach((m) => {
      const c = S.svg('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: m.color, 'stroke-width': 24, pathLength: 100, 'stroke-dasharray': (m.voted - 0.5) + ' ' + (100 - m.voted + 0.5), 'stroke-dashoffset': -cum });
      seg.appendChild(c); cum += m.voted;
      const li = S.el('li'); const dot = S.el('i'); dot.style.background = m.color; li.appendChild(dot);
      li.appendChild(S.el('b', null, S.pct(m.voted))); li.appendChild(S.el('span', null, m.name));
      key.appendChild(li);
    });
    $('donut-svg').setAttribute('aria-label', (list.some((p) => p.provisional) ? 'Provisional allocation: ' : 'Voted allocation: ') + list.map((m) => m.name + ' ' + S.pct(m.voted)).join(', '));
  }

  function bar(value, color) {
    const b = S.el('span', 'bar'); const i = S.el('i'); i.style.background = color; S.setBar(i, Math.min(100, value)); b.appendChild(i); return b;
  }
  // A "Voted"/"Routed" cell: the figure, its bar and, for the live row, a small caption saying what the figure is.
  function barCell(value, color, caption) {
    const c = S.el('td', 'c-bar'); c.appendChild(S.el('b', null, S.pct(value))); c.appendChild(bar(value, color));
    if (caption) c.appendChild(S.el('small', 'cap', caption));
    return c;
  }
  function row(p, n) {
    const tr = S.el('tr', 'live');
    tr.appendChild(S.el('td', 'c-n', String(n)));
    const name = S.el('td', 'c-name'); const wrap = S.el('span', 'pname');
    const ic = S.icon(p.icon, 'pic'); ic.style.color = p.color; wrap.appendChild(ic);
    wrap.appendChild(S.el('strong', null, p.name));
    wrap.appendChild(S.el('em', 'tag live', 'Live'));
    name.appendChild(wrap); tr.appendChild(name);
    tr.appendChild(S.el('td', 'c-focus', p.focus));
    // Allocation share (provisional until voting opens). There is no live routed figure.
    tr.appendChild(barCell(p.voted, p.color, p.provisional ? 'share, provisional' : 'share'));
    const a = S.el('td', 'c-pill'); a.appendChild(S.el('span', 'cell green', S.n0(p.accepted))); tr.appendChild(a);
    const o = S.el('td', 'c-pill'); o.appendChild(S.el('span', 'cell blue', S.n0(p.open))); tr.appendChild(o);
    const go = S.el('td', 'c-act');
    { const l = S.el('a', 'btn btn-coral btn-sm'); l.href = '/connect.html'; l.appendChild(document.createTextNode('Point your AI here ')); l.appendChild(S.icon('arrow')); go.appendChild(l); }
    tr.appendChild(go);
    return tr;
  }
  function board(list) {
    const tb = $('board-body'); S.clear(tb);
    list.forEach((p, i) => tb.appendChild(row(p, i + 1)));
    const open = list.reduce((t, p) => t + p.open, 0);
    $('board-count').textContent = list.length + (list.length === 1 ? ' live project · ' : ' live projects · ') + S.n0(open) + ' open tasks';
  }

  // If the API fails, show nothing rather than a guess.
  async function load() {
    try {
      const [stats, rec] = await Promise.all([S.getJson('/api/stats'), S.getJson('/api/receipts?limit=5')]);
      const list = S.projects(stats);
      S.renderStamp($('how-stamp'), stats);
      S.flow($('flow-host'), list, { lite: true, onSelect: (id) => { window.location.href = '/live.html#' + id; } });
      $('board-note').textContent = stats.allocation_note || 'Voted allocation from the weekly ballot snapshot. Accepted work is shown separately.';
      board(list);
      $('origins-line').textContent = stats.routed_note || '';
      donut(list);
      const real = S.renderReceipts($('receipts-host'), rec, { limit: 4 });
      $('rec-pill').textContent = real ? 'Live' : 'None yet';
    } catch (e) {
      S.errorNote($('flow-host'));
      const tb = $('board-body'); S.clear(tb);
      const tr = S.el('tr'); const td = S.el('td', null, 'Couldn’t load the live numbers just now. Nothing is shown rather than a guess.'); td.colSpan = 7; tr.appendChild(td); tb.appendChild(tr);
      $('board-count').textContent = 'Live numbers unavailable';
      S.renderReceipts($('receipts-host'), { receipts: [] }, { limit: 4 });
    }
  }
  load();
  setInterval(load, 60000);
})();
