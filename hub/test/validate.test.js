// Finding 5: every MCP tool's inputSchema is enforced by a small explicit validator (src/validate.js), before the pause check,
// authentication, any database work or any sync. Missing is different from an explicit null.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { ADMIN, BODY, SOURCE, addTask, newUser, resetDb, rpc, send, tool } from './helpers.js';
import { wrapDb } from './fault.js';
import { validateArgs } from '../src/validate.js';

beforeEach(resetDb);

describe('validateArgs (the validator itself)', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1, maximum: 10 },
      name: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
      kind: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', maxLength: 3 } },
    },
    required: ['id'],
    additionalProperties: false,
  };
  const v = (a) => validateArgs(schema, a);

  it('accepts what fits, including every optional property left out', () => {
    expect(v({ id: 1 })).toBeNull();
    expect(v({ id: 10, name: 'abcd', kind: 'b', list: ['x', 'yz'] })).toBeNull();
  });

  it('requires required properties, and tells missing from an explicit null', () => {
    expect(v({})).toBe('id is required');
    expect(v({ id: null })).toBe('id must be an integer (got null)');
    expect(v({ id: 1, name: null })).toBe('name must be a string (got null)'); // optional, but null is not "left out"
  });

  it('checks exact JSON types', () => {
    expect(v({ id: '1' })).toMatch(/must be an integer \(got a string\)/);
    expect(v({ id: 1.5 })).toMatch(/must be an integer \(got a number\)/);
    expect(v({ id: true })).toMatch(/got a boolean/);
    expect(v({ id: [1] })).toMatch(/got an array/);
    expect(v({ id: { a: 1 } })).toMatch(/got an object/);
    expect(v({ id: 1, name: 5 })).toMatch(/name must be a string \(got an integer\)/);
    expect(v({ id: 1, list: 'ab' })).toMatch(/list must be an array \(got a string\)/);
    expect(v({ id: 1, list: [5] })).toMatch(/list\[0\] must be a string/);
  });

  it('checks ranges, lengths, patterns, enums and uniqueness', () => {
    expect(v({ id: 0 })).toMatch(/at least 1/);
    expect(v({ id: 11 })).toMatch(/at most 10/);
    expect(v({ id: 1, name: 'a' })).toMatch(/at least 2 characters/);
    expect(v({ id: 1, name: 'abcde' })).toMatch(/at most 4 characters/);
    expect(v({ id: 1, name: 'AB' })).toMatch(/wrong format/);
    expect(v({ id: 1, kind: 'c' })).toMatch(/one of: a, b/);
    expect(v({ id: 1, list: [] })).toMatch(/at least 1 item/);
    expect(v({ id: 1, list: ['a', 'b', 'c'] })).toMatch(/at most 2 items/);
    expect(v({ id: 1, list: ['a', 'a'] })).toMatch(/must not repeat/);
    expect(v({ id: 1, list: ['abcd'] })).toMatch(/list\[0\] must be at most 3 characters/);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(v({ id: 1, name: '\u{1F600}\u{1F600}' })).toMatch(/wrong format/); // two characters: the length rule passes, the pattern fails
    expect(v({ id: 1, list: ['\u{1F600}\u{1F600}\u{1F600}'] })).toBeNull(); // three characters, six UTF-16 units
  });

  it('rejects unknown properties, including __proto__ from JSON', () => {
    expect(v({ id: 1, extra: true })).toBe('unknown property "extra"');
    expect(v(JSON.parse('{"id":1,"__proto__":{"x":1}}'))).toBe('unknown property "__proto__"');
  });

  it('reports several problems, never the values, and is not an object-only free-for-all', () => {
    const msg = v({ id: 'secret-swk_value', name: 7, extra: 1 });
    expect(msg).not.toContain('secret-swk_value');
    expect(msg.split('; ')).toHaveLength(3);
    expect(validateArgs(schema, null)).toMatch(/must be an object \(got null\)/);
    expect(validateArgs(schema, [])).toMatch(/must be an object \(got an array\)/);
    expect(validateArgs(schema, 'x')).toMatch(/must be an object/);
  });

  it('refuses a schema keyword or type it does not implement, rather than passing everything', () => {
    expect(() => validateArgs({ type: 'object', properties: { a: { type: 'string', format: 'uri' } } }, { a: 'x' })).toThrow(/unsupported keyword "format"/);
    expect(() => validateArgs({ type: 'object', properties: { a: { type: 'number' } } }, { a: 1 })).toThrow(/unsupported schema type/);
  });
});

// ------------------------------------------------------------------ every tool, through the real endpoint

const KEY = `swk_${'A'.repeat(32)}`;
const OK_SUBMIT = { task_id: 1, body: BODY, sources: [SOURCE] };

// For each tool: calls that must be refused with -32602 (nothing else may run), written out per tool.
const BAD = {
  how_to_help: [{ extra: true }, { client: 'codex' }],
  setup_guide: [{ client: ['codex'] }, { client: 5 }, { client: null }, { client: 'emacs' }, { client: 'claude-code', extra: 1 }],
  list_projects: [{ extra: 1 }, { limit: 5 }],
  list_tasks: [
    { project: { bad: 'type' } }, { project: null }, { project: 5 }, { project: 'x'.repeat(61) },
    { status: 'held' }, { status: 5 }, { status: null }, { status: ['ready'] },
    { limit: '50' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: null }, { limit: [] },
    { offset: [] }, { offset: -1 }, { offset: 5001 }, { offset: '0' }, { offset: null },
    { project: { bad: 'type' }, limit: '50', offset: [], extra: true },
  ],
  get_task: [{}, { id: '1' }, { id: null }, { id: 0 }, { id: -3 }, { id: 1.5 }, { id: [1] }, { id: { a: 1 } }, { id: true }, { id: 1, extra: 1 }, { task_id: 1 }],
  pair: [{ handle: 5 }, { handle: null }, { handle: ['abc'] }, { handle: 'ab' }, { handle: 'UPPER' }, { handle: 'x'.repeat(25) }, { extra: 1 }, { contributor_key: KEY }],
  next_task: [{ contributor_key: 5 }, { contributor_key: null }, { contributor_key: 'x'.repeat(65) }, { contributor_key: {} }, { extra: 1 }, { id: 3 }],
  claim_task: [{}, { id: '3' }, { id: null }, { id: 0 }, { id: 2.5 }, { id: [3] }, { id: 3, contributor_key: 7 }, { id: 3, extra: 1 }],
  release_task: [{}, { id: '3' }, { id: null }, { id: 0 }, { id: 2.5 }, { id: [3] }, { id: 3, contributor_key: [] }, { id: 3, extra: 1 }],
  my_work: [{ contributor_key: 5 }, { contributor_key: [] }, { contributor_key: null }, { extra: 1 }, { id: 1 }],
  submit_work: [
    {}, { task_id: 1, body: BODY }, { task_id: 1, sources: [SOURCE] }, { body: BODY, sources: [SOURCE] },
    { ...OK_SUBMIT, task_id: '1' }, { ...OK_SUBMIT, task_id: null }, { ...OK_SUBMIT, task_id: 0 }, { ...OK_SUBMIT, task_id: 1.5 },
    { ...OK_SUBMIT, body: 5 }, { ...OK_SUBMIT, body: null }, { ...OK_SUBMIT, body: ['x'] }, { ...OK_SUBMIT, body: 'too short' },
    { ...OK_SUBMIT, sources: SOURCE }, { ...OK_SUBMIT, sources: null }, { ...OK_SUBMIT, sources: [] }, { ...OK_SUBMIT, sources: [5] },
    { ...OK_SUBMIT, sources: [null] }, { ...OK_SUBMIT, sources: [SOURCE, SOURCE] },
    { ...OK_SUBMIT, sources: Array.from({ length: 31 }, (_, i) => `https://example.org/${i}`) },
    { ...OK_SUBMIT, sources: ['ftp://example.org/x'] }, { ...OK_SUBMIT, sources: [`https://example.org/${'a'.repeat(300)}`] },
    { ...OK_SUBMIT, model: { a: 1 } }, { ...OK_SUBMIT, model: null }, { ...OK_SUBMIT, model: 5 }, { ...OK_SUBMIT, model: 'm'.repeat(61) },
    { ...OK_SUBMIT, tokens_est: '5' }, { ...OK_SUBMIT, tokens_est: -1 }, { ...OK_SUBMIT, tokens_est: 1.5 }, { ...OK_SUBMIT, tokens_est: 100000001 }, { ...OK_SUBMIT, tokens_est: null },
    { ...OK_SUBMIT, contributor_key: 5 }, { ...OK_SUBMIT, extra: true },
  ],
  submission_status: [{}, { id: '1' }, { id: null }, { id: 0 }, { id: 1.5 }, { id: [1] }, { id: 1, contributor_key: 5 }, { id: 1, extra: 1 }],
};

describe('MCP tools: wrong-type, missing and unknown arguments are refused before anything else runs', () => {
  it('every tool in tools/list has cases here, and every schema is one the validator supports', async () => {
    const { body } = await rpc('tools/list', {});
    const tools = body.result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(BAD).sort());
    for (const t of tools) {
      expect(() => validateArgs(t.inputSchema, {}), t.name).not.toThrow(); // every keyword in every schema is one the validator implements
      for (const spec of Object.values(t.inputSchema.properties)) expect(() => validateArgs({ type: 'object', properties: { p: spec } }, { p: 0 }), `${t.name} property`).not.toThrow();
      for (const name of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties), `${t.name}.${name}`).toContain(name);
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  for (const [name, cases] of Object.entries(BAD)) {
    it(`${name}: ${cases.length} bad calls get -32602, with no database read, no key needed and no sync`, async () => {
      for (const args of cases) {
        const prepared = [];
        const db = wrapDb(env.DB, { onPrepare: (sql) => prepared.push(sql) });
        // No Authorization header at all: validation must come before the "needs a key" check.
        const { res, body } = await rpc('tools/call', { name, arguments: args }, { over: { DB: db } });
        const label = `${name}(${JSON.stringify(args).slice(0, 80)})`;
        expect(res.status, label).toBe(200);
        expect(body.error?.code, label).toBe(-32602);
        expect(body.error.message, label).toMatch(new RegExp(`^Invalid arguments for ${name}: `));
        expect(prepared, label).toEqual([]);
      }
    });
  }

  it('get_task({}) is a clean validation error that says what is missing, not an internal error', async () => {
    const { res, body } = await rpc('tools/call', { name: 'get_task', arguments: {} });
    expect(res.status).toBe(200);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toBe('Invalid arguments for get_task: id is required');
    // ...and an explicit null says so too, which is a different message.
    const nul = await rpc('tools/call', { name: 'get_task', arguments: { id: null } });
    expect(nul.body.error.message).toBe('Invalid arguments for get_task: id must be an integer (got null)');
  });

  it('arguments left out means {}; an explicit null or a non-object is refused', async () => {
    expect((await rpc('tools/call', { name: 'how_to_help' })).body.result.isError).toBeFalsy();
    for (const args of [null, [], 'x', 5]) {
      const { body } = await rpc('tools/call', { name: 'how_to_help', arguments: args });
      expect(body.error?.code, JSON.stringify(args)).toBe(-32602);
    }
  });

  it('validation runs before the INTAKE pause and before authentication', async () => {
    const paused = { INTAKE: 'paused' };
    const r = await rpc('tools/call', { name: 'claim_task', arguments: { id: 'x' } }, { over: paused });
    expect(r.body.error.code).toBe(-32602);
    const ok = await tool('claim_task', { id: 1 }, { over: paused }); // valid arguments reach the pause check
    expect(ok.text).toMatch(/paused for maintenance/);
    const noKey = await tool('claim_task', { id: 1 }); // valid arguments reach authentication
    expect(noKey.text).toMatch(/needs a contributor key/);
  });

  it('an error never repeats a contributor key that was sent in the wrong place', async () => {
    const { body } = await rpc('tools/call', { name: 'my_work', arguments: { contributor_key: KEY, key: KEY } });
    expect(body.error.code).toBe(-32602);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('valid calls at the edges of every limit still work', async () => {
    const user = await newUser();
    const taskId = await addTask();
    expect((await tool('list_tasks', { limit: 50, offset: 5000, project: 'town-hall', status: 'ready' })).isError).toBe(false);
    expect((await tool('list_tasks', { limit: 1, offset: 0 })).isError).toBe(false);
    expect((await tool('get_task', { id: taskId })).isError).toBe(false);
    expect((await tool('setup_guide', { client: 'codex' })).isError).toBe(false);
    expect((await user.call('my_work', {})).isError).toBe(false);
    expect((await user.call('claim_task', { id: taskId })).isError).toBe(false);
    const sub = await user.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE, 'https://example.org/b'], model: 'm'.repeat(60), tokens_est: 100000000 });
    expect(sub.isError, sub.text).toBe(false);
    expect((await user.call('submission_status', { id: sub.data.submission_id })).isError).toBe(false);
    expect((await tool('pair', { handle: 'abc', ...{} }, { ip: '198.18.0.1' })).isError).toBe(false);
  });

  it('submit_work with an object-valued model is refused instead of being stored as [object Object]', async () => {
    const user = await newUser();
    const taskId = await addTask();
    await user.call('claim_task', { id: taskId });
    const r = await user.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE], model: { name: 'x' } });
    expect(r.rpcError.code).toBe(-32602);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first()).n).toBe(0);
  });
});

describe('admin review: note is an optional string', () => {
  async function pending() {
    const taskId = await addTask();
    const u = await newUser();
    await u.call('claim_task', { id: taskId });
    return (await u.call('submit_work', { task_id: taskId, body: BODY, sources: [SOURCE] })).data.submission_id;
  }
  const post = (body) => send('/api/admin/review', { method: 'POST', headers: { ...ADMIN(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses a note that is not a string, and an explicit null, and changes nothing', async () => {
    const id = await pending();
    for (const note of [5, ['a'], { a: 1 }, true, null]) {
      const res = await post({ id, decision: 'accept', note });
      expect(res.status, JSON.stringify(note)).toBe(400);
      expect((await res.json()).error).toMatch(/note must be a string/);
    }
    expect((await env.DB.prepare('SELECT status FROM submissions WHERE id = ?1').bind(id).first()).status).toBe('pending');
  });

  it('accepts a string note, or none', async () => {
    const id = await pending();
    expect((await post({ id, decision: 'reject', note: 'needs sources' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT review_note FROM submissions WHERE id = ?1').bind(id).first()).review_note).toBe('needs sources');
    const id2 = await pending();
    expect((await post({ id: id2, decision: 'reject' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT review_note FROM submissions WHERE id = ?1').bind(id2).first()).review_note).toBeNull();
  });
});
