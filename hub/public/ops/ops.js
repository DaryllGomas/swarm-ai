(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const notes = new Map();
  let cursor = null;
  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.setAttribute('class', cls);
    return n;
  }
  const clear = (n) => n.replaceChildren();
  const age = (ms) => ms === null ? 'none' : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;
  const date = (ms) => ms ? new Date(Number(ms)).toLocaleString() : 'never';
  function table(headers, rows) {
    const wrap = el('div', null, 'ops-table-wrap'), t = el('table'), head = el('tr');
    headers.forEach((h) => { const th = el('th', h); th.setAttribute('scope', 'col'); head.append(th); });
    const thead = el('thead'); thead.append(head); t.append(thead);
    const body = el('tbody');
    rows.forEach((row) => { const tr = el('tr'); row.forEach((v) => { const td = el('td'); td.append(v instanceof Node ? v : document.createTextNode(String(v ?? '—'))); tr.append(td); }); body.append(tr); });
    t.append(body); wrap.append(t); return wrap;
  }
  function button(label, fn, cls = 'btn btn-outline btn-sm') {
    const b = el('button', label, cls); b.setAttribute('type', 'button');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); } catch (err) { $('message').textContent = err.message; }
      finally { b.disabled = false; }
    });
    return b;
  }
  async function api(path, body) {
    const opts = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined) Object.assign(opts, { method: 'POST', headers: { ...opts.headers, 'Content-Type': 'application/json', 'X-Swarm-Ops': '1' }, body: JSON.stringify(body) });
    const res = await fetch(`/api/ops/${path}`, opts);
    if (!res.ok) {
      let msg = 'Request failed. Refresh the page to renew your Access session.';
      try { msg = (await res.json()).error || msg; } catch { /* Access may return a login page. */ }
      throw new Error(msg);
    }
    return res.json();
  }
  async function action(path, body) {
    $('message').textContent = 'Saving…';
    const result = await api(path, body);
    await load();
    if (result.error) throw new Error('Sync failed. The last sync error is shown in Overview.');
    $('message').textContent = result.skipped ? 'A sync is already running. Refresh shortly.' : 'Saved. Live state refreshed.';
  }
  function renderOverview(o) {
    const host = $('overview-data'); clear(host); host.setAttribute('aria-busy', 'false');
    host.append(el('p', `Week of ${o.week} · Intake: ${o.intake}`, 'quiet'));
    const metrics = el('div', null, 'ops-grid');
    Object.entries(o.counts).forEach(([label, n]) => { const m = el('div', null, 'ops-metric'); m.append(el('strong', n), el('span', label)); metrics.append(m); });
    host.append(metrics, el('p', `${o.pending_reviews} pending reviews · Oldest: ${age(o.oldest_review_age_ms)} · ${o.active_claims.length} active claims · ${o.expiring_claims.length} expire within 1 hour`));
    const ids = new Set([...Object.keys(o.allocation.shares), ...Object.keys(o.routed_by_origin.public_routed), ...Object.keys(o.routed_by_origin.self_picked), ...Object.keys(o.routed_by_origin.ballot_directed || {})]);
    host.append(table(['Project', `Allocation (published ${o.allocation.week})`, 'Public routed units', 'Ballot-directed units', 'Self-picked units'], [...ids].map((id) => [id, `${o.allocation.shares[id] ?? 0}%${o.allocation.provisional[id] ? ' · provisional' : ''}`, o.routed_by_origin.public_routed[id] || 0, (o.routed_by_origin.ballot_directed || {})[id] || 0, o.routed_by_origin.self_picked[id] || 0])));
    host.append(el('p', o.routing_note, 'quiet'), el('p', `Last sync: ${date(o.sync.last_sync)}`), el('p', `Last sync error: ${o.sync.last_sync_error || 'none'}`, 'ops-text'));
    if (o.active_claims.length) host.append(table(['Claim', 'Task', 'Contributor', 'Project', 'Expires'], o.active_claims.map((c) => [c.id, c.task, c.handle, c.project, `${date(c.expires_at)}${c.expiring ? ' · expiring' : ''}`])));
  }
  function source(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && !u.username && !u.password) {
        const a = el('a', url); a.setAttribute('href', u.href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); return a;
      }
    } catch { /* All other source strings remain plain text. */ }
    return el('span', url);
  }
  function renderReviews(data) {
    const host = $('review-data'); clear(host); $('review-count').textContent = data.pending.length;
    if (!data.pending.length) host.append(el('p', 'No submissions waiting.', 'quiet'));
    data.pending.forEach((s) => {
      const card = el('article', null, 'ops-card review');
      card.append(el('h3', `#${s.id} · ${s.title}`), el('p', `${s.handle} · Task ${s.task} · ${s.project} · ${s.units} units`), el('p', `Waiting ${age(s.age_ms)}`, 'ops-age'));
      const task = el('details'), summary = el('summary', 'Task brief and expected format'); task.append(summary, el('pre', s.brief), el('pre', s.output_format)); card.append(task, el('h4', 'Submission'), el('pre', s.body));
      if (s.pr_number) {
        if (s.pr_needs_confirmation) card.append(el('p', 'Merged on GitHub, needs reviewer confirmation: a merge does not show this pull request resolves the task. Check it before accepting.', 'ops-age'));
        card.append(el('p', `Pull request #${s.pr_number} by ${s.pr_author} · ${s.pr_state}${s.pr_mentions_issue === null || s.pr_mentions_issue === undefined ? '' : s.pr_mentions_issue ? ' · its text names the issue (a hint only)' : ' · its text does NOT name the issue'}`, 'quiet'));
      }
      const links = el('ul'); s.sources.forEach((u) => { const li = el('li'); li.append(source(u)); links.append(li); });
      card.append(el('h4', 'Sources'), links, el('p', `Link flags: ${s.flags.join(', ') || 'none'}`), el('p', `Self-reported model: ${s.model || 'not supplied'} · Token estimate: ${s.tokens_est ?? 'not supplied'}`, 'quiet'), el('h4', 'AI pre-screen · advisory'), el('pre', s.prescreen ? JSON.stringify(s.prescreen, null, 2) : 'Waiting for pre-screen. Refresh to check.'));
      const reason = el('textarea'); reason.setAttribute('maxlength', '500'); reason.setAttribute('required', ''); reason.value = notes.get(s.id) || '';
      reason.addEventListener('input', () => notes.set(s.id, reason.value));
      const label = el('label', 'Review reason (required)'); label.append(reason); card.append(label);
      const controls = el('div', null, 'ops-actions');
      ['accept', 'reject'].forEach((decision) => controls.append(button(decision === 'accept' ? 'Accept' : 'Reject', async () => {
        if (!reason.value.trim()) { reason.reportValidity(); reason.focus(); throw new Error('Enter a review reason.'); }
        await action('review', { id: s.id, decision, note: reason.value }); notes.delete(s.id);
      }, 'btn btn-outline-dark btn-sm')));
      card.append(controls); host.append(card);
    });
  }
  function renderHeld(data) {
    const host = $('held-data'); clear(host);
    if (!data.held.length) host.append(el('p', 'No held tasks.', 'quiet'));
    data.held.forEach((t) => {
      const card = el('article', null, 'ops-card');
      card.append(el('h3', `#${t.id} · ${t.title}`), el('p', `${t.project} · ${t.status} · Held: ${t.held_reason}`), el('pre', t.brief), button('Re-screen now', () => action('sync', { project: t.project })));
      host.append(card);
    });
  }
  function renderProjects(data) {
    const host = $('project-data'); clear(host);
    data.projects.forEach((p) => {
      const card = el('article', null, 'ops-card'); card.append(el('h3', p.name), el('p', `${p.pending} pending · Reviewer: ${p.reviewer} · ${p.active ? 'active' : 'inactive'}`));
      const pause = el('input'); pause.setAttribute('type', 'checkbox'); pause.checked = !!p.paused;
      const pl = el('label'); pl.append(pause, document.createTextNode('Pause new assignments'));
      const capacity = el('input'); capacity.setAttribute('type', 'number'); capacity.setAttribute('min', '1'); capacity.setAttribute('max', '100'); capacity.setAttribute('required', ''); capacity.value = p.max_pending;
      const cl = el('label', 'Reviewer capacity (1–100 pending)'); cl.append(capacity);
      const controls = el('div', null, 'ops-actions'); controls.append(button('Save project', () => {
        if (!capacity.reportValidity()) throw new Error('Capacity must be a whole number from 1 to 100.');
        return action('project', { id: p.id, paused: pause.checked, max_pending: Number(capacity.value) });
      }));
      if (p.sync_supported) controls.append(button('Sync now', () => action('sync', { project: p.id })));
      card.append(pl, cl, controls); host.append(card);
    });
  }
  function renderAudit(data, append = false) {
    const host = $('event-data'); if (!append) clear(host);
    host.append(table(['Time', 'Event', 'Contributor', 'Task / submission', 'Actor', 'Detail (untrusted data)'], data.events.map((e) => [date(e.ts), e.type, e.contributor, `${e.task ?? '—'} / ${e.submission ?? '—'}`, e.actor, el('pre', e.detail || '')])));
    cursor = data.next_before; $('more-events').hidden = cursor === null;
    if (append) return;
    const signals = $('signal-data'); clear(signals);
    const s = data.signals;
    const rows = [
      ['Pairings near cap · last 24h · cap 5 per network', ['Network-day hash', 'Pairings'], s.pairings_near_cap.map((r) => [r.network_day, r.pairings])],
      ['Claim churn · last 24h', ['Contributor', 'Claims', 'Releases', 'Expiries'], s.claim_churn_24h.map((r) => [r.handle, r.claims, r.releases, r.expires])],
      ['Rejected ratio · all reviewed work', ['Contributor', 'Reviewed', 'Rejected', 'Ratio'], s.rejected_ratios_all_time.map((r) => [r.handle, r.reviewed, r.rejected, `${Math.round(r.rejected_ratio * 100)}%`])],
      ['Link-flagged submissions · latest 100', ['Submission', 'Contributor', 'Status', 'Flags'], s.link_flagged.map((r) => [r.id, r.handle, r.status, r.flags.join(', ')])],
    ];
    rows.forEach(([title, headers, values]) => { signals.append(el('h3', title)); signals.append(values.length ? table(headers, values) : el('p', 'No signals.', 'quiet')); });
    const revokeHost = $('revoke-data'); clear(revokeHost);
    const people = new Map([...s.claim_churn_24h, ...s.rejected_ratios_all_time, ...s.link_flagged].map((r) => [r.contributor_id, r.handle]));
    const label = el('label', 'Contributor to revoke'), select = el('select');
    const empty = el('option', 'Choose a contributor'); empty.value = ''; select.append(empty);
    people.forEach((handle, id) => { const opt = el('option', `${handle} (#${id})`); opt.value = id; select.append(opt); }); label.append(select);
    const idInput = el('input'); idInput.setAttribute('type', 'number'); idInput.setAttribute('min', '1');
    const idLabel = el('label', 'Or contributor ID from an event'); idLabel.append(idInput);
    const confirm = el('input'); confirm.setAttribute('type', 'checkbox'); const confirmLabel = el('label'); confirmLabel.append(confirm, document.createTextNode('Revoke this key permanently; keep receipts and history.'));
    revokeHost.append(label, idLabel, confirmLabel, button('Revoke contributor', () => {
      const id = Number(idInput.value || select.value);
      if (!confirm.checked || !Number.isSafeInteger(id) || id < 1) throw new Error('Choose a contributor and check the revocation box.');
      return action('revoke', { contributor_id: id });
    }));
  }
  async function load() {
    $('refresh').disabled = true;
    try {
      const [overview, pending, held, projects, audit] = await Promise.all(['overview', 'pending', 'held', 'projects', 'audit'].map((p) => api(p)));
      renderOverview(overview); renderReviews(pending); renderHeld(held); renderProjects(projects); renderAudit(audit);
      $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } finally { $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', () => load().then(() => { $('message').textContent = 'Live state refreshed.'; }).catch((e) => { $('message').textContent = e.message; }));
  $('more-events').addEventListener('click', async () => {
    $('more-events').disabled = true;
    try { if (cursor !== null) renderAudit(await api(`audit?before=${cursor}`), true); }
    catch (e) { $('message').textContent = e.message; }
    finally { $('more-events').disabled = false; }
  });
  load().catch((e) => { $('message').textContent = e.message; $('updated').textContent = 'Could not load live state'; });
})();
