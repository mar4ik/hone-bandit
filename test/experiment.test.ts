import test from 'node:test';
import assert from 'node:assert/strict';
import { Experiment } from '../src/core/experiment.ts';
import { hashUnit, mulberry32 } from '../src/core/rng.ts';
import { DAY, makeConfig } from '../src/core/types.ts';
import type { DeepPartial, Config } from '../src/core/types.ts';

function make(cfg: DeepPartial<Config> = {}, challengers = ['v1'], seed = 1): Experiment {
  return new Experiment(makeConfig('t', cfg), 'original', challengers, mulberry32(seed), 0);
}

test('the canary gives each new variant 1% and the original the rest', () => {
  const e = make({}, ['v1', 'v2']);
  assert.equal(e.stage, 'canary');
  assert.ok(Math.abs(e.weights.v1 - 0.01) < 1e-12);
  assert.ok(Math.abs(e.weights.v2 - 0.01) < 1e-12);
  assert.ok(Math.abs(e.weights.original - 0.98) < 1e-12);
  const counts: Record<string, number> = { original: 0, v1: 0, v2: 0 };
  for (let i = 0; i < 100_000; i++) counts[e.assign(`u${i}`, 0)]++;
  assert.ok(counts.v1 > 800 && counts.v1 < 1200, `v1 got ${counts.v1}`);
  assert.ok(counts.v2 > 800 && counts.v2 < 1200, `v2 got ${counts.v2}`);
});

test('a visitor keeps the variant they were given', () => {
  const e = make({ canaryShare: 0.5 });
  const first: Record<string, string> = {};
  for (let i = 0; i < 2000; i++) first[`u${i}`] = e.assign(`u${i}`, 1000);
  for (let i = 0; i < 2000; i++) assert.equal(e.assign(`u${i}`, 2000), first[`u${i}`]);
  // and the draw does not depend on call order or process state
  const f = make({ canaryShare: 0.5 });
  for (let i = 1999; i >= 0; i--) assert.equal(f.assign(`u${i}`, 5), first[`u${i}`]);
});

test('kill switch: everyone sees the original, nothing is counted, and resuming restores the old assignments', () => {
  const e = make({ canaryShare: 0.5 });
  const before: Record<string, string> = {};
  for (let i = 0; i < 400; i++) before[`u${i}`] = e.assign(`u${i}`, 10);
  const shownBefore = e.snapshot().variants.reduce((a, v) => a + v.shown, 0);
  assert.ok(Object.values(before).includes('v1'));

  e.kill(20, 'test');
  for (let i = 0; i < 400; i++) assert.equal(e.assign(`u${i}`, 30), 'original');
  for (let i = 400; i < 800; i++) assert.equal(e.assign(`u${i}`, 30), 'original');
  e.recordView('u1', 30, { error: true });
  e.recordGoal('u1', 30);
  assert.equal(e.snapshot().variants.reduce((a, v) => a + v.shown, 0), shownBefore);
  assert.deepEqual(e.snapshot().weights, { original: 1, v1: 0 });

  e.resume(40, 'test');
  for (let i = 0; i < 400; i++) assert.equal(e.assign(`u${i}`, 50), before[`u${i}`]);
  assert.ok(e.audit.some((a) => a.action === 'kill_switch_on' && a.actor === 'person'));
});

test('guardrail: a variant with far more page errors is stopped in the canary', () => {
  const e = make({ canaryShare: 0.5, canaryMinExposures: 100000 });
  for (let i = 0; i < 4000; i++) {
    const id = `u${i}`;
    const v = e.assign(id, 100 + i);
    e.recordView(id, 100 + i, { error: i % 100 < (v === 'v1' ? 6 : 1) });
  }
  e.tick(DAY);
  assert.equal(e.status('v1'), 'stopped');
  const entry = e.audit.find((a) => a.action === 'stopped');
  assert.match(entry!.reason, /page errors/);
  // visitors who had v1 now see the original
  for (let i = 0; i < 4000; i++) assert.equal(e.assign(`u${i}`, DAY + 1), 'original');
});

test('guardrail: a variant that is much slower is stopped', () => {
  const rng = mulberry32(9);
  const e = make({ canaryShare: 0.5, canaryMinExposures: 100000 });
  for (let i = 0; i < 3000; i++) {
    const id = `u${i}`;
    const v = e.assign(id, 100 + i);
    const base = v === 'v1' ? 2300 : 1800;
    e.recordView(id, 100 + i, { lcpMs: base + (rng() - 0.5) * 800 });
  }
  e.tick(DAY);
  assert.equal(e.status('v1'), 'stopped');
  assert.match(e.audit.find((a) => a.action === 'stopped')!.reason, /page speed/);
});

test('guardrails do not stop a healthy variant', () => {
  let stopped = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry32(seed);
    const e = make({ canaryShare: 0.5, canaryMinExposures: 100000 }, ['v1'], seed);
    for (let i = 0; i < 4000; i++) {
      const id = `u${i}`;
      e.assign(id, 100 + i);
      e.recordView(id, 100 + i, { error: rng() < 0.01, lcpMs: 1800 + (rng() - 0.5) * 800 });
    }
    e.tick(DAY);
    if (e.status('v1') !== 'live') stopped++;
  }
  assert.ok(stopped <= 1, `${stopped} of 25 healthy variants were stopped`);
});

/** Visitor ids whose hash falls in a given range, so a test can fake a tracking bug that drops one group. */
function idsWhere(prefix: string, want: (u: number) => boolean, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) if (want(hashUnit(`t|${prefix}${i}`))) out.push(`${prefix}${i}`);
  return out;
}

test('data health: a visitor split that does not match the intended split freezes the experiment', () => {
  const e = make({ canaryShare: 0.5, canaryMinExposures: 1 });
  // Pretend the SDK fails to load for about a third of one group: control-bound visitors all arrive, v1-bound only partly.
  for (const id of idsWhere('a', (u) => u < 0.5, 3000)) e.assign(id, 100);
  for (const id of idsWhere('b', (u) => u >= 0.5, 2000)) e.assign(id, 100);
  e.tick(DAY);
  assert.equal(e.frozen, 'visitor split does not match the intended split');
  assert.equal(e.stage, 'canary', 'a frozen experiment must not change stage');
  assert.ok(e.audit.some((a) => a.action === 'data_health_freeze'));

  for (const id of idsWhere('c', (u) => u >= 0.5, 1000)) e.assign(id, 100);
  e.tick(DAY + 1);
  assert.equal(e.frozen, null);
});

test('data health: event volume that halves overnight freezes the experiment', () => {
  const e = make({ canaryShare: 0.5, canaryMinExposures: 100000 });
  let n = 0;
  for (let day = 0; day < 6; day++) {
    for (let i = 0; i < 200; i++, n++) {
      const id = `u${n}`;
      e.assign(id, day * DAY + i);
      e.recordView(id, day * DAY + i);
    }
    e.tick((day + 1) * DAY);
  }
  assert.equal(e.frozen, null);
  for (let i = 0; i < 40; i++, n++) {
    const id = `u${n}`;
    e.assign(id, 6 * DAY + i);
    e.recordView(id, 6 * DAY + i);
  }
  e.tick(7 * DAY);
  assert.equal(e.frozen, 'event volume dropped by more than half');
});

test('visitors count only after their window closes, as a success or a failure', () => {
  const e = make({ canaryShare: 0.5, canaryMinExposures: 100000 });
  e.assign('a', 0);
  e.assign('b', 0);
  e.recordGoal('a', 3 * DAY);
  e.recordGoal('b', 8 * DAY); // outside the 7-day window: ignored
  e.tick(6 * DAY);
  assert.equal(e.counts('original').s + e.counts('v1').s + e.counts('original').f + e.counts('v1').f, 0, 'nothing finished yet');
  e.tick(8 * DAY);
  const all = ['original', 'v1'].map((id) => e.counts(id));
  assert.equal(all.reduce((x, c) => x + c.s, 0), 1);
  assert.equal(all.reduce((x, c) => x + c.f, 0), 1);
  e.recordGoal('a', 9 * DAY);
  e.tick(10 * DAY);
  assert.equal(['original', 'v1'].map((id) => e.counts(id)).reduce((x, c) => x + c.s, 0), 1, 'a visitor is never counted twice');
});
