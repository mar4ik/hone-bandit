import test from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, mulberry32 } from '../src/core/rng.ts';
import { sampleBeta } from '../src/core/beta.ts';
import { applyFloor, pickByWeight, probBest, probWorse, thompsonWeights } from '../src/core/thompson.ts';
import { normCdf, normInv, plannedPerArm, srmFlagged, twoProportionTest } from '../src/core/stats.ts';

test('hashUnit is stable and spreads visitors evenly', () => {
  assert.equal(hashUnit('exp|visitor-1'), hashUnit('exp|visitor-1'));
  assert.notEqual(hashUnit('exp|visitor-1'), hashUnit('exp|visitor-2'));
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100_000; i++) buckets[Math.floor(hashUnit(`exp|v${i}`) * 10)]++;
  for (const b of buckets) assert.ok(Math.abs(b - 10_000) < 400, `bucket ${b} is too far from 10000`);
});

test('beta draws have the right mean and spread', () => {
  const rng = mulberry32(1);
  const xs = Array.from({ length: 60_000 }, () => sampleBeta(2, 5, rng));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  assert.ok(Math.abs(mean - 2 / 7) < 0.004, `mean ${mean}`);
  assert.ok(Math.abs(v - (2 * 5) / (49 * 8)) < 0.002, `variance ${v}`);
});

test('probBest favours the clearly better arm and sums to 1', () => {
  const rng = mulberry32(2);
  const pb = probBest([{ id: 'a', alpha: 1 + 50, beta: 1 + 950 }, { id: 'b', alpha: 1 + 90, beta: 1 + 910 }], rng);
  assert.ok(pb.b > 0.95);
  assert.ok(Math.abs(pb.a + pb.b - 1) < 1e-9);
});

test('probWorse spots a variant that is worse than the original', () => {
  const rng = mulberry32(3);
  const control = { id: 'c', alpha: 1 + 120, beta: 1 + 880 };
  assert.ok(probWorse(control, { id: 'v', alpha: 1 + 60, beta: 1 + 940 }, rng) > 0.99);
  assert.ok(probWorse(control, { id: 'v', alpha: 1 + 120, beta: 1 + 880 }, rng) < 0.7);
});

test('the traffic floor holds and weights still sum to 1', () => {
  const w = applyFloor({ a: 0.999, b: 0.001, c: 0, d: 0 }, 0.01);
  for (const x of Object.values(w)) assert.ok(x >= 0.01 - 1e-12);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const t = thompsonWeights(
    [{ id: 'a', alpha: 500, beta: 9500 }, { id: 'b', alpha: 5, beta: 9995 }],
    mulberry32(4),
    0.01,
  );
  assert.ok(t.b >= 0.01 - 1e-12);
});

test('pickByWeight follows the weights and skips zero-weight ids', () => {
  const order = ['a', 'b', 'c'];
  const weights = { a: 0.5, b: 0, c: 0.5 };
  assert.equal(pickByWeight(0.1, order, weights), 'a');
  assert.equal(pickByWeight(0.6, order, weights), 'c');
  assert.equal(pickByWeight(0.999999, order, weights), 'c');
});

test('normal distribution helpers', () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-4);
  assert.ok(Math.abs(normInv(0.8) - 0.84162) < 1e-4);
});

test('two-proportion test matches a hand calculation', () => {
  const t = twoProportionTest(100, 1000, 130, 1000);
  assert.ok(Math.abs(t.z - 2.1) < 0.02, `z ${t.z}`);
  assert.ok(t.p > 0.03 && t.p < 0.04, `p ${t.p}`);
  assert.ok(Math.abs((t.relLift as number) - 0.3) < 1e-9);
  assert.ok((t.ci as [number, number])[0] > 0);
});

test('planned sample size matches the standard formula', () => {
  const n = plannedPerArm(0.05, 0.2);
  assert.ok(n > 8000 && n < 8300, `n ${n}`);
});

test('sample ratio mismatch is flagged only for real skew', () => {
  assert.equal(srmFlagged([5030, 4970], [5000, 5000]), false);
  assert.equal(srmFlagged([5400, 4600], [5000, 5000]), true);
});
