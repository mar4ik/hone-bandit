import { Engine } from '../core/engine.ts';
import { hash32, mulberry32 } from '../core/rng.ts';
import { DAY } from '../core/types.ts';
import type { Store, MeasureSpec } from './store.ts';
import { fullOrder, isFinished } from './types.ts';
import type { ExperimentRow } from './types.ts';

export type TickResult = 'done' | 'busy' | 'finished' | 'killed' | 'missing';

/**
 * A finished experiment is measured as of the moment it finished: its tracking stopped then, so counting visitors
 * who "settle" later as failures would make the final numbers look worse than they were.
 */
export function measureSpec(row: ExperimentRow, now: number): MeasureSpec {
  const cfg = row.def.config;
  return {
    order: fullOrder(row.def),
    now: isFinished(row.state) ? Math.min(now, row.state.stageStartedAt) : now,
    windowMs: cfg.windowDays * DAY,
    lagMs: cfg.lagThresholdDays * DAY,
    confirmPhase: row.state.confirmPhase,
    confirmN: row.state.confirmN,
    phase: row.state.phase,
  };
}

/** The engine as it stands right now, rebuilt from the database. Does not change anything. */
export async function loadEngine(store: Store, row: ExperimentRow, now: number): Promise<Engine> {
  const m = await store.measure(row.def.id, measureSpec(row, now));
  return Engine.restore(row.def.config, fullOrder(row.def), mulberry32(hash32(`${row.def.id}|${now}`)), row.state, m, row.killed);
}

/**
 * One thinking step for one experiment: measure, decide, save.
 * Safe to call from several places at once: only the caller that gets the lease does the work.
 */
export async function runTick(store: Store, experimentId: string, now: number, leaseMs = 120_000): Promise<TickResult> {
  const first = await store.getExperiment(experimentId);
  if (!first) return 'missing';
  if (isFinished(first.state)) return 'finished';
  if (first.killed) return 'killed';

  const token = crypto.randomUUID();
  if (!(await store.claimTick(experimentId, token, now, leaseMs))) return 'busy';

  // Read again after taking the lease, in case another tick finished while this one was starting.
  const row = await store.getExperiment(experimentId);
  if (!row || isFinished(row.state) || row.killed) {
    await store.saveTick(experimentId, token, (row ?? first).state, [], now);
    return row ? (row.killed ? 'killed' : 'finished') : 'missing';
  }
  const engine = await loadEngine(store, row, now);
  engine.think(now);
  const saved = await store.saveTick(experimentId, token, engine.toState(), engine.audit, now);
  return saved ? 'done' : 'busy';
}
