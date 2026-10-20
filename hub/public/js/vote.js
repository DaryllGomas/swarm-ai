(function () {
  'use strict';
  const S = window.Swarm, $ = (id) => document.getElementById(id);
  const colors = ['#f2605f', '#a56cf5', '#4aa8ff', '#5fd08a', '#f5c542'];
  let projects = [], rows = [], token = '', widget, saving = false, signupChoices = null;
  const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const message = (text) => { $('vote-message').textContent = text; };
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Swarm': '1' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed. Try again.');
    return data;
  }
  function update() {
    const values = rows.map((r) => Number(r.number.value));
    const valid = values.every((n, i) => rows[i].number.value !== '' && Number.isInteger(n) && n >= 0 && n <= 100);
    const total = values.reduce((a, b) => a + b, 0);
    $('ballot-total').textContent = (valid ? total : 'Invalid') + ' / 100 points' + (valid && total === 100 ? ' · Ready to save' : ' · Allocate exactly 100 integer points');
    $('ring-total').textContent = valid ? String(total) : '—';
    $('save-ballot').disabled = saving || !valid || total !== 100;
    S.clear($('ballot-segments'));
    let offset = 0;
    rows.forEach((r, i) => {
      const n = Math.max(0, Math.min(100 - offset, Number.isFinite(values[i]) ? values[i] : 0));
      if (n > 0) $('ballot-segments').appendChild(S.svg('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: colors[i % colors.length], 'stroke-width': 18, pathLength: 100, 'stroke-dasharray': n + ' ' + (100 - n), 'stroke-dashoffset': -offset }));
      offset += n;
    });
    $('ballot-ring').setAttribute('aria-label', 'Your allocation: ' + rows.map((r, i) => r.project.name + ' ' + values[i] + ' points').join(', '));
  }
  function ballotEditor(ballot) {
    rows = []; S.clear($('ballot-inputs'));
    projects.forEach((p, i) => {
      const row = S.el('div', 'ballot-row'), label = S.el('label', null, p.name);
      const number = S.el('input'), slider = S.el('input');
      number.type = 'number'; number.id = 'points-' + i; label.setAttribute('for', number.id);
      slider.type = 'range'; slider.setAttribute('aria-label', p.name + ' points');
      [number, slider].forEach((input) => { input.min = '0'; input.max = '100'; input.step = '1'; input.value = String(ballot.allocations[p.id] || 0); });
      slider.addEventListener('input', () => { number.value = slider.value; update(); });
      number.addEventListener('input', () => { slider.value = number.value; update(); });
      row.appendChild(label); row.appendChild(slider); row.appendChild(number); $('ballot-inputs').appendChild(row);
      rows.push({ project: p, number, slider });
    });
    $('ballot-version').textContent = ballot.version ? 'Saved ballot · version ' + ballot.version : 'No saved ballot yet.';
    update();
  }
  function allocation(host, data) {
    S.clear(host);
    if (data.projected === false && data.reason && !data.shares) {
      host.appendChild(S.el('p', 'quiet', 'Week of ' + data.week + ' · Not shown: ' + data.reason + '. With so few ballots a projection would reveal them.'));
      return;
    }
    host.appendChild(S.el('p', 'quiet', 'Week of ' + data.week + ' · ' + data.voter_count + ' eligible ballots' + (data.projected ? ' · Projected' : '')));
    if (data.provisional) host.appendChild(S.el('p', 'prov-note', 'Provisional fallback: ' + (data.reason || 'no eligible ballot result') + '. Carrying the previous allocation.'));
    Object.entries(data.shares).forEach(([id, points]) => {
      const row = S.el('p', 'allocation-line'); row.appendChild(S.el('span', null, projects.find((p) => p.id === id)?.name || id));
      row.appendChild(S.el('strong', null, (points / 100).toFixed(2) + '%')); host.appendChild(row);
    });
  }
  async function loadPublic() {
    const [current, next, audit] = await Promise.all([api('/api/vote/current'), api('/api/vote/next'), api('/api/vote/audit')]);
    allocation($('current-allocation'), current); allocation($('next-allocation'), next);
    const host = $('vote-audit'); S.clear(host);
    host.appendChild(S.el('p', null, audit.eligible_voter_count + ' eligible accounts this week. An eligible account may have no valid ballot.'));
    host.appendChild(S.el('h3', null, 'Ballots saved per day · last 30 days'));
    host.appendChild(S.el('p', 'quiet', audit.note));
    const days = S.el('div', 'audit-days');
    audit.ballots_per_day.forEach((d) => days.appendChild(S.el('p', 'allocation-line', d.day + ' · ' + d.ballots)));
    host.appendChild(days); host.appendChild(S.el('h3', null, 'Published snapshots'));
    if (!audit.snapshot_history.length) host.appendChild(S.el('p', 'quiet', 'No weekly snapshot has been published yet.'));
    audit.snapshot_history.forEach((s) => host.appendChild(S.el('p', 'allocation-line', s.week + ' · ' + s.voter_count + ' ballots · ' + (s.source === 'fallback' ? 'Provisional fallback' : 'Ballots') + ' · ' + new Date(s.published_at).toISOString())));
  }
  function humanCheck(siteKey) {
    if (!siteKey) { message('Registration is not configured yet. Existing voters can sign in.'); return; }
    function render() {
      if (widget !== undefined) return;
      widget = window.turnstile.render('#human-check', {
        sitekey: siteKey, action: 'register',
        callback: (value) => { token = value; $('register').disabled = false; },
        'expired-callback': () => { token = ''; $('register').disabled = true; },
        'error-callback': () => { token = ''; $('register').disabled = true; message('Human check unavailable. Try refreshing the page.'); },
      });
    }
    if (window.turnstile) { render(); return; }
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.addEventListener('load', render); script.addEventListener('error', () => message('Human check unavailable. Existing voters can still sign in.'));
    document.head.appendChild(script);
  }
  async function authenticate(kind) {
    $('register').disabled = true; $('login').disabled = true;
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('This browser does not support passkeys. Use a current browser on a secure connection.');
      message(kind === 'register' ? 'Create a passkey with your device…' : 'Choose your Swarm passkey…');
      const options = await api('/api/account/' + kind + '/options', 'POST', kind === 'register' ? { turnstile_token: token } : {});
      options.challenge = decode(options.challenge);
      if (options.user) options.user.id = decode(options.user.id);
      const credential = await navigator.credentials[kind === 'register' ? 'create' : 'get']({ publicKey: options });
      if (!credential) throw new Error('No passkey was selected.');
      const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
      if (kind === 'register') {
        response.attestationObject = encode(credential.response.attestationObject);
        response.transports = credential.response.getTransports ? credential.response.getTransports() : [];
      } else {
        response.authenticatorData = encode(credential.response.authenticatorData); response.signature = encode(credential.response.signature);
        response.userHandle = credential.response.userHandle ? encode(credential.response.userHandle) : null;
      }
      await api('/api/account/' + kind + '/verify', 'POST', { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response, ...(kind === 'register' && signupChoices ? { privacy: signupChoices.get() } : {}) });
      await loadAccount(); message('Signed in. Set your 100 points below.');
    } catch (err) { message(err.name === 'NotAllowedError' ? 'Passkey request cancelled or timed out. You can try again.' : err.message); }
    finally {
      $('login').disabled = false;
      if (kind === 'register') { token = ''; if (window.turnstile && widget !== undefined) window.turnstile.reset(widget); }
      $('register').disabled = !token;
    }
  }
  async function loadAccount() {
    const me = await api('/api/account/me');
    $('signed-out').hidden = me.signed_in; $('signed-in').hidden = !me.signed_in;
    if (me.signed_in) {
      $('account-label').textContent = 'Voter ' + me.account_id_short;
      ballotEditor(await api('/api/ballot'));
    }
    return me;
  }
  $('register').addEventListener('click', () => authenticate('register'));
  $('login').addEventListener('click', () => authenticate('login'));
  $('logout').addEventListener('click', async () => {
    try { await api('/api/account/logout', 'POST', {}); await loadAccount(); if (widget === undefined) humanCheck((await api('/api/vote/config')).site_key); message('Signed out. Your saved ballot still applies.'); }
    catch (err) { message(err.message); }
  });
  $('ballot-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if ($('save-ballot').disabled) return;
    saving = true; update();
    try {
      const allocations = Object.fromEntries(rows.map((r) => [r.project.id, Number(r.number.value)]));
      const result = await api('/api/ballot', 'PUT', { allocations });
      $('ballot-version').textContent = 'Saved ballot · version ' + result.version;
      message('Ballot saved. Your vote applies from next Monday’s snapshot.');
      await loadPublic();
    } catch (err) { message(err.message); }
    finally { saving = false; update(); }
  });
  (async () => {
    try {
      const config = await api('/api/vote/config'); projects = config.projects;
      const me = await loadAccount(); await loadPublic(); message('');
      signupChoices = S.privacyChoices('signup', {});
      $('signup-choices').appendChild(signupChoices.root);
      if (!me.signed_in) humanCheck(config.site_key);
    } catch (err) { message('Voting could not load: ' + err.message); }
  })();
})();
