// The docs promise things the code does. Keep the promises and the code in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const doc = (name) => readFileSync(new URL(`../../docs/${name}`, import.meta.url), 'utf8');
const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('the data policy exists and covers every tier, table and the things Swarm cannot protect against', () => {
  const d = doc('DATA-POLICY.md');
  for (const t of ['Public record', 'Running the system', 'Never collected', 'network_keys', 'weekly_project_stats', 'weekly_model_stats', 'rollup_weeks', 'ballot_versions', 'events', 'accounts', 'contributors', 'claims', 'submissions', 'credentials', 'sessions',
    'weekly_purge', 'share_pseudonymous', 'kCount', 'forgetNetworks', 'deleteAccount', 'remove_handle', 'detectPersonalDetails', '/version', 'security.txt', 'TRANSPARENCY_AS_OF', 'Time Travel',
    'Cloudflare, the host', 'Your AI provider', 'GitHub shows pull request authors', 'random voter number', 'Tor']) assert.ok(d.includes(t), t);
});

test('every table in the schema is in the data policy', () => {
  const d = doc('DATA-POLICY.md');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).sort().map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')).join('\n');
  // A table a later migration drops (a working table such as 0011's _unsafe_weeks, or weekly_model_stats) is not part of the schema.
  const dropped = new Set([...migrations.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/g)].map((m) => m[1]));
  const tables = new Set([...migrations.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)].map((m) => m[1]).filter((t) => !t.endsWith('_bak') && t !== 'allocation_percent' && t !== 'tasks_bak' && !dropped.has(t)));
  assert.ok(tables.size >= 18);
  for (const t of tables) assert.ok(d.includes('`' + t + '`') || d.includes(t), `table ${t} is not in DATA-POLICY.md`);
});

test('the runbook has the monthly transparency re-dating, key deletion, the weekly rollup and delete-account handling', () => {
  const r = doc('RUNBOOK.md');
  assert.match(r, /Transparency report: re-date it every month/);
  assert.ok(r.includes('TRANSPARENCY_AS_OF'));
  assert.match(r, /a lapse is meaningful/);
  assert.match(r, /Key deletion check/);
  assert.match(r, /Weekly rollup\./);
  assert.match(r, /Delete-account requests/);
  assert.match(r, /private vulnerability reporting/);
  assert.match(r, /SECURITY_TXT_EXPIRES/);
});

test('the plan records this phase as built, and the architecture describes it', () => {
  const p = doc('PLAN.md'), a = doc('ARCHITECTURE.md');
  assert.match(p, /Phase 4b: Privacy and Trust/);
  assert.match(p, /\*\*Built\*\*, not yet deployed \(migration 0010\)/);
  assert.match(a, /## Privacy and trust/);
  assert.match(a, /0010_privacy\.sql/);
});

test('the transparency date is a constant in one place', () => {
  const t = src('trust.js');
  assert.equal([...t.matchAll(/export const TRANSPARENCY_AS_OF = '(\d{4}-\d{2}-\d{2})'/g)].length, 1);
  for (const f of readdirSync(new URL('../src/', import.meta.url))) if (f !== 'trust.js') assert.ok(!/TRANSPARENCY_AS_OF\s*=/.test(src(f)), f);
});

test('migration files are numbered in order', () => {
  const names = readdirSync(new URL('../migrations/', import.meta.url)).sort();
  names.forEach((n, i) => assert.ok(n.startsWith(String(i + 1).padStart(4, '0') + '_'), n));
  assert.equal(names.at(-1), '0015_task_missing_since.sql');
});
