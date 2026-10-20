(function () {
  'use strict';
  const S = window.Swarm;
  const $ = (id) => document.getElementById(id);
  let stats = null, list = [], rec = { receipts: [] }, selected = (window.location.hash || '#town-hall').slice(1);
  if (!S.META.some((m) => m.id === selected)) selected = 'town-hall';

  function meter(label, value, color) {
    const w = S.el('div');
    w.appendChild(S.el('span', 'mlab', label + ': ' + S.pct(value)));
    const b = S.el('span', 'mbar'); const i = S.el('i'); i.style.width = Math.min(100, value * 2.1) + '%'; i.style.background = color; b.appendChild(i); w.appendChild(b);
    return w;
  }
  function panel() {
    const host = $('panel'); S.clear(host);
    const p = list.find((x) => x.id === selected);
    if (!p) return;
    const head = S.el('div', 'pname'); const ic = S.icon(p.icon, 'pic'); ic.style.color = p.color; head.appendChild(ic);
    head.appendChild(S.el('h3', null, p.name));
    head.appendChild(S.el('em', p.preview ? 'tag' : 'tag live', p.preview ? 'Example' : 'Live'));
    host.appendChild(head);
    const kv = S.el('dl', 'kv');
    let rows;
    if (p.preview) {
      // An example project: every figure is made up, and says so.
      host.appendChild(S.el('p', 'mt', p.focus));
      host.appendChild(meter('Voted (example)', p.voted, p.color));
      host.appendChild(meter('Routed share (example)', p.routed, '#f48a4c'));
      rows = [['Accepted units (example)', S.n0(p.accepted)], ['Open tasks (example)', S.n0(p.open)]];
    } else {
      // Town Hall: only values from /api/stats.
      const l = p.live;
      host.appendChild(S.el('p', 'mt', l.summary));
      host.appendChild(meter('Allocation share' + (p.provisional ? ' (provisional)' : ''), p.voted, p.color));
      host.appendChild(meter('Routed share, this week', p.routed, '#f48a4c'));
      rows = [['Routed units, this week', S.n0(l.routed_units)], ['Self-directed units, this week', S.n0(l.self_directed_units)], ['Accepted units, this week', S.n0(l.accepted_units)], ['Accepted, all time', S.n0(l.accepted_units_all_time)], ['Open tasks', S.n0(l.open_tasks)], ['Active claims', S.n0(l.active_claims)], ['Pending reviews', l.pending_reviews + ' of ' + l.reviewer_capacity.max_pending]];
    }
    rows.forEach((r) => { kv.appendChild(S.el('dt', null, r[0])); kv.appendChild(S.el('dd', null, r[1])); });
    host.appendChild(kv);
    const why = S.el('div', 'why');
    if (!p.preview) { why.appendChild(S.el('strong', null, 'Where the live numbers stand')); why.appendChild(document.createTextNode(p.live.gap_reason || 'Routed work is at or near the allocation share.')); }
    else { why.appendChild(S.el('strong', null, 'An example project')); why.appendChild(document.createTextNode(S.PREVIEW_LABEL + '. This shows what the Flow will look like with more projects. None of its numbers are real.')); }
    host.appendChild(why);
    host.appendChild(S.el('p', 'quiet', p.preview ? 'Preview only.' : 'Voting isn’t open yet, so the 100% share is provisional: Town Hall is the only live project.'));
    if (!p.preview) {
      const q = S.el('p', 'quiet'); q.appendChild(document.createTextNode('Reviewer: ' + p.live.reviewer + ' · '));
      if (/^https:\/\//.test(p.live.url || '')) { const a = S.el('a', null, 'Visit ' + p.name); a.href = p.live.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; q.appendChild(a); }
      host.appendChild(q);
    }
  }
  function draw() {
    S.flow($('flow-host'), list, { tall: true, selected, onSelect: (id) => { selected = id; panel(); markSelected(); } });
    markSelected();
  }
  function markSelected() {
    const idx = S.META.findIndex((m) => m.id === selected);
    document.querySelectorAll('.flow .node').forEach((n, i) => n.classList.toggle('selected', i === idx));
  }
  async function load() {
    try {
      const [s, r] = await Promise.all([S.getJson('/api/stats'), S.getJson('/api/receipts?limit=20')]);
      stats = s; rec = r; list = S.projects(s);
      S.renderStamp($('live-stamp'), s);
      draw(); panel();
      const real = S.renderReceipts($('receipts-host'), r, { limit: 20 });
      $('rec-pill').textContent = real ? 'Live' : 'Example data';
      $('rec-note').textContent = real ? '' : 'No accepted work yet, so these are examples with their links disabled. Real receipts replace them as reviewers accept work.';
      const self = s.projects.reduce((t, p) => t + p.self_directed_units, 0);
      $('self-line').textContent = S.n0(self) + ' self-directed units this week' + (self ? '' : ' (none yet)');
    } catch (e) {
      S.errorNote($('flow-host'));
    }
  }
  load();
  setInterval(load, 60000);
})();
