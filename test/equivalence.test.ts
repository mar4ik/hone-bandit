import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/server/memory-store.ts';
import { defaultWorld } from '../src/sim/sim.ts';
import { DAY } from '../src/core/types.ts';
import { T0, drive, harnessBackend, makeCfg, serverBackend, serverSummary } from './support/drive.ts';

export const world = defaultWorld({
  baseRate: 0.1,
  visitorsPerDay: 400,
  variants: { v1: { lift: 0.6 }, v2: { lift: 0 }, v3: { lift: 0.6, errorRate: 0.08 } },
});
export const overrides = { confirm: { relMde: 0.5 }, canaryShare: 0.1, canaryMinExposures: 250, warmupMinExposures: 300 };
export const DAYS = 50;

test('the server path gives exactly what the simulator path gives: same audit log, same state, same counts', async () => {
  const cfg = makeCfg(overrides);
  const h = harnessBackend(cfg, Object.keys(world.variants));
  await drive(world, 11, DAYS, h.backend);

  const store = new MemoryStore();
  const s = await serverBackend(store, Object.keys(world.variants), overrides);
  await drive(world, 11, DAYS, s.backend);

  const server = await serverSummary(store, T0 + DAYS * DAY);
  const stages = h.exp.audit.filter((a) => a.action.startsWith('stage_')).map((a) => a.action);
  assert.ok(stages.includes('stage_bandit') && stages.includes('stage_confirm'), `the run should get through several stages: ${stages}`);
  assert.ok(h.exp.audit.some((a) => a.action === 'rolled_back' || a.action === 'stopped'), 'the planted bad variant should be caught');

  assert.deepEqual(server.audit, h.exp.audit);
  assert.deepEqual(server.state, h.exp.toState());
  assert.deepEqual(server.snapshot.variants, h.finalSnapshot().variants);
});

test(
  'the same, with the real Postgres store: audit log, state and counts match the simulator exactly',
  { skip: process.env.HONE_TEST_DATABASE ? false : 'No test database: run scripts/pg-test-server.sh start' },
  async () => {
    const { openTestDb } = await import('./support/pg.ts');
    const db = (await openTestDb(2))!;
    try {
      const cfg = makeCfg(overrides);
      const h = harnessBackend(cfg, Object.keys(world.variants));
      await drive(world, 11, DAYS, h.backend);

      const s = await serverBackend(db.store, Object.keys(world.variants), overrides);
      await drive(world, 11, DAYS, s.backend);

      const server = await serverSummary(db.store, T0 + DAYS * DAY);
      assert.deepEqual(server.audit, h.exp.audit);
      assert.deepEqual(server.state, h.exp.toState());
      assert.deepEqual(server.snapshot.variants, h.finalSnapshot().variants);
    } finally {
      await db.close();
    }
  },
);
