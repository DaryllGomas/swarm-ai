// Privacy choices (credit, history, research), anonymous credit on receipts, minimised public receipts, and the k-anonymity rule.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { BODY, SOURCE, addTask, newUser, resetDb, review, send, tool } from './helpers.js';
import { NO_NOISE, linkedUser, mePost, meGet, publicAllocation, setupProjects, voter } from './voter.js';
import { options, passkey, post } from './passkeys.js';
import { publishSnapshot } from '../src/voting.js';
import { weekStats } from '../src/core.js';
import { weekStartMs } from '../src/lib.js';
import { CHOICE_TEXT, DEFAULT_CHOICES, K_MIN, creditedAs, kCount, parseChoices, publicHandle } from '../src/privacy.js';
import commonJs from '../public/js/common.js?raw';

beforeEach(async () => {
  await resetDb();
  await setupProjects();
  await publicAllocation({ 'town-hall': 5000, 'swarm-ai': 5000 });
});

// Register a passkey account, optionally with choices, the way the page does.
async function register(privacy) {
  const k = await passkey(), o = await options('register', { ip: k.ip });
  const wire = await k.wire(o.data, 'register');
  const res = await post('/api/account/register/verify', { ...wire, ...(privacy === undefined ? {} : { privacy }) }, { ip: k.ip, cookie: o.cookie });
  return { res, cookie: res.headers.get('Set-Cookie')?.split(';')[0], k };
}
const accountRow = (cookie) => env.DB.prepare('SELECT a.* FROM accounts a JOIN sessions s ON s.account = a.id WHERE s.hash = ?1').bind(cookie).first();

async function accepted(user, { model, tokens_est } = {}) {
  const t = await addTask({ units: 3 });
  const c = await user.call('claim_task', { id: t });
  expect(c.isError, c.text).toBe(false);
  const s = await user.call('submit_work', { task_id: t, body: BODY, sources: [SOURCE], ...(model ? { model } : {}), ...(tokens_est !== undefined ? { tokens_est } : {}) });
  expect(s.isError, s.text).toBe(false);
  expect((await review(s.data.submission_id, 'accept', 'ok')).status).toBe(200);
  return { task: t, submission: s.data.submission_id };
}
const receipts = async () => (await (await send('/api/receipts')).json()).receipts;

describe('the three choices default to private', () => {
  it('a voter who just registers gets credit anonymous, history private, research aggregate, and no research id', async () => {
    const { res, cookie } = await register();
    expect(res.status).toBe(200);
    const a = await env.DB.prepare('SELECT credit, history, research, research_id FROM accounts ORDER BY created DESC LIMIT 1').first();
    expect(a).toEqual({ credit: 'anonymous', history: 'private', research: 'aggregate', research_id: null });
    const me = await (await send('/api/me', { headers: { Cookie: cookie } })).json();
    expect(me.privacy).toMatchObject({ credit: 'anonymous', history: 'private', research: 'aggregate', research_id: null, policy: '/privacy' });
  });

  it('sign-up can carry the three choices, and a research id appears only for share_pseudonymous', async () => {
    const { res, cookie } = await register({ credit: 'handle', history: 'weekly_purge', research: 'share_pseudonymous' });
    expect(res.status).toBe(200);
    const a = await accountRow((await import('../src/lib.js')).sha256 ? await (async () => { const { sha256 } = await import('../src/lib.js'); return sha256(`${env.HASH_SALT}|session|${cookie.split('=')[1]}`); })() : '');
    expect(a).toMatchObject({ credit: 'handle', history: 'weekly_purge', research: 'share_pseudonymous' });
    expect(a.research_id).toMatch(/^r-[a-z0-9]{16}$/);
    expect(a.research_id).not.toContain(a.id); // never derived from the account
  });

  it('refuses an unknown value and a non-object, before anything is created', async () => {
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n;
    for (const bad of [{ credit: 'public' }, { history: 'forever' }, { research: 'sell' }, { credit: 5 }, [], 'handle', null]) {
      const { res } = await register(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n).toBe(before);
  });

  it('contributors with no account default to anonymous credit too', async () => {
    const u = await newUser();
    expect((await env.DB.prepare('SELECT credit, removed FROM contributors WHERE handle = ?1').bind(u.handle).first())).toEqual({ credit: 'anonymous', removed: 0 });
    const w = await u.call('my_work');
    expect(w.data.credit).toMatchObject({ value: 'anonymous' });
  });

  it('parseChoices accepts any subset and the defaults are the private ones', () => {
    expect(DEFAULT_CHOICES).toEqual({ credit: 'anonymous', history: 'private', research: 'aggregate' });
    expect(parseChoices({ history: 'weekly_purge' })).toEqual({ choices: { history: 'weekly_purge' } });
    expect(parseChoices({})).toEqual({ choices: {} });
    expect(parseChoices({ credit: 'x' }).error).toMatch(/credit must be one of/);
  });
});

describe('editing the choices on /me', () => {
  it('changes any subset, explains each value in one sentence, and links to the privacy page', async () => {
    const v = await voter();
    const r = await (await mePost('/api/me/privacy', v, { history: 'weekly_purge' })).json();
    expect(r.privacy).toMatchObject({ credit: 'anonymous', history: 'weekly_purge', research: 'aggregate', policy: '/privacy' });
    expect(r.privacy.explain.history).toBe(CHOICE_TEXT.history.weekly_purge);
    for (const k of Object.keys(CHOICE_TEXT)) for (const v of Object.values(CHOICE_TEXT[k])) {
      expect(v.split(/(?<=[.!?])\s/).length, v).toBe(1); // one sentence
      expect(commonJs, v).toContain(v); // the page shows the same sentence
    }
    const me = await (await meGet(v)).json();
    expect(me.privacy.values.research.map((x) => x.value)).toEqual(['aggregate', 'share_pseudonymous']);
  });

  it('is a guarded write: needs a session, the exact Origin and X-Swarm, and a valid body', async () => {
    const v = await voter();
    expect((await mePost('/api/me/privacy', null, { credit: 'handle' })).status).toBe(401);
    expect((await mePost('/api/me/privacy', v, { credit: 'handle' }, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    expect((await mePost('/api/me/privacy', v, { credit: 'public' })).status).toBe(400);
    expect((await mePost('/api/me/privacy', v, {})).status).toBe(400);
    expect((await send('/api/me/privacy')).status).toBe(405);
  });

  it('a research id is made when sharing is turned on, dropped when it is turned off, and a new one is unrelated to the old', async () => {
    const v = await voter();
    const on = (await (await mePost('/api/me/privacy', v, { research: 'share_pseudonymous' })).json()).privacy;
    expect(on.research_id).toMatch(/^r-/);
    expect((await mePost('/api/me/privacy', v, { credit: 'handle' }).then((r) => r.json())).privacy.research_id).toBe(on.research_id); // unrelated edits keep it
    const off = (await (await mePost('/api/me/privacy', v, { research: 'aggregate' })).json()).privacy;
    expect(off.research_id).toBeNull();
    expect((await env.DB.prepare('SELECT research_id FROM accounts WHERE id = ?1').bind(v.id).first()).research_id).toBeNull();
    const again = (await (await mePost('/api/me/privacy', v, { research: 'share_pseudonymous' })).json()).privacy;
    expect(again.research_id).not.toBe(on.research_id);
  });

  it('linked contributors follow the account credit, now and when they are linked later', async () => {
    const v = await voter();
    const u = await linkedUser(v);
    const credit = () => env.DB.prepare('SELECT credit FROM contributors WHERE handle = ?1').bind(u.handle).first().then((r) => r.credit);
    expect(await credit()).toBe('anonymous');
    await mePost('/api/me/privacy', v, { credit: 'handle' });
    expect(await credit()).toBe('handle');
    await mePost('/api/me/privacy', v, { credit: 'anonymous' });
    expect(await credit()).toBe('anonymous');
    // An account already set to handle credit passes it to a contributor linked afterwards.
    const v2 = await voter(); await mePost('/api/me/privacy', v2, { credit: 'handle' });
    const u2 = await linkedUser(v2);
    expect((await env.DB.prepare('SELECT credit FROM contributors WHERE handle = ?1').bind(u2.handle).first()).credit).toBe('handle');
  });
});

describe('set_credit for contributors without an account', () => {
  it('turns handle credit on and off, and refuses once an account owns the contributor', async () => {
    const u = await newUser();
    expect((await u.call('set_credit', { credit: 'handle' })).data.credit).toBe('handle');
    expect((await env.DB.prepare('SELECT credit FROM contributors WHERE handle = ?1').bind(u.handle).first()).credit).toBe('handle');
    expect((await u.call('set_credit', { credit: 'anonymous' })).data.credit).toBe('anonymous');
    const v = await voter(); const l = await linkedUser(v);
    const r = await l.call('set_credit', { credit: 'handle' });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/follows your Swarm voter account/);
    expect((await tool('set_credit', { credit: 'handle' })).isError).toBe(true); // needs a key
  });
});

describe('public receipts', () => {
  it('say "a contributor" by default, and show the handle only for handle credit, past receipts included', async () => {
    const u = await newUser({ handle: 'proud-worker' });
    const { submission } = await accepted(u);
    let r = (await receipts()).find((x) => x.id === submission);
    expect(r.handle).toBeNull(); expect(r.credited_as).toBe('a contributor');
    expect(JSON.stringify(await receipts())).not.toContain('proud-worker');

    await u.call('set_credit', { credit: 'handle' });
    r = (await receipts()).find((x) => x.id === submission);
    expect(r.handle).toBe('proud-worker'); expect(r.credited_as).toBe('proud-worker');

    // Switching back hides the handle on the SAME past receipt: it is computed when the receipt is read.
    await u.call('set_credit', { credit: 'anonymous' });
    r = (await receipts()).find((x) => x.id === submission);
    expect(r.handle).toBeNull();
    expect(JSON.stringify(await receipts())).not.toContain('proud-worker');
  });

  it('follow the account: switching a linked voter to anonymous hides the handle on past receipts', async () => {
    const v = await voter(); await mePost('/api/me/privacy', v, { credit: 'handle' });
    const u = await linkedUser(v, { handle: 'linked-worker' });
    const { submission } = await accepted(u);
    expect((await receipts()).find((x) => x.id === submission).credited_as).toBe('linked-worker');
    await mePost('/api/me/privacy', v, { credit: 'anonymous' });
    expect((await receipts()).find((x) => x.id === submission).credited_as).toBe('a contributor');
  });

  it('show the UTC day only, and no model, token or time figures', async () => {
    const u = await newUser();
    await accepted(u, { model: 'claude-opus-secret-name', tokens_est: 123456 });
    const res = await send('/api/receipts'); const text = await res.text();
    const r = JSON.parse(text).receipts[0];
    expect(r.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.self_reported).toBeUndefined();
    for (const secret of ['claude-opus-secret-name', '123456', 'tokens_est', '"model"']) expect(text, secret).not.toContain(secret);
    expect(JSON.parse(text).note).not.toMatch(/self-reported by the contributor/);
  });

  it('keep the self-reported model and tokens for the contributor on /me and for the reviewer', async () => {
    const v = await voter();
    const u = await linkedUser(v);
    const { submission } = await accepted(u, { model: 'a-model', tokens_est: 1500 });
    const me = await (await meGet(v)).json();
    expect(me.week.receipts.find((x) => x.id === submission).self_reported).toEqual({ model: 'a-model', tokens_est: 1500 });
    const t2 = await addTask(); await u.call('claim_task', { id: t2 });
    const s2 = await u.call('submit_work', { task_id: t2, body: BODY, sources: [SOURCE], model: 'rev-model', tokens_est: 9 });
    const pending = await (await send('/api/admin/pending', { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } })).json();
    expect(pending.pending.find((x) => x.id === s2.data.submission_id)).toMatchObject({ model: 'rev-model', tokens_est: 9 });
  });

  it('a PR receipt always links the pull request, and names its author only for handle credit', async () => {
    const u = await newUser({ handle: 'pr-worker' });
    const { submission } = await accepted(u);
    await env.DB.prepare("UPDATE projects SET repo = 'DaryllGomas/swarm-ai' WHERE id = 'swarm-ai'").run();
    await env.DB.prepare("UPDATE tasks SET project = 'swarm-ai' WHERE id = (SELECT task FROM submissions WHERE id = ?1)").bind(submission).run();
    await env.DB.prepare("UPDATE submissions SET pr_number = 7, pr_author = 'octo-dev', pr_state = 'merged' WHERE id = ?1").bind(submission).run();
    let r = (await receipts()).find((x) => x.id === submission);
    expect(r.github).toEqual({ repo: 'DaryllGomas/swarm-ai', pr_number: 7, pr_author: null, pr_url: 'https://github.com/DaryllGomas/swarm-ai/pull/7' });
    expect(JSON.stringify(await receipts())).not.toContain('octo-dev');
    await u.call('set_credit', { credit: 'handle' });
    r = (await receipts()).find((x) => x.id === submission);
    expect(r.github.pr_author).toBe('octo-dev');
  });

  it('the Town Hall publisher export gets the handle only for handle credit', async () => {
    const u = await newUser({ handle: 'writer-one' });
    const { submission } = await accepted(u);
    const get = async () => (await (await send(`/api/admin/submission?id=${submission}`, { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } })).json()).submission;
    expect((await get()).handle).toBeNull();
    await u.call('set_credit', { credit: 'handle' });
    expect((await get()).handle).toBe('writer-one');
  });

  it('creditedAs and publicHandle', () => {
    expect(creditedAs({ handle: 'x', credit: 'anonymous', removed: 0 })).toBe('a contributor');
    expect(creditedAs({ handle: 'x', credit: 'handle', removed: 0 })).toBe('x');
    expect(creditedAs({ handle: 'x', credit: 'handle', removed: 1 })).toBe('removed contributor');
    expect(publicHandle({ handle: 'x', credit: 'handle', removed: 1 })).toBeNull();
  });
});

describe('k-anonymity: a public count of people below 5 is not shown', () => {
  it('kCount shows 5 and more, 0, and "fewer than 5" in between', () => {
    expect(K_MIN).toBe(5);
    expect([0, 1, 4, 5, 6, 1000].map((n) => kCount(n))).toEqual([0, 'fewer than 5', 'fewer than 5', 5, 6, 1000]);
    expect(kCount(3, '<5')).toBe('<5');
  });

  async function reset() {
    await env.DB.batch([env.DB.prepare('UPDATE accounts SET suspended = 1'), env.DB.prepare('DELETE FROM vote_snapshots')]);
  }

  // A ballot saved before this week's Monday counts in the snapshot.
  const snapVoter = async () => {
    const v = await voter({ allocations: null });
    await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(v.id, JSON.stringify({ 'town-hall': 100 }), weekStartMs() - 1).run();
    return v;
  };

  it('the vote audit has no per-day counts and no live eligible-voter count, even with 5 ballots on a day', async () => {
    await reset();
    const day = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 20 * 86400000 + 3600000;
    for (let i = 0; i < 5; i++) await env.DB.prepare('INSERT INTO ballot_versions(account, version, allocations, created) VALUES (?1, 1, ?2, ?3)').bind(`k-${i}`, JSON.stringify({ 'town-hall': 100 }), day).run();
    for (let i = 0; i < 6; i++) await voter();
    const a = await (await send('/api/vote/audit')).json();
    expect(a.ballots_per_day).toBeUndefined();
    expect(a.eligible_voter_count).toBeUndefined();
    expect(JSON.stringify(a)).not.toMatch(/ballots_per_day|eligible_voter/);
  });

  it('snapshot voter counts and the current allocation follow the same rule, and there is no projection', async () => {
    await reset();
    for (let i = 0; i < 3; i++) await snapVoter();
    await publishSnapshot(env, Date.now(), NO_NOISE);
    // Fewer than 5 eligible ballots: a fallback, and not even the count is kept.
    expect(await env.DB.prepare('SELECT voter_count, source FROM vote_snapshots').first()).toEqual({ voter_count: 0, source: 'fallback' });
    const audit = await (await send('/api/vote/audit')).json();
    expect(audit.snapshot_history[0].voter_count).toBe('not published');
    expect((await (await send('/api/vote/current')).json()).voter_count).toBe('not published');
    expect((await send('/api/vote/next')).status).toBe(404);
  });

  it('live stats carry no count of people, no self-picked or ballot-directed units; analytics shows a coarse range', async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await newUser());
    for (const u of users) { const t = await addTask({ units: 3, project: 'town-hall' }); expect((await u.call('claim_task', { id: t })).isError).toBe(false); }
    const s = await weekStats(env);
    const th = s.projects.find((p) => p.id === 'town-hall');
    for (const gone of ['contributors_this_week', 'self_directed_units', 'ballot_directed_units', 'active_claims', 'pending_reviews', 'routed_released_or_expired_units', 'reviewer_capacity']) expect(th[gone], gone).toBeUndefined();
    expect(s.totals.contributors).toBeUndefined();
    expect(s.routing_origins).toBeUndefined();
    const api = await (await send('/api/stats')).json();
    expect(JSON.stringify(api)).not.toMatch(/contributors|self_directed|ballot_directed|active_claims|pending_reviews/);
  });
});
