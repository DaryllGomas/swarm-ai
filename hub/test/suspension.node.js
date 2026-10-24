// Static checks for the suspension policy: the console offers both actions (the work one primary), renders with textContent only, and
// the code keeps its promises. Runs under `node --test` (the Workers test pool has no filesystem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the console offers "Suspend voting and AI work" as the primary button, "Suspend voting only", and Unsuspend', () => {
  const js = read('../public/ops/ops.js');
  assert.match(js, /button\('Suspend voting and AI work', \(\) => run\('all'\), 'btn btn-sm'\)/);
  assert.match(js, /button\('Suspend voting only', \(\) => run\('vote'\)\)/);
  assert.ok(js.includes("button('Unsuspend'"));
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test('the console has no field that names an account or shows a link', () => {
  const js = read('../public/ops/ops.js'), html = read('../public/ops/index.html');
  // The only account the console handles is the short id the operator types in; it is never read back from a response.
  assert.doesNotMatch(js, /owner_account|account_id|\.network|pair_ip/);
  assert.ok(html.includes('never shows an account'));
});

test('migration 0016 is the newest, and suspension.js never reads the clock', () => {
  assert.match(readdirSync(new URL('../migrations/', import.meta.url)).sort().at(-1), /^0016_/);
  assert.doesNotMatch(read('../src/suspension.js'), /Date\.|getDay|toLocale/);
});

test('every work path checks the suspension inside its own statement', () => {
  const mcp = read('../src/mcp.js'), core = read('../src/oauth-core.js');
  assert.equal((mcp.match(/NOT \$\{workSuspended\(/g) || []).length, 2); // the claim insert and the submission insert
  assert.match(core, /GRANT_LIVE = [^\n]*workSuspended/);
  assert.match(core, /AS work_suspended/);
});
