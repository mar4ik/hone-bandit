import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL, defaultWorld, runSim } from '../src/sim/sim.ts';
import type { SimResult } from '../src/sim/sim.ts';

const stagesOf = (r: SimResult) => r.exp.audit.filter((a) => a.action.startsWith('stage_')).map((a) => a.action.slice(6));

function many(n: number, f: (seed: number) => SimResult): SimResult[] {
  return Array.from({ length: n }, (_, i) => f(i + 1));
}

test('one real winner: it is found and confirmed most of the time, and the others are never shipped', () => {
  const runs = many(24, (seed) => runSim(defaultWorld(), { seed, days: 100 }));
  const promoted = runs.filter((r) => r.exp.outcome?.kind === 'promoted');
  const winners = promoted.map((r) => r.exp.outcome!.winnerId);
  assert.ok(winners.filter((w) => w === 'v1').length >= 17, `v1 shipped in only ${winners.filter((w) => w === 'v1').length} of 24`);
  assert.equal(winners.filter((w) => w === 'v3').length, 0, 'the worse variant must never ship');
  assert.ok(winners.filter((w) => w === 'v2').length <= 1, 'the neutral variant shipped too often');

  const lifts = promoted.map((r) => r.exp.outcome!.relLift as number);
  const meanLift = lifts.reduce((a, b) => a + b, 0) / lifts.length;
  assert.ok(meanLift > 0.2 && meanLift < 0.45, `measured lift ${meanLift} should be near the true 0.30`);

  const vsControl = runs.reduce((a, r) => a + r.expectedConversions / r.controlConversions, 0) / runs.length;
  const vsUniform = runs.reduce((a, r) => a + r.expectedConversions / r.uniformConversions, 0) / runs.length;
  assert.ok(vsControl > 1.1, `only ${vsControl}x the original`);
  assert.ok(vsUniform > 1.05, `only ${vsUniform}x an even split`);
});

test('nothing is better: the original is almost never replaced', () => {
  const world = defaultWorld({ variants: { v1: { lift: 0 }, v2: { lift: 0 }, v3: { lift: 0 } } });
  const runs = many(40, (seed) => runSim(world, { seed: 100 + seed, days: 100 }));
  const shipped = runs.filter((r) => r.exp.outcome?.kind === 'promoted').length;
  assert.ok(shipped <= 4, `${shipped} of 40 false wins`);
});

test('every live variant keeps at least 1% of traffic, and weights always sum to 1', () => {
  const r = runSim(defaultWorld(), { seed: 7, days: 80 });
  let sawBandit = false;
  for (const d of r.history) {
    const positive = Object.values(d.weights).filter((w) => w > 0);
    assert.ok(Math.abs(Object.values(d.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9, `day ${d.day} does not sum to 1`);
    if (d.stage === 'canary' || d.stage === 'warmup' || d.stage === 'bandit') for (const w of positive) assert.ok(w >= 0.01 - 1e-9, `day ${d.day} has weight ${w}`);
    if (d.stage === 'bandit') sawBandit = true;
  }
  assert.ok(sawBandit, 'the run never reached the bandit stage');
});

test('stage order is canary, warm-up, bandit, confirm, then a result', () => {
  const r = runSim(defaultWorld(), { seed: 11, days: 100 });
  assert.deepEqual(stagesOf(r).slice(0, 3), ['warmup', 'bandit', 'confirm']);
  assert.ok(['promoted', 'stopped'].includes(stagesOf(r).at(-1) as string));
});

test('slow goal: the bandit is skipped and a fixed A/B runs straight from warm-up', () => {
  const runs = many(8, (seed) => runSim(defaultWorld({ lateShare: 0.8 }), { seed: 200 + seed, days: 120 }));
  for (const r of runs) {
    assert.ok(!stagesOf(r).includes('bandit'), 'bandit should be skipped');
    assert.ok(stagesOf(r).includes('confirm') || r.exp.outcome?.reason === 'all_challengers_stopped');
  }
  assert.ok(runs.filter((r) => r.exp.outcome?.winnerId === 'v1').length >= 5);
});

test('owner asks for an unbiased number: the bandit is skipped', () => {
  const r = runSim(defaultWorld(), { seed: 21, days: 100, cfg: { requireUnbiased: true } });
  assert.ok(!stagesOf(r).includes('bandit'));
  assert.ok(stagesOf(r).includes('confirm'));
});

test('planted bad variants: the buggy one and the slow one never ship, even though they would convert better', () => {
  const world = defaultWorld({
    variants: {
      good: { lift: 0.3 },
      buggy: { lift: 0.6, errorRate: 0.025 },
      slow: { lift: 0.6, lcpMs: 2300 },
    },
  });
  const runs = many(12, (seed) => runSim(world, { seed: 300 + seed, days: 100 }));
  for (const r of runs) {
    assert.ok(['stopped', 'rolled_back'].includes(r.exp.status('buggy')), `buggy ended ${r.exp.status('buggy')}`);
    assert.ok(['stopped', 'rolled_back'].includes(r.exp.status('slow')), `slow ended ${r.exp.status('slow')}`);
    assert.ok(r.exp.outcome?.winnerId !== 'buggy' && r.exp.outcome?.winnerId !== 'slow');
  }
  assert.ok(runs.filter((r) => r.exp.outcome?.winnerId === 'good').length >= 7, 'the good variant should still win most runs');
});

test('the engine writes a reason for everything it stops or ships', () => {
  const world = defaultWorld({ variants: { good: { lift: 0.3 }, buggy: { lift: 0.5, errorRate: 0.025 } } });
  const r = runSim(world, { seed: 5, days: 100 });
  const stopped = r.exp.audit.filter((a) => a.action === 'stopped' || a.action === 'rolled_back');
  assert.ok(stopped.length >= 1);
  for (const a of r.exp.audit) {
    assert.ok(a.reason.length > 0, `${a.action} has no reason`);
    assert.ok(['engine', 'safety', 'person'].includes(a.actor));
  }
});

test('stickiness through every stage: visitors keep what they saw while that variant is still live', () => {
  const r = runSim(defaultWorld(), { seed: 13, days: 40, trackFirst: 60_000 });
  assert.equal(r.exp.stage, 'confirm', 'the run should end in the confirm stage so that weights moved several times');
  assert.ok(stagesOf(r).includes('bandit'));
  const now = 41 * 86_400_000;
  let checked = 0;
  let checkedChallengers = 0;
  for (const [id, variant] of Object.entries(r.firstShown)) {
    if (r.exp.status(variant) !== 'live') continue;
    assert.equal(r.exp.assign(id, now), variant, `${id} changed variant`);
    checked++;
    if (variant !== CONTROL) checkedChallengers++;
  }
  assert.ok(checked > 20_000, `only ${checked} visitors checked`);
  assert.ok(checkedChallengers > 2_000, `only ${checkedChallengers} challenger visitors checked`);
});

test('kill switch in the middle of a run freezes everything and shows the original', () => {
  const r = runSim(defaultWorld(), { seed: 5, days: 60, killAtDay: 30 });
  assert.equal(r.exp.killed, true);
  assert.equal(r.history[59].stage, r.history[29].stage, 'stage must not move while killed');
  assert.deepEqual(r.exp.snapshot().weights[CONTROL], 1);
  const shownAfterKill = r.exp.snapshot().variants.reduce((a, v) => a + v.shown, 0);
  assert.ok(shownAfterKill < r.visitors * 0.6, 'visitors after the kill must not be counted');
});
