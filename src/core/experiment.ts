import { hashUnit } from './rng.ts';
import type { Rng } from './rng.ts';
import { equalWeights, pickByWeight, probBest, probWorse, thompsonWeights } from './thompson.ts';
import type { Arm, Weights } from './thompson.ts';
import { plannedPerArm, srmFlagged, twoProportionTest } from './stats.ts';
import { DAY } from './types.ts';
import type { AuditEntry, Config, Counts, Stage, VariantStatus } from './types.ts';

interface VariantState {
  id: string;
  isControl: boolean;
  status: VariantStatus;
  reason: string | null;
  /** All visitors ever shown this variant. s and f only count visitors whose window has closed. */
  total: Counts;
  views: number;
  errors: number;
  lcpN: number;
  lcpSum: number;
  lcpSumSq: number;
}

interface Visitor {
  variantId: string;
  at: number;
  phase: number;
  /** False for visitors beyond the planned size of the confirm test. They are shown a variant but not analysed. */
  counted: boolean;
  convertedAt: number | null;
}

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
 * One experiment on one place on a page: the original against a few challengers.
 *
 * Rules the caller must follow:
 * - Times are numbers in milliseconds and must not go backwards between calls.
 * - Call `tick(now)` regularly (every few minutes in production). It does all the thinking.
 * - `assign` is cheap and never waits on `tick`: it reads weights that `tick` already wrote.
 */
export class Experiment {
  readonly cfg: Config;
  readonly controlId: string;
  readonly order: string[];
  readonly audit: AuditEntry[] = [];

  stage: Stage = 'canary';
  stageStartedAt: number;
  phase = 0;
  weights: Weights = {};
  killed = false;
  /** Set when data looks wrong. While set, weights and stages do not move. */
  frozen: string | null = null;
  winnerId: string | null = null;
  outcome: Outcome | null = null;
  confirmLeaderId: string | null = null;
  confirmN = 0;

  private rng: Rng;
  private variants = new Map<string, VariantState>();
  private visitors = new Map<string, Visitor>();
  private exposures: Visitor[] = [];
  private expiryPtr = 0;
  private phaseCounts: Array<Record<string, Counts>> = [];
  private phaseTally: Array<Record<string, number>> = [];
  private phaseWeights: Weights = {};
  private phaseLiveKey = '';
  private markPending = false;
  private lagN = 0;
  private lagLate = 0;
  private dayViews = new Map<number, number>();

  constructor(cfg: Config, controlId: string, challengerIds: string[], rng: Rng, startAt: number) {
    this.cfg = cfg;
    this.controlId = controlId;
    this.rng = rng;
    this.order = [controlId, ...challengerIds];
    for (const id of this.order) {
      this.variants.set(id, {
        id,
        isControl: id === controlId,
        status: 'live',
        reason: null,
        total: { n: 0, s: 0, f: 0 },
        views: 0,
        errors: 0,
        lcpN: 0,
        lcpSum: 0,
        lcpSumSq: 0,
      });
    }
    this.stageStartedAt = startAt;
    this.ensurePhase(0);
    this.log(startAt, 'engine', 'experiment_started', undefined, `canary: ${challengerIds.length} challenger(s), each on ${(cfg.canaryShare * 100).toFixed(0)}% of visitors`);
    this.recomputeWeights();
    this.markPhaseWeights();
  }

  // ---------------------------------------------------------------- visitor-facing

  /** Which variant this visitor sees. The same visitor always gets the same answer while that variant stays live. */
  assign(visitorId: string, now: number): string {
    if (this.killed) return this.controlId;
    const existing = this.visitors.get(visitorId);
    if (existing) return this.shown(existing.variantId);
    if (this.stage === 'promoted') return this.winnerId as string;
    if (this.stage === 'stopped') return this.controlId;

    const u = hashUnit(`${this.cfg.id}|${visitorId}`);
    const variantId = pickByWeight(u, this.order, this.weights);
    const pc = this.phaseCounts[this.phase];
    const counted = this.stage === 'confirm' ? pc[variantId].n < this.confirmN : true;
    const rec: Visitor = { variantId, at: now, phase: this.phase, counted, convertedAt: null };
    this.visitors.set(visitorId, rec);
    this.exposures.push(rec);
    this.variants.get(variantId)!.total.n++;
    this.phaseTally[this.phase][variantId]++;
    if (counted) pc[variantId].n++;
    return variantId;
  }

  /** A page view with its health numbers. Feeds the error-rate and speed guardrails. */
  recordView(visitorId: string, now: number, health: { error?: boolean; lcpMs?: number } = {}): void {
    if (this.killed) return;
    const rec = this.visitors.get(visitorId);
    if (!rec) return;
    const v = this.variants.get(this.shown(rec.variantId))!;
    v.views++;
    if (health.error) v.errors++;
    if (health.lcpMs !== undefined) {
      v.lcpN++;
      v.lcpSum += health.lcpMs;
      v.lcpSumSq += health.lcpMs * health.lcpMs;
    }
    const day = Math.floor(now / DAY);
    this.dayViews.set(day, (this.dayViews.get(day) ?? 0) + 1);
  }

  /** The goal happened for this visitor. Counts once, and only inside the window. */
  recordGoal(visitorId: string, now: number): void {
    if (this.killed) return;
    const rec = this.visitors.get(visitorId);
    if (!rec || rec.convertedAt !== null) return;
    if (now - rec.at > this.cfg.windowDays * DAY) return;
    rec.convertedAt = now;
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

  /** The engine's thinking step. */
  tick(now: number): void {
    this.advanceExpiry(now);
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
        const v = this.variants.get(id)!;
        const finished = v.total.s + v.total.f;
        return {
          id,
          status: v.status,
          reason: v.reason,
          shown: v.total.n,
          finished,
          converted: v.total.s,
          rate: finished > 0 ? v.total.s / finished : null,
        };
      }),
      outcome: this.outcome,
    };
  }

  /** Matured counts for one variant. Exposed for the simulator and for reporting. */
  counts(id: string): Counts {
    return { ...this.variants.get(id)!.total };
  }

  status(id: string): VariantStatus {
    return this.variants.get(id)!.status;
  }

  // ---------------------------------------------------------------- internals: bookkeeping

  private log(at: number, actor: AuditEntry['actor'], action: string, variantId: string | undefined, reason: string): void {
    this.audit.push({ at, actor, action, variantId, reason });
  }

  private shown(variantId: string): string {
    if (this.stage === 'promoted') return this.winnerId as string;
    if (this.stage === 'stopped') return this.controlId;
    return this.variants.get(variantId)!.status === 'live' ? variantId : this.controlId;
  }

  private ensurePhase(p: number): void {
    const counts: Record<string, Counts> = {};
    const tally: Record<string, number> = {};
    for (const id of this.order) {
      counts[id] = { n: 0, s: 0, f: 0 };
      tally[id] = 0;
    }
    this.phaseCounts[p] = counts;
    this.phaseTally[p] = tally;
  }

  private liveIds(): string[] {
    return this.order.filter((id) => id === this.controlId || this.variants.get(id)!.status === 'live');
  }

  private liveChallengerIds(): string[] {
    return this.liveIds().filter((id) => id !== this.controlId);
  }

  private liveKey(): string {
    return this.liveIds().join(',');
  }

  private arm(id: string): Arm {
    const t = this.variants.get(id)!.total;
    return { id, alpha: 1 + t.s, beta: 1 + t.f };
  }

  private arms(ids: string[]): Arm[] {
    return ids.map((id) => this.arm(id));
  }

  private markPhaseWeights(): void {
    this.phaseWeights = { ...this.weights };
    this.phaseLiveKey = this.liveKey();
  }

  /**
   * Visitors only count once their window has closed, as a success if they converted inside it and a failure if not.
   * Counting early successes right away would inflate any variant that recently got more traffic.
   */
  private advanceExpiry(now: number): void {
    const win = this.cfg.windowDays * DAY;
    const lagLimit = this.cfg.lagThresholdDays * DAY;
    while (this.expiryPtr < this.exposures.length) {
      const r = this.exposures[this.expiryPtr];
      if (r.at + win > now) break;
      const t = this.variants.get(r.variantId)!.total;
      const converted = r.convertedAt !== null;
      if (converted) {
        t.s++;
        this.lagN++;
        if ((r.convertedAt as number) - r.at > lagLimit) this.lagLate++;
      } else {
        t.f++;
      }
      if (r.counted) {
        const c = this.phaseCounts[r.phase][r.variantId];
        if (converted) c.s++;
        else c.f++;
      }
      this.expiryPtr++;
    }
  }

  // ---------------------------------------------------------------- internals: guardrails and data health

  private stopVariant(v: VariantState, now: number, reason: string): void {
    v.status = this.stage === 'canary' ? 'stopped' : 'rolled_back';
    v.reason = reason;
    this.log(now, 'engine', v.status, v.id, reason);
  }

  private checkGuardrails(now: number): void {
    const g = this.cfg.guardrails;
    const c = this.variants.get(this.controlId)!;
    const cMatured = c.total.s + c.total.f;
    for (const id of this.order) {
      if (id === this.controlId) continue;
      const v = this.variants.get(id)!;
      if (v.status !== 'live') continue;

      if (v.views >= g.minViews && c.views >= g.minViews && v.errors >= g.minErrors) {
        const rv = v.errors / v.views;
        const rc = Math.max(c.errors, 0.5) / c.views;
        const pool = (v.errors + c.errors) / (v.views + c.views);
        const se = Math.sqrt(pool * (1 - pool) * (1 / v.views + 1 / c.views));
        const z = se > 0 ? (rv - rc) / se : 0;
        if (rv > g.errorRatio * rc && z > 2.33) {
          this.stopVariant(v, now, `page errors at ${(rv / rc).toFixed(1)}x the original`);
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
            this.stopVariant(v, now, `page speed ${Math.round(diff)} ms slower than the original`);
            continue;
          }
        }
      }

      const vMatured = v.total.s + v.total.f;
      if (vMatured >= g.minMatured && cMatured >= g.minMatured) {
        if (probWorse(this.arm(this.controlId), this.arm(id), this.rng, 2000) >= g.worseProb) {
          this.stopVariant(v, now, 'worse than the original on the goal, with high confidence');
        }
      }
    }
  }

  private checkDataHealth(now: number): void {
    let reason: string | null = null;

    const fixed = this.stage === 'canary' || this.stage === 'warmup' || this.stage === 'confirm';
    if (fixed && this.liveKey() === this.phaseLiveKey) {
      const tally = this.phaseTally[this.phase];
      const ids = this.order.filter((id) => (this.phaseWeights[id] ?? 0) > 0);
      const total = ids.reduce((a, id) => a + tally[id], 0);
      const expected = ids.map((id) => total * this.phaseWeights[id]);
      if (ids.length >= 2 && expected.every((e) => e >= 5) && srmFlagged(ids.map((id) => tally[id]), expected)) {
        reason = 'visitor split does not match the intended split';
      }
    }

    const day = Math.floor(now / DAY) - 1;
    const yesterday = this.dayViews.get(day) ?? 0;
    let sum = 0;
    let k = 0;
    for (let d = day - 7; d < day; d++) {
      const x = this.dayViews.get(d);
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
    this.ensurePhase(this.phase);
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
        const pc = this.phaseCounts[this.phase];
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
        const pc = this.phaseCounts[this.phase];
        if (!live.every((id) => pc[id].n >= cfg.warmupMinExposures)) return false;

        const lateShare = this.lagN >= 30 ? this.lagLate / this.lagN : 0;
        const slow = cfg.requireUnbiased || lateShare >= cfg.slowGoalShare;
        if (!slow) {
          this.enter('bandit', now, 'goal is quick enough to learn from live results');
          return true;
        }
        const enough = live.every((id) => {
          const t = this.variants.get(id)!.total;
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
            const v = this.variants.get(id)!;
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
        if (this.variants.get(leaderId)!.status !== 'live') return this.stopExperiment(now, 'leader_rolled_back');
        const pc = this.phaseCounts[this.phase];
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
        const v = this.variants.get(id)!;
        v.status = 'retired';
        v.reason = 'not the leader going into the confirm test';
        this.log(now, 'engine', 'retired', id, v.reason);
      }
    }
    const c = this.variants.get(this.controlId)!.total;
    const matured = c.s + c.f;
    const measured = matured >= 200 ? c.s / matured : this.cfg.confirm.fallbackBaseline;
    const baseline = Math.min(Math.max(measured, 0.002), 0.5);
    this.confirmLeaderId = leaderId;
    this.confirmN = Math.max(this.cfg.confirm.minPerArm, plannedPerArm(baseline, this.cfg.confirm.relMde, this.cfg.confirm.alpha, this.cfg.confirm.power));
    this.enter('confirm', now, `${why}. Fixed 50/50 test: ${leaderId} against the original, ${this.confirmN} visitors each`);
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
