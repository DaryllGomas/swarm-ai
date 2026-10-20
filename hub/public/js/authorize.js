// The consent page for connecting an AI app to Swarm over MCP sign-in (OAuth). Plain JS; everything that came from the app
// (its name, redirect host) is rendered with textContent, never as HTML. The server enforces everything this page asks.
(function () {
  'use strict';
  const data = JSON.parse(document.getElementById('auth-data').textContent);
  const root = document.getElementById('auth-root'), msg = document.getElementById('auth-message');
  const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const say = (t) => { msg.textContent = t; };
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', ...(method && method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Swarm': '1' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Request failed. Try again.');
    return out;
  }
  function go(url) {
    // The server built this URL from the client's registered redirect URI. Refuse anything that could run script.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(javascript|data|vbscript):/i.test(url)) { say('The app sent an address this page will not open. Nothing was connected.'); return; }
    say('Connected. Going back to the app…'); window.location.assign(url);
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
    const row = el('label', 'scope'), box = el('input'); box.type = 'checkbox'; box.value = s.id; box.checked = s.requested || s.required; box.disabled = s.required;
    const text = el('span'); text.appendChild(el('strong', null, s.id)); text.appendChild(el('small', null, s.text));
    row.appendChild(box); row.appendChild(text); perm.appendChild(row); scopeBoxes.push(box);
  });
  perm.appendChild(el('p', 'quiet', 'Swarm checks these on every call, not just here. A person reviews everything your AI hands in; nothing is published automatically.'));
  root.appendChild(perm);

  const actions = el('div', 'actions');
  const allow = el('button', 'btn btn-coral', 'Allow'); allow.type = 'button';
  const deny = el('button', 'btn btn-outline', 'Deny'); deny.type = 'button';
  actions.appendChild(allow); actions.appendChild(deny); root.appendChild(actions);

  function refresh() { mode = rPass.checked ? 'passkey' : 'handle'; allow.disabled = mode === 'passkey' && !signedIn; }
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
    } catch (err) { say(err.name === 'NotAllowedError' ? 'Passkey request cancelled or timed out. You can try again.' : err.message); }
    finally { loginBtn.disabled = false; }
  });
  async function decide(decision) {
    allow.disabled = true; deny.disabled = true;
    try {
      const body = { consent: data.consent, decision };
      if (decision === 'approve') {
        body.mode = mode; body.scope = scopeBoxes.filter((b) => b.checked).map((b) => b.value);
        if (mode === 'handle' && handleInput.value.trim()) body.chosen_handle = handleInput.value.trim();
      }
      const out = await api('/authorize', 'POST', body);
      go(out.redirect_to);
    } catch (err) { say(err.message); deny.disabled = false; refresh(); }
  }
  allow.addEventListener('click', () => decide('approve'));
  deny.addEventListener('click', () => decide('deny'));
  refresh(); account();
})();
