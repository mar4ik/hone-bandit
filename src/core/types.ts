export const DAY = 86_400_000;

export type Stage = 'canary' | 'warmup' | 'bandit' | 'confirm' | 'promoted' | 'stopped';

/**
 * live: can be shown to new visitors.
 * retired: dropped by the engine because it was not the leader.
 * stopped: a guardrail fired while it was still in the canary stage.
 * rolled_back: a guardrail fired after it had been given real traffic.
 */
export type VariantStatus = 'live' | 'retired' | 'stopped' | 'rolled_back';

/** n = visitors shown; s and f = visitors whose 7-day window has closed, split into converted and not. */
export interface Counts {
  n: number;
  s: number;
  f: number;
}

export interface AuditEntry {
  at: number;
  actor: 'engine' | 'safety' | 'person';
  action: string;
  variantId?: string;
  reason: string;
}

export interface Config {
  id: string;
  /** Days after a visit in which a goal still counts for that visit. */
  windowDays: number;
  /** Every live variant keeps at least this share of traffic (0.01 = 1%). */
  floor: number;
  /** Monte Carlo draws per weight update. */
  draws: number;

  /** Share of traffic each new variant gets in the canary. Small sites need more than 1% to ever get enough visitors. */
  canaryShare: number;
  /** Visitors a new variant must be shown before it can leave the canary. Must be above guardrails.minViews. */
  canaryMinExposures: number;
  canaryMinDays: number;

  warmupMinExposures: number;
  warmupMinDays: number;
  /** For the slow-goal path: each variant needs this many finished visits before a leader is picked. */
  slowPickMinMatured: number;

  /** The bandit stage always runs at least this long, so one lucky day cannot end it. */
  banditMinDays: number;
  banditMaxDays: number;
  /** Leave the bandit stage when one variant has at least this chance of being best. */
  banditStopProb: number;
  /** At the end of the bandit stage, drop variants whose chance of being best is below this. */
  retireProb: number;

  /** If at least this share of conversions arrive later than lagThresholdDays, skip the bandit. */
  slowGoalShare: number;
  lagThresholdDays: number;
  /** Owner wants a clean number: skip the bandit and run a fixed A/B. */
  requireUnbiased: boolean;

  confirm: {
    /** Smallest relative lift the fixed test is sized to detect (0.2 = +20%). */
    relMde: number;
    alpha: number;
    power: number;
    /** Used to size the test when the original has too little data to estimate its own rate. */
    fallbackBaseline: number;
    minPerArm: number;
    maxDays: number;
  };

  guardrails: {
    /** Stop a variant whose error rate is above this multiple of the original's. */
    errorRatio: number;
    minViews: number;
    minErrors: number;
    /** Stop a variant slower than the original by more than this many ms (largest contentful paint). */
    lcpDeltaMs: number;
    minLcpSamples: number;
    /** Stop a variant that is worse than the original with at least this probability. */
    worseProb: number;
    minMatured: number;
    /** Freeze if yesterday's event volume is below this share of the trailing average. */
    volumeDropRatio: number;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function makeConfig(id: string, overrides: DeepPartial<Config> = {}): Config {
  const base: Config = {
    id,
    windowDays: 7,
    floor: 0.01,
    draws: 4000,
    canaryShare: 0.01,
    canaryMinExposures: 300,
    canaryMinDays: 1,
    warmupMinExposures: 500,
    warmupMinDays: 7,
    slowPickMinMatured: 300,
    banditMinDays: 7,
    banditMaxDays: 21,
    banditStopProb: 0.95,
    retireProb: 0.05,
    slowGoalShare: 0.5,
    lagThresholdDays: 1,
    requireUnbiased: false,
    confirm: {
      relMde: 0.2,
      alpha: 0.05,
      power: 0.8,
      fallbackBaseline: 0.03,
      minPerArm: 0,
      maxDays: 42,
    },
    guardrails: {
      errorRatio: 2,
      minViews: 200,
      minErrors: 5,
      lcpDeltaMs: 200,
      minLcpSamples: 200,
      worseProb: 0.95,
      minMatured: 200,
      volumeDropRatio: 0.5,
    },
  };
  const { confirm, guardrails, ...top } = overrides;
  return {
    ...base,
    ...(top as Partial<Config>),
    id,
    confirm: { ...base.confirm, ...(confirm ?? {}) },
    guardrails: { ...base.guardrails, ...(guardrails ?? {}) },
  };
}
