// The Phase 4 pages follow the site's security rules: no innerHTML or eval, no inline scripts, no new script origins.
import { describe, expect, it } from 'vitest';
import meHtml from '../public/me.html?raw';
import meJs from '../public/js/me.js?raw';
import authorizeJs from '../public/js/authorize.js?raw';
import liveJs from '../public/js/live.js?raw';
import homeJs from '../public/js/home.js?raw';
import { send } from './helpers.js';

describe('Your Swarm page and the consent script', () => {
  it('render with textContent only', () => {
    for (const [name, src] of [['me.js', meJs], ['authorize.js', authorizeJs], ['live.js', liveJs], ['home.js', homeJs]]) {
      for (const banned of [/innerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /outerHTML/]) expect(src, `${name} ${banned}`).not.toMatch(banned);
    }
  });

  it('me.html has no inline script or handler, loads only same-origin scripts, and says no email', () => {
    expect(meHtml).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(meHtml).not.toMatch(/\son[a-z]+=/i);
    for (const m of meHtml.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) expect(m[1].startsWith('/js/'), m[1]).toBe(true);
    expect(meHtml).toMatch(/no email/i);
    expect(meHtml).toContain('Link my AI');
    expect(meHtml).toContain('/js/me.js');
  });

  it('are served by the site, and the consent script is a static file', async () => {
    expect((await send('/js/authorize.js')).status).toBe(200);
    expect((await send('/js/me.js')).status).toBe(200);
    expect((await send('/css/me.css')).status).toBe(200);
  });

  it('the consent script refuses redirect addresses that run script', () => {
    expect(authorizeJs).toMatch(/javascript\|data\|vbscript/);
  });
});
