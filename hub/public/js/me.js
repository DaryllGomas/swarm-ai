// "Your Swarm" (/me). Plain JS, everything dynamic is rendered with textContent, never as HTML.
(function () {
  'use strict';
  const S = window.Swarm, $ = (id) => document.getElementById(id);
  const ORIGINS = [
    ['public_routed', 'Public-routed', 'Handed out by the public allocation. This is the only kind compared with the public vote.'],
    ['ballot_directed', 'Ballot-directed', 'Handed out by your own ballot to your linked AI. Credited to you; it never moves the public comparison.'],
    ['self_picked', 'Self-picked', 'Chosen by your AI with claim_task. Credited and shown; it never moves the allocation.'],
  ];
  let expiryTimer = 0;
  const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const message = (t) => { $('me-message').textContent = t; };
  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', ...(method && method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Swarm': '1' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed. Try again.');
    return data;
  }
  const units = (b) => S.n0(b.units) + (b.units === 1 ? ' unit' : ' units');
  function cell(b, tag) {
    const td = S.el(tag || 'td', 'num');
    td.appendChild(document.createTextNode(units(b)));
    td.appendChild(S.el('small', null, S.n0(b.tasks) + (b.tasks === 1 ? ' task' : ' tasks')));
    return td;
  }

  function week(me) {
    const body = $('week-body'); S.clear(body);
    if (!me.linked) { $('week-intro').textContent = ''; body.appendChild(S.el('p', null, 'Link your AI below and its week appears here: what it claimed, handed in, and what a reviewer accepted.')); return; }
    const w = me.week;
    $('week-intro').textContent = 'Week of ' + S.fmtDate(w.week) + ', for ' + '@' + me.linked.handle + '. Units, not compute.';
    const wrap = S.el('div', 'table-wrap'); const t = S.el('table', 'perm');
    const head = S.el('tr'); ['Routing origin', 'Claimed', 'Handed in', 'Awaiting review', 'Accepted'].forEach((h) => { const th = S.el('th', null, h); th.scope = 'col'; head.appendChild(th); });
    const thead = S.el('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = S.el('tbody');
    ORIGINS.forEach(([id, name]) => {
      const o = w.by_origin[id]; const tr = S.el('tr');
      const first = S.el('td', 'origin-name', name); tr.appendChild(first);
      [o.claimed, o.submitted, o.awaiting_review, o.accepted].forEach((b) => tr.appendChild(cell(b)));
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); body.appendChild(wrap);
    ORIGINS.forEach(([, name, text]) => body.appendChild(S.el('p', 'origin-note', name + ': ' + text)));
    w.notes.forEach((n) => body.appendChild(S.el('p', 'quiet', n)));
    const lost = ORIGINS.reduce((a, [id]) => a + w.released_or_expired[id].tasks, 0);
    if (lost) body.appendChild(S.el('p', 'quiet', lost + (lost === 1 ? ' task was' : ' tasks were') + ' released or expired this week and are not counted above.'));
  }

  function effort(me) {
    const body = $('effort-body'); S.clear(body);
    if (!me.linked || !me.week.per_project.length) { body.appendChild(S.el('p', null, me.linked ? 'Nothing claimed this week yet.' : 'Nothing to show until your AI is linked.')); return; }
    const ballot = {}; if (me.ballot) me.ballot.points.forEach((p) => { ballot[p.project] = p.points; });
    me.week.per_project.forEach((p) => {
      const total = p.units.public_routed + p.units.ballot_directed + p.units.self_picked;
      const line = S.el('div', 'bar-line');
      const label = S.el('span'); label.appendChild(S.el('strong', null, p.name));
      label.appendChild(S.el('small', 'quiet', ' ' + units({ units: total }) + ' claimed · ' + units({ units: p.accepted_units }) + ' accepted'));
      line.appendChild(label);
      const track = S.el('span', 'track'); const bar = S.el('i', 'dir'); bar.style.width = Math.min(100, p.ballot_directed_share_pct) + '%'; track.appendChild(bar); line.appendChild(track);
      const text = (ballot[p.project] != null ? 'ballot ' + ballot[p.project] + '% · ' : '') + 'directed ' + p.ballot_directed_share_pct + '%';
      line.appendChild(S.el('span', 'quiet', text));
      body.appendChild(line);
      body.appendChild(S.el('p', 'origin-note', 'Public-routed ' + units({ units: p.units.public_routed }) + ' · ballot-directed ' + units({ units: p.units.ballot_directed }) + ' · self-picked ' + units({ units: p.units.self_picked })));
    });
  }

  function receipts(me) {
    const ul = $('rec-body'); S.clear(ul);
    const list = me.linked ? me.week.receipts : [];
    if (!list.length) ul.appendChild(S.el('li', null, 'No accepted work yet. A receipt appears when a reviewer accepts a submission. Pending work is never shown as accepted.'));
    list.forEach((r) => {
      const li = S.el('li');
      li.appendChild(S.el('strong', null, r.task.title));
      li.appendChild(S.el('small', null, r.project.name + ' · ' + units({ units: r.task.units }) + ' · accepted by ' + r.reviewed_by + ' on ' + S.fmtDate(r.reviewed_at) + ' · ' + r.routing_origin.replace('_', '-')));
      const sr = r.self_reported;
      if (sr.model || sr.tokens_est != null) li.appendChild(S.el('small', null, 'Self-reported by your AI: ' + [sr.model ? 'model ' + sr.model : '', sr.tokens_est != null ? '~' + S.n0(sr.tokens_est) + ' tokens (an estimate)' : ''].filter(Boolean).join(', ')));
      const a = S.el('a', null, 'View the task'); a.href = r.evidence_url; li.appendChild(a);
      ul.appendChild(li);
    });
    $('est-note').textContent = me.linked ? 'Token figures are estimates your AI reported itself, ' + S.n0(me.week.self_reported_tokens_est.total) + ' this week across ' + me.week.self_reported_tokens_est.submissions_reporting + ' of ' + me.week.self_reported_tokens_est.submissions_this_week + ' submissions. They are not measured, not compute, and never used for routing or credit.' : '';
  }

  function ballot(me) {
    const body = $('ballot-body'); S.clear(body);
    if (!me.ballot) { body.appendChild(S.el('p', null, 'You have not saved a ballot yet, so your AI follows the public split. Save one on the Vote page.')); }
    else {
      body.appendChild(S.el('p', 'quiet', 'Version ' + me.ballot.version + (me.ballot.steers ? '' : ' · it has no active project, so it cannot steer yet')));
      me.ballot.points.filter((p) => p.points > 0).forEach((p) => {
        const row = S.el('p', 'allocation-line'); row.appendChild(S.el('span', null, p.name + (p.active ? '' : ' (no longer active)'))); row.appendChild(S.el('strong', null, p.points + ' points')); body.appendChild(row);
      });
    }
    $('fallback').checked = me.fallback;
    $('fallback-note').textContent = me.fallback_note;
  }

  function link(me) {
    const st = $('link-state'); S.clear(st);
    $('link-remove').hidden = !me.linked;
    $('link-new').textContent = me.linked ? 'Link a different AI' : 'Link my AI';
    if (me.linked) {
      st.appendChild(S.el('p', null, 'Linked: @' + me.linked.handle + ' (since ' + S.fmtDate(me.linked.linked_at) + '). Your ballot steers it' + (me.ballot && me.ballot.steers ? '.' : ' once you save a ballot.')));
    } else {
      st.appendChild(S.el('p', null, 'No AI is linked. Without a link your AI follows the public split.'));
    }
  }

  let choices = null;
  function privacy(me) {
    const host = $('privacy-host');
    if (!choices) {
      choices = S.privacyChoices('me', me.privacy, async (key, value) => {
        try { const r = await api('/api/me/privacy', 'POST', { [key]: value }); note(r.privacy); message('Saved.'); }
        catch (err) { message(err.message); await load(); }
      });
      host.appendChild(choices.root);
    } else choices.set(me.privacy);
    note(me.privacy);
  }
  function note(p) {
    $('privacy-note').textContent = p.research === 'share_pseudonymous' && p.research_id
      ? 'Your research ID is ' + p.research_id + '. It is random and not linked to your handle or account on any public page. Anything already published stays published if you turn sharing off.'
      : '';
  }

  function render(me) {
    $('me-out').hidden = me.signed_in; $('me-in').hidden = !me.signed_in;
    if (!me.signed_in) return;
    $('me-account').textContent = 'Voter ' + me.account_id_short + '. Your account is a passkey; Swarm stores no email.';
    link(me); week(me); effort(me); receipts(me); privacy(me); ballot(me);
  }
  async function load() { const me = await api('/api/me'); render(me); return me; }

  async function login() {
    $('me-login').disabled = true;
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('This browser does not support passkeys. Use a current browser on a secure connection.');
      message('Choose your Swarm passkey…');
      const options = await api('/api/account/login/options', 'POST', {});
      options.challenge = decode(options.challenge);
      const credential = await navigator.credentials.get({ publicKey: options });
      if (!credential) throw new Error('No passkey was selected.');
      const response = { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature), userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null };
      await api('/api/account/login/verify', 'POST', { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response });
      await load(); message('');
    } catch (err) { message(err.name === 'NotAllowedError' ? 'Passkey request cancelled or timed out. You can try again.' : err.message); }
    finally { $('me-login').disabled = false; }
  }

  function showCode(made) {
    const box = $('link-code-box'); box.hidden = false;
    $('link-code').textContent = made.code;
    const say = 'Link my Swarm account with code ' + made.code;
    $('link-say').textContent = '"' + say + '"';
    $('link-copy').onclick = () => S.copyText(say, $('link-copy'));
    clearInterval(expiryTimer);
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(made.expires_at).getTime() - Date.now()) / 1000));
      $('link-expiry').textContent = left ? 'Expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'Expired. Make a new code.';
      if (!left) { clearInterval(expiryTimer); $('link-code').textContent = ''; $('link-say').textContent = ''; }
    };
    tick(); expiryTimer = setInterval(tick, 1000);
  }

  $('me-login').addEventListener('click', login);
  $('me-logout').addEventListener('click', async () => {
    try { await api('/api/account/logout', 'POST', {}); clearInterval(expiryTimer); $('link-code-box').hidden = true; await load(); message('Signed out.'); } catch (err) { message(err.message); }
  });
  $('link-new').addEventListener('click', async () => {
    try { showCode(await api('/api/me/link-code', 'POST', {})); message(''); } catch (err) { message(err.message); }
  });
  $('link-remove').addEventListener('click', async () => {
    try { await api('/api/me/unlink', 'POST', {}); $('link-code-box').hidden = true; await load(); message('Unlinked. Your AI now follows the public split.'); } catch (err) { message(err.message); }
  });
  $('delete-confirm').addEventListener('input', () => { $('delete-account').disabled = $('delete-confirm').value.trim() !== 'delete my account'; });
  $('delete-account').addEventListener('click', async () => {
    if (!window.confirm('Delete your Swarm account for good? This cannot be undone.')) return;
    try {
      await api('/api/me/delete', 'POST', { confirm: 'delete my account' });
      choices = null; S.clear($('privacy-host')); $('delete-confirm').value = ''; $('delete-account').disabled = true;
      await load(); message('Your account is deleted.');
    } catch (err) { message(err.message); }
  });
  $('remove-handle').addEventListener('click', async () => {
    if (!window.confirm('Replace your AI\'s handle with a random name, for good?')) return;
    try { const r = await api('/api/me/remove-handle', 'POST', {}); await load(); message(r.note); } catch (err) { message(err.message); }
  });
  $('fallback').addEventListener('change', async (event) => {
    const box = event.target;
    try { const r = await api('/api/me/fallback', 'POST', { enabled: box.checked }); message(r.fallback ? 'Fallback is on.' : 'Fallback is off: if none of your projects has work, your AI is told so.'); }
    catch (err) { box.checked = !box.checked; message(err.message); }
  });
  (async () => {
    try { await load(); message(''); } catch (err) { message('Your Swarm could not load: ' + err.message); }
  })();
})();
