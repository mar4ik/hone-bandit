import type { Engine, Snapshot } from '../../src/core/engine.ts';
import { Experiment } from '../../src/core/experiment.ts';
import { hash32, mulberry32, normal } from '../../src/core/rng.ts';
import { DAY, makeConfig } from '../../src/core/types.ts';
import type { Config, DeepPartial } from '../../src/core/types.ts';
import { handleAdmin, handleDecide, handleEvent } from '../../src/server/handlers.ts';
import type { Ctx } from '../../src/server/handlers.ts';
import type { Store } from '../../src/server/store.ts';
import { loadEngine, runTick } from '../../src/server/tick.ts';
import { CONTROL_ID } from '../../src/server/types.ts';
import type { World } from '../../src/sim/sim.ts';
import { ADMIN, ORIGIN, UA, adminReq, experimentBody } from './fixtures.ts';

/** Three days short of "a long time ago": keeps day numbers realistic and a multiple of a day. */
export const T0 = 20_000 * DAY;
export const vid = (n: number): string => `vis-${String(n).padStart(8, '0')}`;

export interface Backend {
  assign(id: string, t: number): Promise<string>;
  view(id: string, t: number, h: { error: boolean; lcpMs: number }): Promise<void>;
  goal(id: string, t: number): Promise<void>;
  tick(t: number): Promise<void>;
}

/** The simulator's loop (same draws in the same order as src/sim/sim.ts), but talking to any backend. */
export async function drive(world: World, seed: number, days: number, backend: Backend): Promise<{ visitors: number }> {
  const rng = mulberry32(seed);
  const ids = Object.keys(world.variants);
  const rate: Record<string, number> = { [CONTROL_ID]: world.baseRate };
  const errRate: Record<string, number> = { [CONTROL_ID]: world.baselineErrorRate };
  const lcp: Record<string, number> = { [CONTROL_ID]: world.baselineLcpMs };
  for (const id of ids) {
    const v = world.variants[id];
    rate[id] = world.baseRate * (1 + v.lift);
    errRate[id] = v.errorRate ?? world.baselineErrorRate;
    lcp[id] = v.lcpMs ?? world.baselineLcpMs;
  }
  const goalsByDay: Array<Array<[string, number]>> = [];
  let nextId = 0;
  for (let day = 0; day < days; day++) {
    const n = Math.round(world.visitorsPerDay * (0.85 + 0.3 * rng()));
    for (let i = 0; i < n; i++) {
      const t = T0 + Math.floor(day * DAY + ((i + 0.5) / n) * DAY);
      const id = vid(nextId++);
      const variant = await backend.assign(id, t);
      await backend.view(id, t, {
        error: rng() < errRate[variant],
        lcpMs: Math.max(200, lcp[variant] + normal(rng) * world.lcpSd),
      });
      if (rng() < rate[variant]) {
        const late = rng() < world.lateShare;
        const at = t + Math.floor(late ? DAY * (1 + rng() * 5.5) : rng() * 1_800_000);
        const d = Math.floor((at - T0) / DAY);
        (goalsByDay[d] ??= []).push([id, at]);
      }
    }
    const due = goalsByDay[day];
    if (due) {
      due.sort((a, b) => a[1] - b[1]);
      for (const [id, at] of due) await backend.goal(id, at);
      goalsByDay[day] = [];
    }
    await backend.tick(T0 + (day + 1) * DAY);
  }
  return { visitors: nextId };
}

export const EXP_ID = 'exp_equiv0001';

export function makeCfg(overrides: DeepPartial<Config>): Config {
  return makeConfig(EXP_ID, overrides);
}

/** The in-memory engine, driven the way the simulator drives it. */
export function harnessBackend(cfg: Config, challengers: string[]): { backend: Backend; exp: Experiment; finalSnapshot: () => Snapshot } {
  const exp = new Experiment(cfg, CONTROL_ID, challengers, mulberry32(1), T0);
  let atFinish: Snapshot | null = null;
  const backend: Backend = {
    async assign(id, t) {
      return exp.assign(id, t);
    },
    async view(id, t, h) {
      exp.recordView(id, t, h);
    },
    async goal(id, t) {
      exp.recordGoal(id, t);
    },
    async tick(t) {
      exp.rng = mulberry32(hash32(`${cfg.id}|${t}`));
      exp.tick(t);
      if (atFinish === null && (exp.stage === 'promoted' || exp.stage === 'stopped')) atFinish = exp.snapshot();
    },
  };
  // The server stops counting when the experiment finishes, so compare with the numbers from that moment.
  return { backend, exp, finalSnapshot: () => atFinish ?? exp.snapshot() };
}

/** The real handlers over a store, with a clock that the driver moves. */
export async function serverBackend(
  store: Store,
  challengers: string[],
  cfgOverrides: DeepPartial<Config>,
): Promise<{ backend: Backend; ctx: Ctx; clock: { t: number } }> {
  const clock = { t: T0 };
  const ctx: Ctx = { store, now: () => clock.t, adminToken: ADMIN, cronSecret: 'x', tickEveryMs: 0 };
  const variants = Object.fromEntries(
    challengers.map((id, i) => [
      id,
      { label: `Variant ${id}`, changes: [{ selector: 'h1.hero-title', kind: 'text', text: `Learn AI the ${['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma'][i]} way`, context: { color: '#14202B', background: '#F6F6F1', fontSizePx: 48 } }] },
    ]),
  );
  const res = await handleAdmin(adminReq('POST', '/experiments', experimentBody({ id: EXP_ID, variants, config: cfgOverrides })), ctx);
  if (res.status !== 201) throw new Error(`could not create: ${await res.text()}`);

  const headers = { 'user-agent': UA, origin: ORIGIN };
  const post = (body: unknown) =>
    handleEvent(new Request('https://hone.example/api/event', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: JSON.stringify(body) }), ctx);
  const backend: Backend = {
    async assign(id, t) {
      clock.t = t;
      const res = await handleDecide(new Request(`https://hone.example/api/decide?e=${EXP_ID}&v=${id}&p=%2F`, { headers }), ctx);
      return ((await res.json()) as { variant: string }).variant;
    },
    async view(id, t, h) {
      clock.t = t;
      await post({ e: EXP_ID, v: id, t: 'view', p: '/', err: h.error ? 1 : 0 });
      await post({ e: EXP_ID, v: id, t: 'health', p: '/', err: 0, lcp: h.lcpMs });
    },
    async goal(id, t) {
      clock.t = t;
      await post({ e: EXP_ID, v: id, t: 'goal', p: '/' });
    },
    async tick(t) {
      clock.t = t;
      await runTick(store, EXP_ID, t);
    },
  };
  return { backend, ctx, clock };
}

/** What both paths must agree on, once they have seen the same traffic. */
export async function serverSummary(store: Store, now: number) {
  const row = (await store.getExperiment(EXP_ID))!;
  const engine: Engine = await loadEngine(store, row, now);
  return { state: row.state, audit: await store.readAudit(EXP_ID, 10_000), snapshot: engine.snapshot() };
}
