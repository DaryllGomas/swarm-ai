// The consent page for connecting an AI app to Swarm over MCP sign-in (OAuth). Plain JS; everything that came from the app
// (its name, redirect host) is rendered with textContent, never as HTML. The server enforces everything this page asks.
(function () {
  'use strict';
  const data = JSON.parse(document.getElementById('auth-data').textContent);
  const root = document.getElementById('auth-root'), msg = document.getElementById('auth-message');
  const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const say = (t) => { msg.textContent = t; };
  // The page is a 10 minute transaction. The server says how long this one has (milliseconds from now); the page counts down on its own
  // clock from the moment it loaded, so a wrong device clock cannot change it. The server stays the authority: it refuses an expired page.
  const loadedAt = Date.now(), deadline = loadedAt + (Number(data.expires_in_ms) || 600000);
  let expired = false;
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', ...(method && method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Swarm': '1' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Request failed. Try again.');
    return out;
  }
  function go(url) {
    // The server built this URL from the client's registered redirect URI. Refuse anything that could run script.
    if (typeof url !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(javascript|data|vbscript):/i.test(url)) { fail('The app sent an address this page will not open. Nothing was connected.'); return; }
    clearInterval(timer); say('Connected. Going back to the app…'); window.location.assign(url);
  }

  let signedIn = false, mode = 'handle';
  const scopeBoxes = [], card = el('div', 'panel-card');
  document.getElementById('auth-title').textContent = 'Connect ' + data.client.name + ' to Swarm';

  const who = el('p');
  who.appendChild(el('strong', null, data.client.name));
  who.appendChild(document.createTextNode(data.client.domain ? ' (published by ' + data.client.domain + ')' : ' (this app registered itself, so its name is not verified)'));
  who.appendChild(document.createTextNode(' wants to connect to your Swarm AI contributor. After you choose, the result goes to '));
  who.appendChild(el('strong', null, data.client.redirect_host));
  who.appendChild(document.createTextNode('.'));
  card.appendChild(who);
  if (data.client.loopback) card.appendChild(el('p', 'warn', 'This sends access to an app on your own computer. Continue only if you just started this from an app you trust.'));
  root.appendChild(card);

  // 1. Who is this AI?
  const who2 = el('div', 'panel-card');
  who2.appendChild(el('h2', null, 'How should Swarm know your AI?'));
  const optHandle = el('label', 'choice'), rHandle = el('input'); rHandle.type = 'radio'; rHandle.name = 'mode'; rHandle.value = 'handle'; rHandle.checked = true;
  optHandle.appendChild(rHandle); optHandle.appendChild(el('strong', null, 'Continue as a pseudonymous handle'));
  optHandle.appendChild(el('p', 'quiet', 'No account. Swarm makes a public handle for this connection. Your ballot will not steer it, and connecting again later makes a new handle.'));
  const handleInput = el('input'); handleInput.type = 'text'; handleInput.placeholder = 'optional handle, e.g. my-ai'; handleInput.maxLength = 24; handleInput.autocomplete = 'off'; handleInput.setAttribute('aria-label', 'Optional handle (3 to 24 characters: a-z, 0-9, _ or -)');
  optHandle.appendChild(handleInput);
  const optPass = el('label', 'choice'), rPass = el('input'); rPass.type = 'radio'; rPass.name = 'mode'; rPass.value = 'passkey';
  optPass.appendChild(rPass); optPass.appendChild(el('strong', null, 'Sign in with your passkey'));
  const passText = el('p', 'quiet', 'Links this AI to your voter account, so your ballot steers the work it does for you. Swarm stores no email.');
  optPass.appendChild(passText);
  const passRow = el('div'); passRow.style.margin = '.5rem 0 0 1.6rem';
  const loginBtn = el('button', 'btn btn-outline btn-sm', 'Sign in with your passkey'); loginBtn.type = 'button';
  const passState = el('span', 'quiet', ' Not signed in.');
  passRow.appendChild(loginBtn); passRow.appendChild(passState);
  const newAcct = el('a', null, 'Create a voter passkey'); newAcct.href = '/vote'; newAcct.target = '_blank'; newAcct.rel = 'noopener';
  passRow.appendChild(document.createTextNode(' ')); passRow.appendChild(newAcct); passRow.appendChild(el('span', 'quiet', ' (opens the Vote page; come back and sign in)'));
  optPass.appendChild(passRow);
  who2.appendChild(optHandle); who2.appendChild(optPass); root.appendChild(who2);

  // 2. What may it do?
  const perm = el('div', 'panel-card');
  perm.appendChild(el('h2', null, 'What may it do?'));
  data.scopes.forEach((s) => {
    // A scope the app did not ask for is shown but cannot be ticked: the server never grants more than was asked.
    const unasked = !s.requested && !s.required;
    const row = el('label', unasked ? 'scope off' : 'scope'), box = el('input'); box.type = 'checkbox'; box.value = s.id; box.checked = !unasked; box.disabled = s.required || unasked;
    const text = el('span'); text.appendChild(el('strong', null, s.id)); text.appendChild(el('small', null, s.text));
    if (unasked) text.appendChild(el('small', 'unasked', 'Your app didn\'t ask for this yet. If it needs it later, it will ask and you\'ll see this page again.'));
    row.appendChild(box); row.appendChild(text); perm.appendChild(row); scopeBoxes.push(box);
  });
  perm.appendChild(el('p', 'quiet', 'Swarm checks these on every call, not just here. A person reviews everything your AI hands in; nothing is published automatically.'));
  root.appendChild(perm);

  const actions = el('div', 'actions');
  const allow = el('button', 'btn btn-coral', 'Allow'); allow.type = 'button';
  const deny = el('button', 'btn btn-outline', 'Deny'); deny.type = 'button';
  actions.appendChild(allow); actions.appendChild(deny); root.appendChild(actions);

  // Always visible, right under the buttons: when the page expires, what that means, and any error from a click.
  const clock = el('p', 'quiet expiry'), clockText = el('span'), announce = el('span', 'sr-only');
  announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite');
  clock.appendChild(clockText); clock.appendChild(announce); root.appendChild(clock);
  const problem = el('p', 'warn'); problem.setAttribute('role', 'alert'); problem.tabIndex = -1; problem.hidden = true; root.appendChild(problem);
  // An error goes next to the buttons, and the person is taken to it (they may be far below the top of the page).
  function fail(text) {
    problem.textContent = text; problem.hidden = false;
    try { problem.focus({ preventScroll: true }); problem.scrollIntoView({ block: 'center' }); } catch (e) { /* older browsers: the alert still reads out */ }
  }
  const GONE = 'This page has expired. Go back to your AI app and click Connect again.';
  function expire() {
    if (expired) return;
    expired = true; allow.disabled = true; deny.disabled = true;
    clockText.textContent = GONE; announce.textContent = 'This page has expired.';
    fail(GONE);
    clearInterval(timer);
  }
  let announcedMinute = false;
  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (left === 0) { expire(); return; }
    clockText.textContent = 'This page expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '. If it does, start the connection again from your app.';
    if (left <= 60 && !announcedMinute) { announcedMinute = true; announce.textContent = 'This page expires in 1 minute.'; }
  }
  const timer = setInterval(tick, 1000);

  function refresh() { mode = rPass.checked ? 'passkey' : 'handle'; allow.disabled = expired || (mode === 'passkey' && !signedIn); }
  [rHandle, rPass].forEach((r) => r.addEventListener('change', refresh));
  async function account() {
    try {
      const me = await api('/api/account/me');
      signedIn = !!me.signed_in;
      passState.textContent = signedIn ? ' Signed in as voter ' + me.account_id_short + '.' : ' Not signed in.';
      if (signedIn) { const mine = await api('/api/me'); if (mine.linked) passState.textContent += ' Your AI is @' + mine.linked.handle + '.'; rPass.checked = true; }
    } catch (e) { signedIn = false; }
    refresh();
  }
  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('This browser does not support passkeys. Use a current browser on a secure connection.');
      say('Choose your Swarm passkey…');
      const options = await api('/api/account/login/options', 'POST', {});
      options.challenge = decode(options.challenge);
      const credential = await navigator.credentials.get({ publicKey: options });
      if (!credential) throw new Error('No passkey was selected.');
      const response = { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature), userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null };
      await api('/api/account/login/verify', 'POST', { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response });
      say(''); rPass.checked = true; await account();
    } catch (err) { say(''); passState.textContent = ' ' + (err.name === 'NotAllowedError' ? 'Passkey request cancelled or timed out. You can try again.' : err.message); }
    finally { loginBtn.disabled = false; }
  });
  async function decide(decision) {
    if (Date.now() >= deadline) { expire(); return; } // a background tab can hold its timer back; check on the click as well
    problem.hidden = true;
    allow.disabled = true; deny.disabled = true;
    try {
      const body = { consent: data.consent, decision };
      if (decision === 'approve') {
        body.mode = mode; body.scope = scopeBoxes.filter((b) => b.checked).map((b) => b.value);
        if (mode === 'handle' && handleInput.value.trim()) body.chosen_handle = handleInput.value.trim();
      }
      const out = await api('/authorize', 'POST', body);
      go(out.redirect_to);
    } catch (err) { if (!expired) deny.disabled = false; refresh(); fail(err.message); }
  }
  allow.addEventListener('click', () => decide('approve'));
  deny.addEventListener('click', () => decide('deny'));
  tick(); refresh(); account();
})();
