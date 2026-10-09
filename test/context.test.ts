import test from 'node:test';
import assert from 'node:assert/strict';
import { ctxFromEnv, databaseUrl, tickEvery } from '../src/server/context.ts';
import { guard } from '../src/server/http.ts';
import type { Sql } from '../src/server/pg-store.ts';

const fakeSql: Sql = { query: async () => ({ rows: [] }) };

test('the database URL comes from DATABASE_URL, then POSTGRES_URL; without either the server says what to set', () => {
  assert.equal(databaseUrl({ DATABASE_URL: 'a', POSTGRES_URL: 'b' }), 'a');
  assert.equal(databaseUrl({ POSTGRES_URL: 'b' }), 'b');
  assert.equal(databaseUrl({ DATABASE_URL: '' }), null);
  assert.throws(() => ctxFromEnv({}, { connect: () => fakeSql }), /DATABASE_URL/);
});

test('the context carries the secrets, the scheduler and the platform clock; empty secrets switch the endpoints off', () => {
  let opened = '';
  const scheduled: Promise<unknown>[] = [];
  const ctx = ctxFromEnv(
    { DATABASE_URL: 'postgres://x/y', ADMIN_TOKEN: 'a', CRON_SECRET: '' },
    { connect: (u) => ((opened = u), fakeSql), schedule: (w) => void scheduled.push(w), now: () => 42 },
  );
  assert.equal(opened, 'postgres://x/y');
  assert.equal(ctx.adminToken, 'a');
  assert.equal(ctx.cronSecret, undefined);
  assert.equal(ctx.now(), 42);
  ctx.schedule?.(Promise.resolve());
  assert.equal(scheduled.length, 1);
});

test('HONE_TICK_EVERY_MS: default 5 minutes, 0 allowed, nonsense falls back to the default', () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    assert.equal(tickEvery({}), 300_000);
    assert.equal(tickEvery({ HONE_TICK_EVERY_MS: '' }), 300_000);
    assert.equal(tickEvery({ HONE_TICK_EVERY_MS: '0' }), 0);
    assert.equal(tickEvery({ HONE_TICK_EVERY_MS: '60000' }), 60_000);
    assert.equal(tickEvery({ HONE_TICK_EVERY_MS: 'soon' }), 300_000);
    assert.equal(tickEvery({ HONE_TICK_EVERY_MS: '-5' }), 300_000);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = warn;
  }
});

test('a route that crashes answers with a plain 500 and no details; one that works is passed through', async () => {
  const error = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const bad = await guard(async () => {
      throw new Error('secret connection string postgres://user:pass@host');
    });
    assert.equal(bad.status, 500);
    assert.deepEqual(await bad.json(), { error: 'server_error' });
    assert.equal(logged.length, 1);
    const good = await guard(async () => new Response(null, { status: 204 }));
    assert.equal(good.status, 204);
  } finally {
    console.error = error;
  }
});
