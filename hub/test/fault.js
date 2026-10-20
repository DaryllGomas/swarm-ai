// Deterministic fault and race injection for tests: wrap env.DB so a call can pause AFTER a real read returned (while a
// competing operation runs), or so one statement fails (the way an interrupted or failed write would).
// The wrapper sits between the Worker code and D1; the Worker code is not modified.
//
//   const db = wrapDb(env.DB, {
//     afterRead:  async (sql, method) => { ... },   // runs after first()/all() returned, before the caller sees the result
//     failOn:     /INSERT INTO events/,             // that statement throws instead of running (run(), or inside a batch)
//     failBatchAt: 2,                               // inside any batch, the statement at this index fails (the batch aborts)
//   });
//   await send('/mcp', init, { DB: db });           // or: makeEnv({ DB: db }) for a direct call
import { env } from 'cloudflare:workers';

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A one-shot gate: the first caller that matches parks until open() is called; `reached` resolves when it is parked.
export function gate() {
  const reached = deferred();
  const opened = deferred();
  let used = false;
  return {
    reached: reached.promise,
    open: () => opened.resolve(),
    // call from afterRead; parks only the first time
    async hit() {
      if (used) return;
      used = true;
      reached.resolve();
      await opened.promise;
    },
  };
}

// A rendezvous for n callers with a timeout: each caller waits until n have arrived or the timeout passes. Used where
// the code under test may or may not have a pause point (the race is only exercised if it does).
export function rendezvous(n, timeoutMs = 300) {
  let arrived = 0;
  const all = deferred();
  return async () => {
    arrived++;
    if (arrived >= n) all.resolve();
    await Promise.race([all.promise, new Promise((r) => setTimeout(r, timeoutMs))]);
  };
}

export class InjectedFailure extends Error {
  constructor(sql) { super(`injected failure at: ${String(sql).slice(0, 60)}`); }
}

export function wrapDb(real, hooks = {}) {
  const wrapStmt = (stmt, sql) => {
    const w = {
      __real: stmt,
      __sql: sql,
      bind: (...a) => wrapStmt(stmt.bind(...a), sql),
      async first(...a) {
        const r = await stmt.first(...a);
        await hooks.afterRead?.(sql, 'first', r);
        return r;
      },
      async all() {
        const r = await stmt.all();
        await hooks.afterRead?.(sql, 'all', r);
        return r;
      },
      async raw(...a) { return stmt.raw(...a); },
      async run() {
        if (hooks.failOn && hooks.failOn.test(sql)) throw new InjectedFailure(sql);
        await hooks.beforeRun?.(sql);
        return stmt.run();
      },
    };
    return w;
  };
  return {
    prepare: (sql) => { hooks.onPrepare?.(sql); return wrapStmt(real.prepare(sql), sql); },
    async batch(stmts) {
      await hooks.beforeBatch?.(stmts.map((s) => s.__sql ?? ''));
      const mapped = stmts.map((s, i) => {
        const sql = s.__sql ?? '';
        const fail = (hooks.failOn && hooks.failOn.test(sql)) || hooks.failBatchAt === i;
        // A statement that cannot run (no such column) aborts the whole D1 batch, which rolls it back.
        return fail ? real.prepare('INSERT INTO events (injected_failure) VALUES (1)') : (s.__real ?? s);
      });
      const out = await real.batch(mapped);
      await hooks.afterBatch?.(stmts.map((s) => s.__sql ?? ''));
      return out;
    },
    exec: (...a) => real.exec(...a),
  };
}

// Count rows quickly in assertions.
export async function count(sql, ...binds) {
  return (await env.DB.prepare(sql).bind(...binds).first()).n;
}
