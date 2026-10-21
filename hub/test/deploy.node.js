// scripts/deploy.sh: the one checked route deploys only a clean, non-detached main that is the exact tip of a freshly fetched origin/main of the
// canonical repository (and refuses a rewritten origin/main); the maintenance passthrough is an allowlist that deploys nothing, so
// `deploy --var GIT_COMMIT:<anything>` cannot bypass the checks. Runs the real script in a throwaway repository with a stub `npm` and `npx`;
// nothing is deployed and no token is real.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.resolve('scripts/deploy.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-test-'));
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin'), log = path.join(root, 'calls.log');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['clone', '-q', origin, work], { env: { ...process.env, ...GIT_ENV } });
  mkdirSync(path.join(work, 'hub/scripts'), { recursive: true }); mkdirSync(path.join(work, 'hub/node_modules'), { recursive: true });
  copyFileSync(SCRIPT, path.join(work, 'hub/scripts/deploy.sh')); chmodSync(path.join(work, 'hub/scripts/deploy.sh'), 0o755);
  writeFileSync(path.join(work, 'hub/node_modules/.keep'), '');
  git(work, 'checkout', '-q', '-B', 'main'); git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'first'); git(work, 'push', '-q', 'origin', 'main');
  mkdirSync(bin);
  // The npm stub can dirty the tree during `npm test` when STUB_DIRTY_FILE is set (a test that changes the tree while it runs).
  for (const cmd of ['npm', 'npx']) { writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${log}"\nif [ "$1" = test ] && [ -n "$STUB_DIRTY_FILE" ]; then echo x > "$STUB_DIRTY_FILE"; fi\nif [ -n "$STUB_FAIL_D1_EXECUTE" ] && [ "$2" = d1 ] && [ "$3" = execute ]; then exit 1; fi\n`); chmodSync(path.join(bin, cmd), 0o755); }
  const env = (extra = {}) => ({ ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: 'test-token-not-real', SWARM_DEPLOY_ALLOW_ORIGIN: origin, ...extra });
  const run = (extra = {}) => spawnSync('bash', [path.join(work, 'hub/scripts/deploy.sh')], { cwd: path.join(work, 'hub'), encoding: 'utf8', env: env(extra) });
  const pass = (args, extra = {}) => spawnSync('bash', [path.join(work, 'hub/scripts/deploy.sh'), ...args], { cwd: path.join(work, 'hub'), encoding: 'utf8', env: env({ SWARM_DEPLOY_ALLOW_ORIGIN: '', ...extra }) });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { root, origin, work, run, pass, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('deploys a commit that is on origin/main, passing the commit and build time to wrangler', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const sha = git(f.work, 'rev-parse', 'HEAD');
    assert.match(f.calls(), new RegExp(`npx wrangler deploy --var GIT_COMMIT:${sha} --var BUILT_AT:\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ`));
    assert.match(f.calls(), /npm ci/); assert.match(f.calls(), /npm test/); assert.match(f.calls(), /d1 migrations apply swarm-ai --remote/);
  } finally { f.cleanup(); }
});

test('refuses a commit that is not on origin/main, and deploys nothing', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, 'new.txt'), 'local only'); git(f.work, 'add', '-A'); git(f.work, 'commit', '-q', '-m', 'unpushed');
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not on origin\/main/);
    assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
});

test('fetches first: a stale remote-tracking branch does not make an unpublished commit look published', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, 'new.txt'), 'x'); git(f.work, 'add', '-A'); git(f.work, 'commit', '-q', '-m', 'second');
    git(f.work, 'push', '-q', 'origin', 'main'); // origin/main now includes it...
    git(f.work, 'update-ref', 'refs/remotes/origin/main', git(f.work, 'rev-parse', 'HEAD~1')); // ...but the local remote-tracking ref is stale
    const r = f.run();
    assert.equal(r.status, 0, r.stderr); // the script fetched and saw the real origin/main
    // And the opposite: origin was force-moved back, so the local commit is no longer published, though the stale ref says it is.
    git(f.work, 'update-ref', 'refs/remotes/origin/main', git(f.work, 'rev-parse', 'HEAD'));
    execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/main', git(f.work, 'rev-parse', 'HEAD~1')], { env: { ...process.env, ...GIT_ENV } });
    const again = f.run();
    assert.notEqual(again.status, 0); assert.match(again.stderr, /rewritten/); assert.equal(f.calls().split('wrangler deploy').length - 1, 1); // only the first run deployed
  } finally { f.cleanup(); }
});

test('refuses when origin cannot be fetched, a dirty tree, or another branch', () => {
  let f = fixture();
  try {
    git(f.work, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
    const r = f.run({ SWARM_DEPLOY_ALLOW_ORIGIN: path.join(f.root, 'missing.git') }); assert.notEqual(r.status, 0); assert.match(r.stderr, /could not fetch origin\/main/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
  f = fixture();
  try {
    writeFileSync(path.join(f.work, 'dirty.txt'), 'x');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /uncommitted changes/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
  f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feature');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /deploys come from main/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
});

test('detached HEAD, untracked files, a commit behind the tip, and a tree changed while testing are all refused', () => {
  let f = fixture();
  try {
    git(f.work, 'checkout', '-q', '--detach');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /detached HEAD/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
  f = fixture();
  try {
    writeFileSync(path.join(f.work, 'untracked.txt'), 'x');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /uncommitted changes/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
  f = fixture();
  try {
    // origin/main moves ahead; this checkout is an older main commit: an ancestor is NOT enough, it must be the tip.
    writeFileSync(path.join(f.work, 'two.txt'), 'x'); git(f.work, 'add', '-A'); git(f.work, 'commit', '-q', '-m', 'second'); git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'reset', '-q', '--hard', 'HEAD~1');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /not on origin\/main as its current tip/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
  f = fixture();
  try {
    const r = f.run({ STUB_DIRTY_FILE: path.join(f.work, 'made-by-tests.txt') });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /changed while installing or testing/);
    assert.equal(f.calls().includes('wrangler deploy'), false); assert.equal(f.calls().includes('migrations apply'), false);
  } finally { f.cleanup(); }
});

test('the remote must be the canonical public repository', () => {
  const f = fixture();
  try {
    const r = spawnSync('bash', [path.join(f.work, 'hub/scripts/deploy.sh')], { cwd: path.join(f.work, 'hub'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV, PATH: `${path.join(f.root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: 'test-token-not-real' } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not the public repository github\.com\/DaryllGomas\/swarm-ai/); assert.equal(f.calls(), '');
    git(f.work, 'remote', 'set-url', 'origin', 'https://github.com/someone-else/swarm-ai.git');
    const other = f.run({ SWARM_DEPLOY_ALLOW_ORIGIN: '' }); assert.notEqual(other.status, 0); assert.match(other.stderr, /not the public repository/); assert.equal(f.calls(), '');
  } finally { f.cleanup(); }
});

test('the maintenance passthrough is an allowlist: secrets and read-only commands run, anything that could deploy is refused (no GIT_COMMIT bypass)', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, 'dirty.txt'), 'x'); git(f.work, 'checkout', '-q', '-b', 'feature');
    const ok = f.pass(['secret', 'put', 'X']);
    assert.equal(ok.status, 0, ok.stderr); assert.match(f.calls(), /npx wrangler secret put X/);
    for (const args of [['d1', 'execute', 'swarm-ai', '--remote', '--command', 'SELECT 1'], ['d1', 'time-travel', 'info', 'swarm-ai'], ['deployments', 'list']]) assert.equal(f.pass(args).status, 0, args.join(' '));
    const sha = 'a'.repeat(40);
    for (const args of [
      ['deploy', '--var', `GIT_COMMIT:${sha}`], ['deploy'], ['versions', 'upload'], ['versions', 'deploy'], ['rollback'], ['triggers', 'deploy'],
      ['d1', 'migrations', 'apply', 'swarm-ai', '--remote'], ['--config', 'x.toml', 'deploy'], ['secret', 'put', 'X', '--var', `GIT_COMMIT:${sha}`], ['publish'], ['delete'],
    ]) {
      const before = f.calls();
      const r = f.pass(args);
      assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, /Refusing/); assert.equal(f.calls(), before, args.join(' '));
    }
  } finally { f.cleanup(); }
});

test('preflight: a read-only count of ballot-based snapshots runs and is printed BEFORE the migrations; if it cannot run, nothing is migrated or deployed', () => {
  let f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Preflight \(read-only\)/);
    const calls = f.calls().split('\n');
    const pre = calls.findIndex((l) => /d1 execute swarm-ai --remote --command SELECT COUNT\(\*\) AS ballot_snapshots FROM vote_snapshots WHERE source = 'ballots'$/.test(l));
    const mig = calls.findIndex((l) => /d1 migrations apply/.test(l));
    assert.ok(pre >= 0, f.calls()); assert.ok(mig > pre, 'the preflight runs before the migrations');
    // It is a single SELECT: no write keyword in the command.
    assert.doesNotMatch(calls[pre], /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
  } finally { f.cleanup(); }
  f = fixture();
  try {
    const r = f.run({ STUB_FAIL_D1_EXECUTE: '1' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /preflight .* could not run/);
    assert.equal(f.calls().includes('migrations apply'), false); assert.equal(f.calls().includes('wrangler deploy'), false);
  } finally { f.cleanup(); }
});

test('H: secret bulk is not on the maintenance allowlist (file and stdin are not inspected), so it cannot set the stamped commit', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, 'secrets.json'), JSON.stringify({ GIT_COMMIT: 'a'.repeat(40), BUILT_AT: '2026-01-01T00:00:00Z' }));
    git(f.work, 'checkout', '-q', '-b', 'feature');
    for (const args of [['secret', 'bulk', 'secrets.json'], ['secret', 'bulk', '/dev/stdin'], ['secret', 'bulk']]) {
      const before = f.calls();
      const r = f.pass(args);
      assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, /not on the maintenance allowlist/); assert.equal(f.calls(), before, args.join(' '));
    }
    // One at a time still works, and the stamped names are still refused there.
    assert.equal(f.pass(['secret', 'put', 'ADMIN_TOKEN']).status, 0);
    assert.notEqual(f.pass(['secret', 'put', 'GIT_COMMIT']).status, 0);
  } finally { f.cleanup(); }
});
