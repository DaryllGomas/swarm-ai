(function () {
  'use strict';
  const S = window.Swarm;
  const $ = (id) => document.getElementById(id);
  let stats = null, list = [], rec = { receipts: [] }, selected = (window.location.hash || '#town-hall').slice(1);

  function meter(label, value, color) {
    const w = S.el('div');
    w.appendChild(S.el('span', 'mlab', label + ': ' + S.pct(value)));
    const b = S.el('span', 'mbar'); const i = S.el('i'); i.style.width = Math.min(100, value) + '%'; i.style.background = color; b.appendChild(i); w.appendChild(b);
    return w;
  }
  function panel() {
    const host = $('panel'); S.clear(host);
    const p = list.find((x) => x.id === selected);
    if (!p) return;
    const head = S.el('div', 'pname'); const ic = S.icon(p.icon, 'pic'); ic.style.color = p.color; head.appendChild(ic);
    head.appendChild(S.el('h3', null, p.name));
    head.appendChild(S.el('em', 'tag live', 'Live'));
    host.appendChild(head);
    const kv = S.el('dl', 'kv');
    // Only values from /api/stats.
    const l = p.live;
    host.appendChild(S.el('p', 'mt', l.summary));
    host.appendChild(meter('Allocation share' + (p.provisional ? ' (provisional)' : ''), p.voted, p.color));
    host.appendChild(meter('Routed share, this week', p.routed, '#f48a4c'));
    const rows = [['Public-routed units, this week', S.n0(l.routed_units)], ['Ballot-directed units, this week', S.n0(l.ballot_directed_units)], ['Self-picked units, this week', S.n0(l.self_directed_units)], ['Accepted units, this week', S.n0(l.accepted_units)], ['Accepted, all time', S.n0(l.accepted_units_all_time)], ['Open tasks', S.n0(l.open_tasks)], ['Active claims', S.n0(l.active_claims)], ['Pending reviews', l.pending_reviews + ' of ' + l.reviewer_capacity.max_pending]];
    rows.forEach((r) => { kv.appendChild(S.el('dt', null, r[0])); kv.appendChild(S.el('dd', null, r[1])); });
    host.appendChild(kv);
    const why = S.el('div', 'why');
    why.appendChild(S.el('strong', null, 'Where the live numbers stand')); why.appendChild(document.createTextNode(l.gap_reason || 'Routed work is at or near the allocation share.'));
    host.appendChild(why);
    if (p.provisional) host.appendChild(S.el('p', 'quiet', 'Provisional fallback: no eligible ballot snapshot has replaced this allocation.'));
    else host.appendChild(S.el('p', 'quiet', 'Voted allocation from the weekly ballot snapshot.'));
    const q = S.el('p', 'quiet'); q.appendChild(document.createTextNode('Reviewer: ' + l.reviewer + ' · '));
    if (/^https:\/\//.test(l.url || '')) { const a = S.el('a', null, 'Visit ' + p.name); a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; q.appendChild(a); }
    host.appendChild(q);
  }
  function draw() {
    S.flow($('flow-host'), list, { tall: true, selected, onSelect: (id) => { selected = id; panel(); markSelected(); } });
    markSelected();
  }
  function markSelected() {
    const idx = list.findIndex((m) => m.id === selected);
    document.querySelectorAll('.flow .node').forEach((n, i) => n.classList.toggle('selected', i === idx));
  }
  async function load() {
    try {
      const [s, r] = await Promise.all([S.getJson('/api/stats'), S.getJson('/api/receipts?limit=20')]);
      stats = s; rec = r; list = S.projects(s);
      if (!list.some((x) => x.id === selected)) selected = list[0].id;
      S.renderStamp($('live-stamp'), s);
      draw(); panel();
      const real = S.renderReceipts($('receipts-host'), r, { limit: 20 });
      $('rec-pill').textContent = real ? 'Live' : 'None yet';
      $('rec-note').textContent = real ? '' : 'Nothing has been accepted yet, so there is nothing to show. Pending work is never shown as accepted.';
      const u = s.routing_origins.units;
      $('self-line').textContent = 'This week, in units: ' + S.n0(u.public_routed) + ' public-routed · ' + S.n0(u.ballot_directed) + ' ballot-directed · ' + S.n0(u.self_picked) + ' self-picked';
    } catch (e) {
      S.errorNote($('flow-host'));
    }
  }
  load();
  setInterval(load, 60000);
})();
