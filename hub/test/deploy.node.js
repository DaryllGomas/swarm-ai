// scripts/deploy.sh refuses to deploy a commit that is not on origin/main (after fetching), and passes the commit to the Worker.
// Runs the real script in a throwaway repository with a stub `npm` and `npx`; nothing is deployed and no token is real.
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
  for (const cmd of ['npm', 'npx']) { writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${log}"\n`); chmodSync(path.join(bin, cmd), 0o755); }
  const run = () => spawnSync('bash', [path.join(work, 'hub/scripts/deploy.sh')], { cwd: path.join(work, 'hub'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: 'test-token-not-real' } });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { root, origin, work, run, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('deploys a commit that is on origin/main, passing the commit and build time to wrangler', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const sha = git(f.work, 'rev-parse', 'HEAD');
    assert.match(f.calls(), new RegExp(`npx wrangler deploy --var GIT_COMMIT:${sha} --var BUILT_AT:\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ`));
    assert.match(f.calls(), /npm test/); assert.match(f.calls(), /d1 migrations apply swarm-ai --remote/);
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
    assert.notEqual(again.status, 0); assert.match(again.stderr, /not on origin\/main/);
  } finally { f.cleanup(); }
});

test('refuses when origin cannot be fetched, a dirty tree, or another branch', () => {
  let f = fixture();
  try {
    git(f.work, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /could not fetch origin\/main/); assert.equal(f.calls(), '');
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

test('with arguments it runs wrangler as given and skips the checks (nothing is being deployed)', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, 'dirty.txt'), 'x');
    const r = spawnSync('bash', [path.join(f.work, 'hub/scripts/deploy.sh'), 'secret', 'put', 'X'], { cwd: path.join(f.work, 'hub'), encoding: 'utf8', env: { ...process.env, PATH: `${path.join(f.root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: 'test-token-not-real' } });
    assert.equal(r.status, 0, r.stderr); assert.match(f.calls(), /npx wrangler secret put X/);
  } finally { f.cleanup(); }
});
