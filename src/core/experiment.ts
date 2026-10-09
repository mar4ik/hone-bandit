import { Engine, decide } from './engine.ts';
import type { Outcome, Snapshot } from './engine.ts';
import type { Rng } from './rng.ts';
import { DAY } from './types.ts';
import type { Config } from './types.ts';

export type { Outcome, Snapshot };

export interface Visitor {
  variantId: string;
  at: number;
  phase: number;
  /** False for visitors beyond the planned size of the confirm test. They are shown a variant but not analysed. */
  counted: boolean;
  convertedAt: number | null;
}

/**
 * The engine plus an in-memory record of every visitor. Used by the simulator and the tests.
 * The server does the same bookkeeping in a database instead (see src/server).
 *
 * Rules the caller must follow:
 * - Times are numbers in milliseconds and must not go backwards between calls.
 * - Call `tick(now)` regularly (every few minutes in production). It does all the thinking.
 * - `assign` is cheap and never waits on `tick`: it reads weights that `tick` already wrote.
 */
export class Experiment extends Engine {
  private visitors = new Map<string, Visitor>();
  private exposures: Visitor[] = [];
  private expiryPtr = 0;

  constructor(cfg: Config, controlId: string, challengerIds: string[], rng: Rng, startAt: number) {
    super(cfg, controlId, challengerIds, rng, startAt);
  }

  /** Which variant this visitor sees. The same visitor always gets the same answer while that variant stays live. */
  assign(visitorId: string, now: number): string {
    const existing = this.visitors.get(visitorId);
    const d = decide(this, existing ? existing.variantId : null, visitorId);
    if (d.create === null) return d.shown;

    const variantId = d.create;
    const pc = this.m.phases[this.phase].counts[variantId];
    const counted = this.stage === 'confirm' ? pc.n < this.confirmN : true;
    const rec: Visitor = { variantId, at: now, phase: this.phase, counted, convertedAt: null };
    this.visitors.set(visitorId, rec);
    this.exposures.push(rec);
    this.m.variants[variantId].total.n++;
    this.m.phases[this.phase].tally[variantId]++;
    if (counted) pc.n++;
    return variantId;
  }

  /** A page view with its health numbers. Feeds the error-rate and speed guardrails. */
  recordView(visitorId: string, now: number, health: { error?: boolean; lcpMs?: number } = {}): void {
    if (this.killed) return;
    const rec = this.visitors.get(visitorId);
    if (!rec) return;
    const v = this.m.variants[this.shown(rec.variantId)];
    v.views++;
    if (health.error) v.errors++;
    if (health.lcpMs !== undefined) {
      v.lcpN++;
      v.lcpSum += health.lcpMs;
      v.lcpSumSq += health.lcpMs * health.lcpMs;
    }
    const day = Math.floor(now / DAY);
    this.m.dayViews[day] = (this.m.dayViews[day] ?? 0) + 1;
  }

  /** The goal happened for this visitor. Counts once, and only inside the window. */
  recordGoal(visitorId: string, now: number): void {
    if (this.killed) return;
    const rec = this.visitors.get(visitorId);
    if (!rec || rec.convertedAt !== null) return;
    if (now - rec.at > this.cfg.windowDays * DAY) return;
    rec.convertedAt = now;
  }

  /** Settle, then think. */
  tick(now: number): void {
    this.settle(now);
    this.think(now);
  }

  /**
   * Visitors only count once their window has closed, as a success if they converted inside it and a failure if not.
   * Counting early successes right away would inflate any variant that recently got more traffic.
   */
  settle(now: number): void {
    const win = this.cfg.windowDays * DAY;
    const lagLimit = this.cfg.lagThresholdDays * DAY;
    while (this.expiryPtr < this.exposures.length) {
      const r = this.exposures[this.expiryPtr];
      if (r.at + win > now) break;
      const t = this.m.variants[r.variantId].total;
      const converted = r.convertedAt !== null;
      if (converted) {
        t.s++;
        this.m.lagN++;
        if ((r.convertedAt as number) - r.at > lagLimit) this.m.lagLate++;
      } else {
        t.f++;
      }
      if (r.counted) {
        const c = this.m.phases[r.phase].counts[r.variantId];
        if (converted) c.s++;
        else c.f++;
      }
      this.expiryPtr++;
    }
  }

  /** Every visitor record in the order they arrived. For tests that compare this with the database. */
  records(): Array<Visitor & { visitorId: string }> {
    const ids = new Map<Visitor, string>();
    for (const [id, rec] of this.visitors) ids.set(rec, id);
    return this.exposures.map((r) => ({ ...r, visitorId: ids.get(r) as string }));
  }
}
