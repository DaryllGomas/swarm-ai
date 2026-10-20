// Native-node tests cover the local shell/Python boundary with a disposable checkout inside this worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const script = path.resolve('../scripts/publish-townhall.sh');
const root = path.resolve('.wrangler'); mkdirSync(root, { recursive: true });
function fixture() {
  const dir = mkdtempSync(path.join(root, 'publisher-test-'));
  const repo = path.join(dir, 'town-hall'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', '12345+test-owner@users.noreply.github.com'); git('config', 'user.name', 'Test Owner'); git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(repo, 'problems/housing/solutions'), { recursive: true }); mkdirSync(path.join(repo, 'scripts'));
  writeFileSync(path.join(repo, 'problems/housing/README.md'), '# Test problem\n');
  // A minimal fixture checker ensures the bridge invokes Town Hall's validation before committing.
  writeFileSync(path.join(repo, 'scripts/check_submission.py'), 'import sys\nfrom pathlib import Path\np=Path(sys.argv[-1]); t=p.read_text()\nassert "## Trade-offs and risks" in t\nassert "## Sources" in t\nassert "written_with: ai-agent (Test Model)" in t\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const token = path.join(dir, 'token'); writeFileSync(token, 'local-test-token');
  const data = { submission: { id: 7, body: 'Goal: Keep people housed.\nSteps: 1. City funds assistance.\nWho can make it happen: City and local organizations.\nSources:\n- https://public.example/report', sources: ['https://public.example/report'], model: 'Test Model', title: 'Research a fix for: Housing', source_key: 'townhall:housing:fix', handle: 'test-helper', published_url: null } };
  const requests = [];
  const server = createServer((req, res) => { requests.push({ url: req.url, auth: req.headers.authorization }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); });
  return { dir, repo, git, token, data, requests, server, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function run(f, extra = {}, args = ['7']) {
  if (!f.server.listening) await new Promise((resolve) => f.server.listen(0, '127.0.0.1', resolve));
  const child = spawn('bash', [script, ...args], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TOWNHALL_REPO: f.repo, SWARM_URL: `http://127.0.0.1:${f.server.address().port}`, SWARM_ADMIN_TOKEN_FILE: f.token, TOWNHALL_SCALE: 'community', ...extra } });
  let stdout = '', stderr = ''; child.stdout.on('data', (s) => stdout += s); child.stderr.on('data', (s) => stderr += s);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}
async function close(f) { await new Promise((resolve) => f.server.listening ? f.server.close(resolve) : resolve()); f.cleanup(); }

test('publisher fetches accepted research, follows the template, commits locally and prints a PR command without pushing', async () => {
  const f = fixture();
  try {
    const r = await run(f); assert.equal(r.code, 0, r.stderr);
    assert.equal(f.git('branch', '--show-current'), 'swarm/submission-7');
    const text = readFileSync(path.join(f.repo, 'problems/housing/solutions/swarm-research-7.md'), 'utf8');
    for (const heading of ['Summary', 'How it works', 'Who can make it happen', 'Who it helps and what it costs', 'Trade-offs and risks', 'Sources']) assert.ok(text.includes(`## ${heading}`));
    assert.ok(text.includes('Not assessed in the accepted submission.')); assert.ok(text.includes('scale: community'));
    assert.ok(text.includes('City funds assistance.')); assert.ok(!text.includes('local-test-token'));
    assert.deepEqual(f.requests, [{ url: '/api/admin/submission?id=7', auth: 'Bearer local-test-token' }]);
    assert.ok(r.stdout.includes('gh pr create')); assert.ok(!r.stdout.includes('local-test-token')); assert.equal(f.git('remote'), '');
    assert.ok(f.git('log', '-1', '--format=%B').endsWith('Co-Authored-By: OpenAI Codex <noreply@openai.com>'));
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { await close(f); }
});

test('publisher refuses unsafe IDs and source-key traversal before any local mutation', async () => {
  const f = fixture();
  try {
    assert.notEqual((await run(f, {}, ['../7'])).code, 0); assert.equal(f.requests.length, 0);
    f.data.submission.source_key = 'townhall:../../other:fix';
    assert.notEqual((await run(f)).code, 0); assert.equal(f.git('branch', '--show-current'), 'main');
  } finally { await close(f); }
});

test('publisher refuses dirty checkouts, already published receipts and non-https sources', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repo, 'untracked'), 'local work');
    assert.notEqual((await run(f)).code, 0); rmSync(path.join(f.repo, 'untracked'));
    f.data.submission.published_url = 'https://public.example/published'; assert.notEqual((await run(f)).code, 0);
    f.data.submission.published_url = null; f.data.submission.sources = ['http://public.example/report']; assert.notEqual((await run(f)).code, 0);
    assert.equal(f.git('branch', '--show-current'), 'main');
  } finally { await close(f); }
});

test('publisher refuses to guess scale or change the configured identity', async () => {
  const f = fixture();
  try {
    assert.notEqual((await run(f, { TOWNHALL_SCALE: '' })).code, 0);
    f.git('config', 'user.email', 'personal@example.com');
    assert.notEqual((await run(f)).code, 0); assert.equal(f.git('config', 'user.email'), 'personal@example.com');
    assert.equal(f.git('branch', '--show-current'), 'main');
  } finally { await close(f); }
});

test('publisher validates response identity, and an existing branch/file never gets overwritten', async () => {
  const f = fixture();
  try {
    f.data.submission.id = 8; assert.notEqual((await run(f)).code, 0); f.data.submission.id = 7;
    f.git('branch', 'swarm/submission-7'); assert.notEqual((await run(f)).code, 0);
    assert.equal(f.git('branch', '--show-current'), 'main');
    assert.ok(!existsSync(path.join(f.repo, 'problems/housing/solutions/swarm-research-7.md')));
  } finally { await close(f); }
});

test('publisher validation failure leaves a reviewable draft without committing or overwriting operator work', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repo, 'scripts/check_submission.py'), 'raise SystemExit(1)\n');
    f.git('add', '.'); f.git('commit', '-m', 'Failing checker fixture');
    const original = f.git('rev-parse', 'HEAD');
    assert.notEqual((await run(f)).code, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), original); assert.equal(f.git('branch', '--show-current'), 'swarm/submission-7');
    assert.ok(existsSync(path.join(f.repo, 'problems/housing/solutions/swarm-research-7.md')));
  } finally { await close(f); }
});

test('publisher does not forward the bearer token through a server redirect', async () => {
  const f = fixture();
  const target = createServer((_req, res) => { throw new Error('Redirect target must not be called'); });
  try {
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    f.server.removeAllListeners('request');
    f.server.on('request', (_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end(); });
    const result = await run(f); assert.notEqual(result.code, 0); assert.ok(!result.stderr.includes('local-test-token'));
    assert.equal(f.git('branch', '--show-current'), 'main');
  } finally { await new Promise((resolve) => target.close(resolve)); await close(f); }
});
