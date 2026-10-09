import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { mulberry32 } from '../src/core/rng.ts';
import { DAY, makeConfig } from '../src/core/types.ts';
import type { AuditEntry } from '../src/core/types.ts';
import { validateNewExperiment } from '../src/server/create.ts';
import { MemoryStore } from '../src/server/memory-store.ts';
import { DuplicateExperimentError } from '../src/server/store.ts';
import type { MeasureSpec, Store } from '../src/server/store.ts';
import { NO_DB, openTestDb } from './support/pg.ts';
import type { TestDb } from './support/pg.ts';
import { experimentBody } from './support/fixtures.ts';

const T0 = 20_000 * DAY;
const hasDb = Boolean(process.env.HONE_TEST_DATABASE);

function newDef(id = 'exp_contract1') {
  const made = validateNewExperiment(experimentBody({ id }));
  if (!made.ok) throw new Error(made.errors.join('; '));
  const engine = new Engine(made.def.config, 'original', made.def.order, mulberry32(1), T0);
  return { def: made.def, state: engine.toState(), audit: engine.audit };
}

async function seed(store: Store, id = 'exp_contract1') {
  const { def, state, audit } = newDef(id);
  await store.createExperiment(def, state, audit, T0);
  return { def, state, audit };
}

const spec = (over: Partial<MeasureSpec> = {}): MeasureSpec => ({
  order: ['original', 'v1', 'v2'],
  now: T0 + 30 * DAY,
  windowMs: 7 * DAY,
  lagMs: DAY,
  confirmPhase: null,
  confirmN: 0,
  phase: 2,
  ...over,
});

interface Backend {
  name: string;
  skip: string | false;
  open(): Promise<{ store: Store; close(): Promise<void> }>;
}

const backends: Backend[] = [
  { name: 'memory', skip: false, open: async () => ({ store: new MemoryStore(), close: async () => {} }) },
  {
    name: 'postgres',
    skip: hasDb ? false : NO_DB,
    open: async () => {
      const db = (await openTestDb(8)) as TestDb;
      return { store: db.store, close: db.close };
    },
  },
];

for (const b of backends) {
  const t = (name: string, fn: (store: Store) => Promise<void>) =>
    test(`[${b.name}] ${name}`, { skip: b.skip }, async () => {
      const env = await b.open();
      try {
        await fn(env.store);
      } finally {
        await env.close();
      }
    });

  t('an experiment is stored and read back exactly, and a second one with the same id is refused', async (store) => {
    const { def, state, audit } = await seed(store);
    const row = await store.getExperiment(def.id);
    assert.deepEqual(row?.def, def);
    assert.deepEqual(row?.state, state);
    assert.equal(row?.killed, false);
    assert.equal(row?.createdAt, T0);
    assert.deepEqual(await store.readAudit(def.id), audit);
    assert.equal(await store.getExperiment('exp_nothere'), null);
    await assert.rejects(() => seed(store), DuplicateExperimentError);
    assert.deepEqual(await store.listActive(), [def.id]);
    assert.deepEqual((await store.listAll()).map((x) => [x.id, x.stage, x.killed]), [[def.id, 'canary', false]]);
  });

  t('a visitor is stored once; later calls get the first answer back', async (store) => {
    await seed(store);
    const a = await store.upsertVisitor('exp_contract1', 'visitor-aaaa', 'v1', 0, T0 + 5);
    assert.deepEqual(a, { row: { variantId: 'v1', phase: 0, assignedAt: T0 + 5, convertedAt: null }, created: true });
    const b = await store.upsertVisitor('exp_contract1', 'visitor-aaaa', 'v2', 3, T0 + 99);
    assert.deepEqual(b, { row: { variantId: 'v1', phase: 0, assignedAt: T0 + 5, convertedAt: null }, created: false });
    assert.deepEqual(await store.getVisitor('exp_contract1', 'visitor-aaaa'), b.row);
    assert.equal(await store.getVisitor('exp_contract1', 'visitor-bbbb'), null);
  });

  t('a goal counts once and only inside the window', async (store) => {
    await seed(store);
    await store.upsertVisitor('exp_contract1', 'visitor-aaaa', 'v1', 0, T0);
    assert.equal(await store.recordGoal('exp_contract1', 'visitor-aaaa', T0 + DAY, 7 * DAY), true);
    assert.equal(await store.recordGoal('exp_contract1', 'visitor-aaaa', T0 + 2 * DAY, 7 * DAY), false);
    assert.equal((await store.getVisitor('exp_contract1', 'visitor-aaaa'))?.convertedAt, T0 + DAY);
    await store.upsertVisitor('exp_contract1', 'visitor-bbbb', 'v1', 0, T0);
    assert.equal(await store.recordGoal('exp_contract1', 'visitor-bbbb', T0 + 7 * DAY, 7 * DAY), true, 'exactly at the edge still counts');
    await store.upsertVisitor('exp_contract1', 'visitor-cccc', 'v1', 0, T0);
    assert.equal(await store.recordGoal('exp_contract1', 'visitor-cccc', T0 + 7 * DAY + 1, 7 * DAY), false);
    assert.equal(await store.recordGoal('exp_contract1', 'visitor-nobody', T0, 7 * DAY), false);
  });

  t('the kill switch flips once per press and writes its reason to the audit log', async (store) => {
    await seed(store);
    const on: AuditEntry = { at: T0 + 10, actor: 'person', action: 'kill_switch_on', reason: 'testing' };
    assert.equal(await store.setKilled('exp_contract1', true, on), true);
    assert.equal(await store.setKilled('exp_contract1', true, on), false);
    assert.equal((await store.getExperiment('exp_contract1'))?.killed, true);
    assert.equal(await store.setKilled('exp_contract1', false, { ...on, action: 'kill_switch_off', reason: 'done' }), true);
    const log = await store.readAudit('exp_contract1');
    assert.deepEqual(log.slice(-2).map((a) => [a.action, a.reason, a.variantId]), [['kill_switch_on', 'testing', undefined], ['kill_switch_off', 'done', undefined]]);
  });

  t('only one caller gets the tick lease, a stale lease expires, and saving needs the right token', async (store) => {
    const { state } = await seed(store);
    assert.equal(await store.claimTick('exp_contract1', 'a', T0 + 1000, 60_000), true);
    assert.equal(await store.claimTick('exp_contract1', 'b', T0 + 2000, 60_000), false);
    assert.equal(await store.saveTick('exp_contract1', 'b', state, [], T0 + 3000), false);
    assert.equal(await store.claimTick('exp_contract1', 'b', T0 + 61_001, 60_000), true, 'expired');
    assert.equal(await store.saveTick('exp_contract1', 'a', state, [], T0 + 61_500), false, 'the old holder lost its lease');

    const finished = { ...state, stage: 'stopped' as const };
    const entries: AuditEntry[] = [
      { at: T0 + 70_000, actor: 'engine', action: 'stage_stopped', variantId: undefined, reason: 'one' },
      { at: T0 + 70_000, actor: 'engine', action: 'retired', variantId: 'v2', reason: 'two' },
      { at: T0 + 70_001, actor: 'safety', action: 'x', variantId: undefined, reason: 'three' },
    ];
    assert.equal(await store.saveTick('exp_contract1', 'b', finished, entries, T0 + 70_002), true);
    const row = await store.getExperiment('exp_contract1');
    assert.equal(row?.state.stage, 'stopped');
    assert.equal(row?.tickedAt, T0 + 70_002);
    assert.deepEqual((await store.readAudit('exp_contract1')).slice(-3), entries, 'order and every field preserved');
    assert.deepEqual((await store.readAudit('exp_contract1', 2)).map((a) => a.reason), ['two', 'three']);
    assert.deepEqual(await store.listActive(), [], 'a finished experiment is no longer active');
    assert.equal(await store.claimTick('exp_contract1', 'c', T0 + 80_000, 1000), true, 'the lease was handed back');
  });

  t('many requests at once: one creates the visitor, everyone sees the same variant, and counters add up exactly', async (store) => {
    await seed(store);
    const proposals = ['v1', 'v2', 'original'];
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => store.upsertVisitor('exp_contract1', 'visitor-race', proposals[i % 3], 0, T0 + i)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.row.variantId)).size, 1);

    await Promise.all(Array.from({ length: 200 }, (_, i) => store.recordHealth('exp_contract1', 'v1', T0 + i, { view: true, error: i % 10 === 0, lcpMs: 1000 + i })));
    const m = await store.measure('exp_contract1', spec({ now: T0 + DAY }));
    assert.deepEqual([m.variants.v1.views, m.variants.v1.errors, m.variants.v1.lcpN], [200, 20, 200]);
    assert.equal(m.variants.v1.lcpSum, Array.from({ length: 200 }, (_, i) => 1000 + i).reduce((a, x) => a + x, 0));
    assert.equal(Object.values(m.dayViews)[0], 200);

    const progress = await store.progress('exp_contract1');
    assert.deepEqual({ ...progress.v1, visitors: 0 }, { visitors: 0, converted: 0, views: 200, errors: 20, avgLcpMs: 1099.5 });
    assert.equal(progress[results[0].row.variantId].visitors, 1, 'the one visitor, under the variant that won the race');
    assert.equal(Object.values(progress).reduce((a, p) => a + p.visitors, 0), 1);

    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => store.claimTick('exp_contract1', `t${i}`, T0 + 1_000_000, 60_000)));
    assert.equal(claims.filter(Boolean).length, 1);
  });
}

// ------------------------------------------------------------------ the two stores must give the same numbers

test('measure: the memory store and Postgres agree on a messy run with phases, a capped confirm phase, health and late goals', { skip: hasDb ? false : NO_DB }, async () => {
  const pg = (await openTestDb(1)) as TestDb;
  const mem = new MemoryStore();
  try {
    for (const store of [mem, pg.store]) await seed(store);
    const rng = mulberry32(42);
    const ids = ['original', 'v1', 'v2'];
    const ops: Array<(s: Store) => Promise<unknown>> = [];
    let at = T0;
    for (let i = 0; i < 4000; i++) {
      at += Math.floor(rng() * 30_000);
      const phase = i < 600 ? 0 : i < 1500 ? 1 : 2;
      const variant = ids[Math.floor(rng() * 3)];
      const id = `visitor-${String(i).padStart(6, '0')}`;
      const when = at;
      ops.push((s) => s.upsertVisitor('exp_contract1', id, variant, phase, when));
      if (rng() < 0.9) {
        const lcp = rng() < 0.8 ? 800 + rng() * 3000 : undefined;
        ops.push((s) => s.recordHealth('exp_contract1', variant, when, { view: true, error: rng() < 0.05 && false, lcpMs: lcp }));
      }
      if (rng() < 0.15) {
        const offset = Math.floor(rng() < 0.5 ? rng() * 3_600_000 : rng() * 9 * DAY);
        ops.push((s) => s.recordGoal('exp_contract1', id, when + offset, 7 * DAY));
      }
    }
    for (const op of ops) {
      await op(mem);
      await op(pg.store);
    }
    for (const over of [
      { now: at + 1 * DAY },
      { now: at + 4 * DAY, confirmPhase: 2, confirmN: 250 },
      { now: at + 12 * DAY, confirmPhase: 2, confirmN: 250 },
      { now: at + 40 * DAY, confirmPhase: 1, confirmN: 100, lagMs: 3_600_000 },
      { now: at + 40 * DAY, phase: 4 },
    ]) {
      const a = await mem.measure('exp_contract1', spec(over));
      const b = await pg.store.measure('exp_contract1', spec(over));
      assert.deepEqual(b, a, JSON.stringify(over));
    }
    const settled = (await mem.measure('exp_contract1', spec({ now: at + 40 * DAY }))).variants;
    assert.ok(settled.original.total.s > 50 && settled.v1.total.f > 50, 'the script should produce a good mix');
  } finally {
    await pg.close();
  }
});
