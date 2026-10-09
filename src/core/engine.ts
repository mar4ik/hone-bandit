import { hashUnit } from './rng.ts';
import type { Rng } from './rng.ts';
import { equalWeights, pickByWeight, probBest, probWorse, thompsonWeights } from './thompson.ts';
import type { Arm, Weights } from './thompson.ts';
import { plannedPerArm, srmFlagged, twoProportionTest } from './stats.ts';
import { DAY } from './types.ts';
import type { AuditEntry, Config, Counts, Stage, VariantStatus } from './types.ts';

// ------------------------------------------------------------------ shapes that cross the database boundary

export interface Outcome {
  kind: 'promoted' | 'stopped';
  reason: string;
  winnerId?: string;
  /** Relative lift measured in the fixed test, with a 95% interval. */
  relLift?: number | null;
  ci?: [number, number] | null;
  p?: number;
  perArm?: number;
}

export interface Snapshot {
  stage: Stage;
  killed: boolean;
  frozen: string | null;
  weights: Weights;
  variants: Array<{
    id: string;
    status: VariantStatus;
    reason: string | null;
    shown: number;
    finished: number;
    converted: number;
    rate: number | null;
  }>;
  outcome: Outcome | null;
}

/**
 * What the engine has measured so far. In the simulator it is kept up to date one event at a time.
 * On the server it is recomputed from the stored rows before every tick. Either way the engine only reads it.
 */
export interface VariantMeasure {
  /** n = every visitor ever shown this variant. s and f = those whose window has closed, converted or not. */
  total: Counts;
  views: number;
  errors: number;
  lcpN: number;
  lcpSum: number;
  lcpSumSq: number;
}

export interface PhaseMeasure {
  /** Only visitors who count for the analysis. In the confirm phase that is the planned number per arm. */
  counts: Record<string, Counts>;
  /** Everyone assigned in this phase, counted or not. Used for the split check. */
  tally: Record<string, number>;
}

export interface Measurements {
  variants: Record<string, VariantMeasure>;
  /** Indexed by phase. A new phase starts at every stage change. */
  phases: PhaseMeasure[];
  /** Settled conversions, and how many of them came later than lagThresholdDays. */
  lagN: number;
  lagLate: number;
  /** Page views per day number (ms / DAY), for the last few days. */
  dayViews: Record<number, number>;
}

export function emptyMeasurements(order: string[], phases = 1): Measurements {
  const m: Measurements = { variants: {}, phases: [], lagN: 0, lagLate: 0, dayViews: {} };
  fillMeasurements(m, order, phases);
  return m;
}

/** Makes sure every variant and every phase has an entry, so the engine never meets a hole. */
export function fillMeasurements(m: Measurements, order: string[], phases: number): void {
  for (const id of order) {
    m.variants[id] ??= { total: { n: 0, s: 0, f: 0 }, views: 0, errors: 0, lcpN: 0, lcpSum: 0, lcpSumSq: 0 };
  }
  for (let p = 0; p < phases; p++) {
    const ph = (m.phases[p] ??= { counts: {}, tally: {} });
    for (const id of order) {
      ph.counts[id] ??= { n: 0, s: 0, f: 0 };
      ph.tally[id] ??= 0;
    }
  }
}

/** Everything the engine decides, as plain JSON. Written by the tick and nothing else. */
export interface EngineState {
  stage: Stage;
  stageStartedAt: number;
  phase: number;
  weights: Weights;
  frozen: string | null;
  winnerId: string | null;
  outcome: Outcome | null;
  confirmLeaderId: string | null;
  confirmN: number;
  /** The phase in which the fixed test runs. Only visitors up to confirmN per arm in this phase count. */
  confirmPhase: number | null;
  phaseWeights: Weights;
  phaseLiveKey: string;
  markPending: boolean;
  variants: Record<string, { status: VariantStatus; reason: string | null }>;
}

// ------------------------------------------------------------------ the part a visitor request needs

/** The small, read-only view that answers "which variant does this visitor see". */
export interface DecisionView {
  readonly cfg: { readonly id: string };
  readonly controlId: string;
  readonly order: string[];
  readonly stage: Stage;
  readonly killed: boolean;
  readonly weights: Weights;
  readonly winnerId: string | null;
  status(id: string): VariantStatus;
}

export function shownVariant(v: DecisionView, variantId: string): string {
  if (v.stage === 'promoted') return v.winnerId as string;
  if (v.stage === 'stopped') return v.controlId;
  return v.status(variantId) === 'live' ? variantId : v.controlId;
}

export function chooseVariant(v: DecisionView, visitorId: string): string {
  return pickByWeight(hashUnit(`${v.cfg.id}|${visitorId}`), v.order, v.weights);
}

/**
 * The one rule for what a visitor sees.
 * `existing` is the variant stored for this visitor, if any. `create` is set when a new visitor record must be stored.
 */
export function decide(v: DecisionView, existing: string | null, visitorId: string): { shown: string; create: string | null } {
  if (v.killed) return { shown: v.controlId, create: null };
  if (existing !== null) return { shown: shownVariant(v, existing), create: null };
  if (v.stage === 'promoted') return { shown: v.winnerId as string, create: null };
  if (v.stage === 'stopped') return { shown: v.controlId, create: null };
  const variantId = chooseVariant(v, visitorId);
  return { shown: variantId, create: variantId };
}

/** A DecisionView built from saved JSON, for the server. */
export function viewFromState(cfgId: string, order: string[], state: EngineState, killed: boolean): DecisionView {
  return {
    cfg: { id: cfgId },
    controlId: order[0],
    order,
    stage: state.stage,
    killed,
    weights: state.weights,
    winnerId: state.winnerId,
    status: (id) => state.variants[id]?.status ?? 'retired',
  };
}

// ------------------------------------------------------------------ the engine

/**
 * One experiment on one place on a page: the original against a few challengers.
 *
 * The engine decides and nothing else. It reads `m` (what was measured) and writes its own state.
 * It does not store visitors; that is the job of whoever owns the traffic (the simulator, or the database).
 *
 * Rules the caller must follow:
 * - Times are numbers in milliseconds and must not go backwards between calls.
 * - Call `think(now)` regularly. It does all the thinking. `m` must be up to date before each call.
 */
export class Engine implements DecisionView {
  readonly cfg: Config;
  readonly controlId: string;
  readonly order: string[];
  /** Entries written since this object was made. Persist them, then start from an empty list next time. */
  readonly audit: AuditEntry[] = [];

  stage: Stage = 'canary';
  stageStartedAt = 0;
  phase = 0;
  weights: Weights = {};
  killed = false;
  /** Set when data looks wrong. While set, weights and stages do not move. */
  frozen: string | null = null;
  winnerId: string | null = null;
  outcome: Outcome | null = null;
  confirmLeaderId: string | null = null;
  confirmN = 0;
  confirmPhase: number | null = null;

  rng: Rng;
  m: Measurements;
  protected vstate: Record<string, { status: VariantStatus; reason: string | null }> = {};
  protected phaseWeights: Weights = {};
  protected phaseLiveKey = '';
  protected markPending = false;

  constructor(
    cfg: Config,
    controlId: string,
    challengerIds: string[],
    rng: Rng,
    startAt: number,
    restored?: { state: EngineState; m: Measurements; killed: boolean },
  ) {
    this.cfg = cfg;
    this.controlId = controlId;
    this.rng = rng;
    this.order = [controlId, ...challengerIds];
    for (const id of this.order) this.vstate[id] = { status: 'live', reason: null };

    if (restored) {
      const s = structuredClone(restored.state);
      this.stage = s.stage;
      this.stageStartedAt = s.stageStartedAt;
      this.phase = s.phase;
      this.weights = s.weights;
      this.frozen = s.frozen;
      this.winnerId = s.winnerId;
      this.outcome = s.outcome;
      this.confirmLeaderId = s.confirmLeaderId;
      this.confirmN = s.confirmN;
      this.confirmPhase = s.confirmPhase;
      this.phaseWeights = s.phaseWeights;
      this.phaseLiveKey = s.phaseLiveKey;
      this.markPending = s.markPending;
      for (const id of this.order) this.vstate[id] = s.variants[id] ?? this.vstate[id];
      this.killed = restored.killed;
      this.m = restored.m;
      fillMeasurements(this.m, this.order, this.phase + 1);
      return;
    }

    this.m = emptyMeasurements(this.order, 1);
    this.stageStartedAt = startAt;
    this.log(startAt, 'engine', 'experiment_started', undefined, `canary: ${challengerIds.length} challenger(s), each on ${(cfg.canaryShare * 100).toFixed(0)}% of visitors`);
    this.recomputeWeights();
    this.markPhaseWeights();
  }

  /** Rebuilds an engine from saved state and fresh measurements. `order[0]` is the original. */
  static restore(cfg: Config, order: string[], rng: Rng, state: EngineState, m: Measurements, killed: boolean): Engine {
    return new Engine(cfg, order[0], order.slice(1), rng, state.stageStartedAt, { state, m, killed });
  }

  /** Everything the engine decided, as JSON. */
  toState(): EngineState {
    return structuredClone({
      stage: this.stage,
      stageStartedAt: this.stageStartedAt,
      phase: this.phase,
      weights: this.weights,
      frozen: this.frozen,
      winnerId: this.winnerId,
      outcome: this.outcome,
      confirmLeaderId: this.confirmLeaderId,
      confirmN: this.confirmN,
      confirmPhase: this.confirmPhase,
      phaseWeights: this.phaseWeights,
      phaseLiveKey: this.phaseLiveKey,
      markPending: this.markPending,
      variants: this.vstate,
    });
  }

  // ---------------------------------------------------------------- control

  kill(now: number, reason: string): void {
    if (this.killed) return;
    this.killed = true;
    this.log(now, 'person', 'kill_switch_on', undefined, reason);
  }

  resume(now: number, reason: string): void {
    if (!this.killed) return;
    this.killed = false;
    this.log(now, 'person', 'kill_switch_off', undefined, reason);
  }

  /** The engine's thinking step. `m` must already include everything up to `now`. */
  think(now: number): void {
    if (this.stage === 'promoted' || this.stage === 'stopped') return;
    if (this.killed) return;
    this.checkGuardrails(now);
    this.checkDataHealth(now);
    if (!this.frozen) this.advanceStage(now);
    this.recomputeWeights();
    if (this.markPending) {
      this.markPhaseWeights();
      this.markPending = false;
    }
  }

  snapshot(): Snapshot {
    return {
      stage: this.stage,
      killed: this.killed,
      frozen: this.frozen,
      weights: this.killed ? { ...Object.fromEntries(this.order.map((id) => [id, 0])), [this.controlId]: 1 } : { ...this.weights },
      variants: this.order.map((id) => {
        const v = this.vstate[id];
        const t = this.m.variants[id].total;
        const finished = t.s + t.f;
        return {
          id,
          status: v.status,
          reason: v.reason,
          shown: t.n,
          finished,
          converted: t.s,
          rate: finished > 0 ? t.s / finished : null,
        };
      }),
      outcome: this.outcome,
    };
  }

  /** Counts for one variant. Exposed for the simulator and for reporting. */
  counts(id: string): Counts {
    return { ...this.m.variants[id].total };
  }

  status(id: string): VariantStatus {
    return this.vstate[id].status;
  }

  // ---------------------------------------------------------------- internals: bookkeeping

  protected log(at: number, actor: AuditEntry['actor'], action: string, variantId: string | undefined, reason: string): void {
    this.audit.push({ at, actor, action, variantId, reason });
  }

  protected shown(variantId: string): string {
    return shownVariant(this, variantId);
  }

  private liveIds(): string[] {
    return this.order.filter((id) => id === this.controlId || this.vstate[id].status === 'live');
  }

  private liveChallengerIds(): string[] {
    return this.liveIds().filter((id) => id !== this.controlId);
  }

  private liveKey(): string {
    return this.liveIds().join(',');
  }

  private arm(id: string): Arm {
    const t = this.m.variants[id].total;
    return { id, alpha: 1 + t.s, beta: 1 + t.f };
  }

  private arms(ids: string[]): Arm[] {
    return ids.map((id) => this.arm(id));
  }

  private markPhaseWeights(): void {
    this.phaseWeights = { ...this.weights };
    this.phaseLiveKey = this.liveKey();
  }

  // ---------------------------------------------------------------- internals: guardrails and data health

  private stopVariant(id: string, now: number, reason: string): void {
    const v = this.vstate[id];
    v.status = this.stage === 'canary' ? 'stopped' : 'rolled_back';
    v.reason = reason;
    this.log(now, 'engine', v.status, id, reason);
  }

  private checkGuardrails(now: number): void {
    const g = this.cfg.guardrails;
    const c = this.m.variants[this.controlId];
    const cMatured = c.total.s + c.total.f;
    for (const id of this.order) {
      if (id === this.controlId) continue;
      const v = this.m.variants[id];
      if (this.vstate[id].status !== 'live') continue;

      if (v.views >= g.minViews && c.views >= g.minViews && v.errors >= g.minErrors) {
        const rv = v.errors / v.views;
        const rc = Math.max(c.errors, 0.5) / c.views;
        const pool = (v.errors + c.errors) / (v.views + c.views);
        const se = Math.sqrt(pool * (1 - pool) * (1 / v.views + 1 / c.views));
        const z = se > 0 ? (rv - rc) / se : 0;
        if (rv > g.errorRatio * rc && z > 2.33) {
          this.stopVariant(id, now, `page errors at ${(rv / rc).toFixed(1)}x the original`);
          continue;
        }
      }

      if (v.lcpN >= g.minLcpSamples && c.lcpN >= g.minLcpSamples) {
        const mv = v.lcpSum / v.lcpN;
        const mc = c.lcpSum / c.lcpN;
        const diff = mv - mc;
        if (diff > g.lcpDeltaMs) {
          const varV = Math.max(v.lcpSumSq / v.lcpN - mv * mv, 0) * (v.lcpN / (v.lcpN - 1));
          const varC = Math.max(c.lcpSumSq / c.lcpN - mc * mc, 0) * (c.lcpN / (c.lcpN - 1));
          const se = Math.sqrt(varV / v.lcpN + varC / c.lcpN);
          if (se > 0 && diff / se > 2.33) {
            this.stopVariant(id, now, `page speed ${Math.round(diff)} ms slower than the original`);
            continue;
          }
        }
      }

      const vMatured = v.total.s + v.total.f;
      if (vMatured >= g.minMatured && cMatured >= g.minMatured) {
        if (probWorse(this.arm(this.controlId), this.arm(id), this.rng, 2000) >= g.worseProb) {
          this.stopVariant(id, now, 'worse than the original on the goal, with high confidence');
        }
      }
    }
  }

  private checkDataHealth(now: number): void {
    let reason: string | null = null;

    const fixed = this.stage === 'canary' || this.stage === 'warmup' || this.stage === 'confirm';
    if (fixed && this.liveKey() === this.phaseLiveKey) {
      const tally = this.m.phases[this.phase].tally;
      const ids = this.order.filter((id) => (this.phaseWeights[id] ?? 0) > 0);
      const total = ids.reduce((a, id) => a + tally[id], 0);
      const expected = ids.map((id) => total * this.phaseWeights[id]);
      if (ids.length >= 2 && expected.every((e) => e >= 5) && srmFlagged(ids.map((id) => tally[id]), expected)) {
        reason = 'visitor split does not match the intended split';
      }
    }

    const day = Math.floor(now / DAY) - 1;
    const yesterday = this.m.dayViews[day] ?? 0;
    let sum = 0;
    let k = 0;
    for (let d = day - 7; d < day; d++) {
      const x = this.m.dayViews[d];
      if (x !== undefined) {
        sum += x;
        k++;
      }
    }
    if (reason === null && k >= 3 && yesterday < this.cfg.guardrails.volumeDropRatio * (sum / k)) {
      reason = 'event volume dropped by more than half';
    }

    if (reason !== this.frozen) {
      this.frozen = reason;
      this.log(now, 'engine', reason ? 'data_health_freeze' : 'data_health_clear', undefined, reason ?? 'data looks normal again');
    }
  }

  // ---------------------------------------------------------------- internals: stages

  private enter(stage: Stage, now: number, reason: string): void {
    this.stage = stage;
    this.stageStartedAt = now;
    this.phase++;
    fillMeasurements(this.m, this.order, this.phase + 1);
    this.markPending = true;
    this.log(now, 'engine', `stage_${stage}`, undefined, reason);
  }

  private advanceStage(now: number): void {
    for (let i = 0; i < 4; i++) if (!this.step(now)) break;
  }

  private step(now: number): boolean {
    const cfg = this.cfg;
    const elapsed = now - this.stageStartedAt;
    const challengers = this.liveChallengerIds();

    switch (this.stage) {
      case 'canary': {
        if (challengers.length === 0) return this.stopExperiment(now, 'all_challengers_stopped');
        if (elapsed < cfg.canaryMinDays * DAY) return false;
        const pc = this.m.phases[this.phase].counts;
        if (challengers.every((id) => pc[id].n >= cfg.canaryMinExposures)) {
          this.enter('warmup', now, 'no guardrail fired in the canary');
          return true;
        }
        return false;
      }

      case 'warmup': {
        if (challengers.length === 0) return this.stopExperiment(now, 'all_challengers_stopped');
        if (elapsed < cfg.warmupMinDays * DAY) return false;
        const live = [this.controlId, ...challengers];
        const pc = this.m.phases[this.phase].counts;
        if (!live.every((id) => pc[id].n >= cfg.warmupMinExposures)) return false;

        const lateShare = this.m.lagN >= 30 ? this.m.lagLate / this.m.lagN : 0;
        const slow = cfg.requireUnbiased || lateShare >= cfg.slowGoalShare;
        if (!slow) {
          this.enter('bandit', now, 'goal is quick enough to learn from live results');
          return true;
        }
        const enough = live.every((id) => {
          const t = this.m.variants[id].total;
          return t.s + t.f >= cfg.slowPickMinMatured;
        });
        if (!enough) return false;
        const pb = probBest(this.arms(challengers), this.rng, cfg.draws);
        const leader = challengers.reduce((a, b) => (pb[b] > pb[a] ? b : a));
        const why = cfg.requireUnbiased
          ? 'owner asked for an unbiased number'
          : `${Math.round(lateShare * 100)}% of conversions arrive later than ${cfg.lagThresholdDays} day(s)`;
        this.startConfirm(now, leader, challengers, `bandit skipped: ${why}`);
        return true;
      }

      case 'bandit': {
        const live = this.liveIds();
        if (this.liveChallengerIds().length === 0) return this.stopExperiment(now, 'all_challengers_stopped');
        const pb = probBest(this.arms(live), this.rng, cfg.draws);
        const leader = live.reduce((a, b) => (pb[b] > pb[a] ? b : a));
        const capped = elapsed >= cfg.banditMaxDays * DAY;
        if (elapsed < cfg.banditMinDays * DAY) return false;
        if (pb[leader] < cfg.banditStopProb && !capped) return false;
        if (leader === this.controlId) {
          this.log(now, 'engine', 'bandit_result', undefined, `original is the likely best (${Math.round(pb[leader] * 100)}%)`);
          return this.stopExperiment(now, 'control_best');
        }
        for (const id of challengers) {
          if (id !== leader && pb[id] < cfg.retireProb) {
            const v = this.vstate[id];
            v.status = 'retired';
            v.reason = `only ${(pb[id] * 100).toFixed(1)}% chance of being best`;
            this.log(now, 'engine', 'retired', id, v.reason);
          }
        }
        this.startConfirm(now, leader, this.liveChallengerIds(), `bandit leader ${leader} at ${Math.round(pb[leader] * 100)}% chance of being best`);
        return true;
      }

      case 'confirm': {
        const leaderId = this.confirmLeaderId as string;
        if (this.vstate[leaderId].status !== 'live') return this.stopExperiment(now, 'leader_rolled_back');
        const pc = this.m.phases[this.phase].counts;
        const c = pc[this.controlId];
        const l = pc[leaderId];
        const N = this.confirmN;
        if (c.s + c.f >= N && l.s + l.f >= N) {
          const t = twoProportionTest(c.s, N, l.s, N);
          const out: Outcome = { kind: 'stopped', reason: 'not_confirmed', relLift: t.relLift, ci: t.ci, p: t.p, perArm: N };
          if (t.z > 0 && t.p < cfg.confirm.alpha) {
            this.winnerId = leaderId;
            this.outcome = { ...out, kind: 'promoted', reason: 'confirmed', winnerId: leaderId };
            this.enter('promoted', now, `${leaderId} confirmed: lift ${(100 * (t.relLift ?? 0)).toFixed(1)}%, p = ${t.p.toFixed(4)}`);
            return true;
          }
          this.outcome = out;
          this.enter('stopped', now, `${leaderId} not confirmed: lift ${(100 * (t.relLift ?? 0)).toFixed(1)}%, p = ${t.p.toFixed(3)}. Original stays.`);
          return true;
        }
        if (elapsed > cfg.confirm.maxDays * DAY && (c.n < N || l.n < N)) return this.stopExperiment(now, 'confirm_underpowered');
        return false;
      }

      default:
        return false;
    }
  }

  private startConfirm(now: number, leaderId: string, challengers: string[], why: string): void {
    for (const id of challengers) {
      if (id !== leaderId) {
        const v = this.vstate[id];
        v.status = 'retired';
        v.reason = 'not the leader going into the confirm test';
        this.log(now, 'engine', 'retired', id, v.reason);
      }
    }
    const c = this.m.variants[this.controlId].total;
    const matured = c.s + c.f;
    const measured = matured >= 200 ? c.s / matured : this.cfg.confirm.fallbackBaseline;
    const baseline = Math.min(Math.max(measured, 0.002), 0.5);
    this.confirmLeaderId = leaderId;
    this.confirmN = Math.max(this.cfg.confirm.minPerArm, plannedPerArm(baseline, this.cfg.confirm.relMde, this.cfg.confirm.alpha, this.cfg.confirm.power));
    this.enter('confirm', now, `${why}. Fixed 50/50 test: ${leaderId} against the original, ${this.confirmN} visitors each`);
    this.confirmPhase = this.phase;
  }

  private stopExperiment(now: number, reason: string): boolean {
    this.outcome = this.outcome ?? { kind: 'stopped', reason };
    this.enter('stopped', now, reason);
    return true;
  }

  private recomputeWeights(): void {
    const live = this.liveIds();
    const next: Weights = {};
    for (const id of this.order) next[id] = 0;

    switch (this.stage) {
      case 'canary': {
        const ch = live.filter((id) => id !== this.controlId);
        const f = Math.min(this.cfg.canaryShare, 1 / (ch.length + 1));
        for (const id of ch) next[id] = f;
        next[this.controlId] = 1 - ch.length * f;
        break;
      }
      case 'warmup':
        Object.assign(next, equalWeights(live));
        break;
      case 'bandit': {
        if (this.frozen) {
          const prevSum = live.reduce((a, id) => a + (this.weights[id] ?? 0), 0);
          if (prevSum > 0) for (const id of live) next[id] = (this.weights[id] ?? 0) / prevSum;
          else Object.assign(next, equalWeights(live));
        } else {
          Object.assign(next, thompsonWeights(this.arms(live), this.rng, this.cfg.floor, this.cfg.draws));
        }
        break;
      }
      case 'confirm':
        next[this.controlId] = 0.5;
        next[this.confirmLeaderId as string] = 0.5;
        break;
      case 'promoted':
        next[this.winnerId as string] = 1;
        break;
      case 'stopped':
        next[this.controlId] = 1;
        break;
    }
    this.weights = next;
  }
}
