import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, decide, viewFromState } from '../src/core/engine.ts';
import type { Measurements } from '../src/core/engine.ts';
import { mulberry32 } from '../src/core/rng.ts';
import { DAY } from '../src/core/types.ts';
import { defaultWorld, runSim } from '../src/sim/sim.ts';

const order = ['original', 'v1', 'v2', 'v3'];

/** What a database round trip does to the data: plain JSON, nothing else survives. */
const viaJson = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('an engine rebuilt from saved state and saved measurements decides exactly what the live one does, at every stage', () => {
  const seen = new Set<string>();
  for (const days of [1, 4, 9, 16, 25, 40, 70]) {
    const r = runSim(defaultWorld(), { seed: 3, days });
    const live = r.exp;
    const t = days * DAY + 3_600_000;
    live.settle(t);

    const state = viaJson(live.toState());
    const m = viaJson(live.m) as Measurements;
    const copy = Engine.restore(live.cfg, order, mulberry32(5), state, m, live.killed);
    live.rng = mulberry32(5);
    const before = live.audit.length;

    live.think(t);
    copy.think(t);

    assert.deepEqual(copy.toState(), live.toState(), `state differs after ${days} days (${live.stage})`);
    assert.deepEqual(copy.audit, live.audit.slice(before), `audit differs after ${days} days`);
    assert.deepEqual(copy.snapshot(), live.snapshot());
    seen.add(live.stage);
  }
  assert.ok(seen.has('canary') && seen.has('warmup') && seen.has('bandit') && seen.has('confirm'), `only saw ${[...seen]}`);
});

test('the decision for a new visitor is the same function in the simulator and on the server', () => {
  const seen = new Set<string>();
  for (const days of [0, 2, 10, 16, 25, 40, 90]) {
    const r = runSim(defaultWorld(), { seed: 3, days });
    const live = r.exp;
    const view = viewFromState(live.cfg.id, order, viaJson(live.toState()), live.killed);
    const t = (days + 1) * DAY;
    for (let i = 0; i < 1500; i++) {
      const id = `new-${days}-${i}`;
      const expected = decide(view, null, id);
      assert.equal(live.assign(id, t), expected.shown);
    }
    seen.add(live.stage);
  }
  assert.ok(seen.size >= 4, `only saw ${[...seen]}`);
});

test('a returning visitor whose variant was stopped sees the original; killed or finished experiments ignore stored variants', () => {
  const r = runSim(defaultWorld({ variants: { good: { lift: 0.3 }, buggy: { lift: 0.5, errorRate: 0.03 } } }), { seed: 4, days: 12 });
  const s = viaJson(r.exp.toState());
  const view = viewFromState(r.exp.cfg.id, ['original', 'good', 'buggy'], s, false);
  if (s.variants.buggy.status !== 'live') assert.equal(decide(view, 'buggy', 'x').shown, 'original');
  assert.equal(decide({ ...view, killed: true }, 'good', 'x').shown, 'original');
  assert.deepEqual(decide({ ...view, killed: true }, null, 'x'), { shown: 'original', create: null });
});

test('every old state field survives the JSON round trip (nothing is lost when stored)', () => {
  const r = runSim(defaultWorld(), { seed: 2, days: 30 });
  const s = r.exp.toState();
  assert.deepEqual(viaJson(s), s);
  assert.ok(s.confirmPhase === null || typeof s.confirmPhase === 'number');
});
