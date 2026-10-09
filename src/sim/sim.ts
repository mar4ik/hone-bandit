import { Experiment } from '../core/experiment.ts';
import { mulberry32, normal } from '../core/rng.ts';
import { DAY, makeConfig } from '../core/types.ts';
import type { Config, DeepPartial, Stage } from '../core/types.ts';

export const CONTROL = 'original';

export interface VariantWorld {
  /** Relative lift on the goal rate. 0.25 = 25% more conversions than the original. */
  lift: number;
  /** Page error rate for this variant. Defaults to the original's. */
  errorRate?: number;
  /** Mean largest-contentful-paint in ms. Defaults to the original's. */
  lcpMs?: number;
}

export interface World {
  baseRate: number;
  visitorsPerDay: number;
  /** Share of conversions that arrive between 1 and 6.5 days after the visit. The rest arrive within half an hour. */
  lateShare: number;
  baselineErrorRate: number;
  baselineLcpMs: number;
  lcpSd: number;
  variants: Record<string, VariantWorld>;
}

export function defaultWorld(over: Partial<World> = {}): World {
  return {
    baseRate: 0.06,
    visitorsPerDay: 2000,
    lateShare: 0.2,
    baselineErrorRate: 0.01,
    baselineLcpMs: 1800,
    lcpSd: 600,
    variants: { v1: { lift: 0.3 }, v2: { lift: 0 }, v3: { lift: -0.15 } },
    ...over,
  };
}

export interface SimOptions {
  seed: number;
  days: number;
  cfg?: DeepPartial<Config>;
  /** Press the kill switch at the start of this day. */
  killAtDay?: number;
  /** Remember what the first N visitors were shown, to check stickiness later. */
  trackFirst?: number;
}

export interface DayRecord {
  day: number;
  stage: Stage;
  weights: Record<string, number>;
}

export interface SimResult {
  exp: Experiment;
  visitors: number;
  /** Conversions the visitors were expected to produce, given what each was shown. */
  expectedConversions: number;
  /** What showing the best variant to everyone would have produced. */
  oracleConversions: number;
  /** What showing the original to everyone would have produced. */
  controlConversions: number;
  /** What an even split across every variant would have produced. */
  uniformConversions: number;
  shownShare: Record<string, number>;
  history: DayRecord[];
  /** What the first `trackFirst` visitors were shown on their first visit. */
  firstShown: Record<string, string>;
}

export function runSim(world: World, opts: SimOptions): SimResult {
  const rng = mulberry32(opts.seed);
  const ids = Object.keys(world.variants);
  const cfg = makeConfig('sim', opts.cfg);
  const exp = new Experiment(cfg, CONTROL, ids, mulberry32((opts.seed ^ 0x9e3779b9) >>> 0), 0);

  const rate: Record<string, number> = { [CONTROL]: world.baseRate };
  const errRate: Record<string, number> = { [CONTROL]: world.baselineErrorRate };
  const lcp: Record<string, number> = { [CONTROL]: world.baselineLcpMs };
  for (const id of ids) {
    const v = world.variants[id];
    rate[id] = world.baseRate * (1 + v.lift);
    errRate[id] = v.errorRate ?? world.baselineErrorRate;
    lcp[id] = v.lcpMs ?? world.baselineLcpMs;
  }
  const allIds = [CONTROL, ...ids];
  const best = Math.max(...allIds.map((id) => rate[id]));
  const mean = allIds.reduce((a, id) => a + rate[id], 0) / allIds.length;

  const goalsByDay: Array<Array<[string, number]>> = [];
  const shown: Record<string, number> = {};
  for (const id of allIds) shown[id] = 0;
  const history: DayRecord[] = [];
  const firstShown: Record<string, string> = {};
  let nextId = 0;
  let visitors = 0;
  let expected = 0;

  for (let day = 0; day < opts.days; day++) {
    if (opts.killAtDay === day) exp.kill(day * DAY, 'sim kill switch');
    const n = Math.round(world.visitorsPerDay * (0.85 + 0.3 * rng()));
    for (let i = 0; i < n; i++) {
      const t = day * DAY + ((i + 0.5) / n) * DAY;
      const id = `v${nextId++}`;
      const variant = exp.assign(id, t);
      shown[variant]++;
      if (nextId <= (opts.trackFirst ?? 0)) firstShown[id] = variant;
      visitors++;
      expected += rate[variant];
      exp.recordView(id, t, {
        error: rng() < errRate[variant],
        lcpMs: Math.max(200, lcp[variant] + normal(rng) * world.lcpSd),
      });
      if (rng() < rate[variant]) {
        const late = rng() < world.lateShare;
        const at = t + (late ? DAY * (1 + rng() * 5.5) : rng() * 1_800_000);
        const d = Math.floor(at / DAY);
        (goalsByDay[d] ??= []).push([id, at]);
      }
    }
    const due = goalsByDay[day];
    if (due) {
      due.sort((a, b) => a[1] - b[1]);
      for (const [id, at] of due) exp.recordGoal(id, at);
      goalsByDay[day] = [];
    }
    exp.tick((day + 1) * DAY);
    history.push({ day, stage: exp.stage, weights: { ...exp.weights } });
  }

  const shownShare: Record<string, number> = {};
  for (const id of allIds) shownShare[id] = shown[id] / visitors;
  return {
    exp,
    visitors,
    expectedConversions: expected,
    oracleConversions: visitors * best,
    controlConversions: visitors * rate[CONTROL],
    uniformConversions: visitors * mean,
    shownShare,
    history,
    firstShown,
  };
}
