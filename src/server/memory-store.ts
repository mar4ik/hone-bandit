import { emptyMeasurements, fillMeasurements } from '../core/engine.ts';
import type { EngineState, Measurements } from '../core/engine.ts';
import { DAY } from '../core/types.ts';
import type { AuditEntry } from '../core/types.ts';
import { DuplicateExperimentError } from './store.ts';
import type { Health, MeasureSpec, Progress, Store, VisitorRow } from './store.ts';
import { isFinished } from './types.ts';
import type { ExperimentDef, ExperimentRow } from './types.ts';

interface Exp {
  def: ExperimentDef;
  state: EngineState;
  killed: boolean;
  createdAt: number;
  tickedAt: number;
  finished: boolean;
  leaseToken: string | null;
  leaseUntil: number;
  audit: AuditEntry[];
}

interface HealthAgg {
  views: number;
  errors: number;
  lcpN: number;
  lcpSum: number;
  lcpSumSq: number;
}

/** Keeps everything in memory. Same answers as the Postgres store, but nothing survives a restart. */
export class MemoryStore implements Store {
  private exps = new Map<string, Exp>();
  private visitors = new Map<string, Map<string, VisitorRow>>();
  private health = new Map<string, Map<string, HealthAgg>>();
  private days = new Map<string, Map<number, number>>();

  async createExperiment(def: ExperimentDef, state: EngineState, audit: AuditEntry[], now: number): Promise<void> {
    if (this.exps.has(def.id)) throw new DuplicateExperimentError(def.id);
    this.exps.set(def.id, {
      def: structuredClone(def),
      state: structuredClone(state),
      killed: false,
      createdAt: now,
      tickedAt: now,
      finished: isFinished(state),
      leaseToken: null,
      leaseUntil: 0,
      audit: structuredClone(audit),
    });
    this.visitors.set(def.id, new Map());
    this.health.set(def.id, new Map());
    this.days.set(def.id, new Map());
  }

  async getExperiment(id: string): Promise<ExperimentRow | null> {
    const e = this.exps.get(id);
    if (!e) return null;
    return structuredClone({ def: e.def, state: e.state, killed: e.killed, createdAt: e.createdAt, tickedAt: e.tickedAt });
  }

  async listActive(): Promise<string[]> {
    return [...this.exps.values()].filter((e) => !e.finished).sort((a, b) => a.createdAt - b.createdAt).map((e) => e.def.id);
  }

  async listAll() {
    return [...this.exps.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => ({ id: e.def.id, name: e.def.name, stage: e.state.stage as string, killed: e.killed, createdAt: e.createdAt }));
  }

  async upsertVisitor(experimentId: string, visitorId: string, variantId: string, phase: number, now: number) {
    const table = this.visitors.get(experimentId);
    if (!table) throw new Error(`unknown experiment ${experimentId}`);
    const existing = table.get(visitorId);
    if (existing) return { row: { ...existing }, created: false };
    const row: VisitorRow = { variantId, phase, assignedAt: now, convertedAt: null };
    table.set(visitorId, row);
    return { row: { ...row }, created: true };
  }

  async getVisitor(experimentId: string, visitorId: string): Promise<VisitorRow | null> {
    const row = this.visitors.get(experimentId)?.get(visitorId);
    return row ? { ...row } : null;
  }

  async recordGoal(experimentId: string, visitorId: string, now: number, windowMs: number): Promise<boolean> {
    const row = this.visitors.get(experimentId)?.get(visitorId);
    if (!row || row.convertedAt !== null || now - row.assignedAt > windowMs) return false;
    row.convertedAt = now;
    return true;
  }

  async recordHealth(experimentId: string, variantId: string, now: number, h: Health): Promise<void> {
    const byVariant = this.health.get(experimentId);
    if (!byVariant) throw new Error(`unknown experiment ${experimentId}`);
    const agg = byVariant.get(variantId) ?? { views: 0, errors: 0, lcpN: 0, lcpSum: 0, lcpSumSq: 0 };
    byVariant.set(variantId, agg);
    if (h.view) agg.views++;
    if (h.error) agg.errors++;
    if (h.lcpMs !== undefined) {
      agg.lcpN++;
      agg.lcpSum += h.lcpMs;
      agg.lcpSumSq += h.lcpMs * h.lcpMs;
    }
    if (h.view) {
      const days = this.days.get(experimentId) as Map<number, number>;
      const day = Math.floor(now / DAY);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
  }

  async setKilled(experimentId: string, killed: boolean, entry: AuditEntry): Promise<boolean> {
    const e = this.exps.get(experimentId);
    if (!e || e.killed === killed) return false;
    e.killed = killed;
    e.audit.push(structuredClone(entry));
    return true;
  }

  async measure(experimentId: string, spec: MeasureSpec): Promise<Measurements> {
    const table = this.visitors.get(experimentId);
    if (!table) throw new Error(`unknown experiment ${experimentId}`);
    const m = emptyMeasurements(spec.order, spec.phase + 1);
    const cutoff = spec.now - spec.windowMs;
    const rank = new Map<string, number>();

    // Map iteration follows insertion order, which is the order visitors arrived.
    for (const r of table.values()) {
      if (r.phase >= m.phases.length) fillMeasurements(m, spec.order, r.phase + 1);
      let counted = true;
      if (r.phase === spec.confirmPhase) {
        const k = (rank.get(r.variantId) ?? 0) + 1;
        rank.set(r.variantId, k);
        counted = k <= spec.confirmN;
      }
      const total = m.variants[r.variantId].total;
      const ph = m.phases[r.phase];
      total.n++;
      ph.tally[r.variantId]++;
      if (counted) ph.counts[r.variantId].n++;
      if (r.assignedAt <= cutoff) {
        const converted = r.convertedAt !== null;
        if (converted) {
          total.s++;
          m.lagN++;
          if ((r.convertedAt as number) - r.assignedAt > spec.lagMs) m.lagLate++;
        } else {
          total.f++;
        }
        if (counted) {
          if (converted) ph.counts[r.variantId].s++;
          else ph.counts[r.variantId].f++;
        }
      }
    }

    for (const [variantId, h] of this.health.get(experimentId) as Map<string, HealthAgg>) {
      if (!m.variants[variantId]) continue;
      Object.assign(m.variants[variantId], { views: h.views, errors: h.errors, lcpN: h.lcpN, lcpSum: h.lcpSum, lcpSumSq: h.lcpSumSq });
    }
    const firstDay = Math.floor(spec.now / DAY) - 8;
    for (const [day, views] of this.days.get(experimentId) as Map<number, number>) {
      if (day >= firstDay) m.dayViews[day] = views;
    }
    return m;
  }

  async progress(experimentId: string): Promise<Record<string, Progress>> {
    const out: Record<string, Progress> = {};
    const get = (id: string) => (out[id] ??= { visitors: 0, converted: 0, views: 0, errors: 0, avgLcpMs: null });
    for (const r of (this.visitors.get(experimentId) ?? new Map<string, VisitorRow>()).values()) {
      const p = get(r.variantId);
      p.visitors++;
      if (r.convertedAt !== null) p.converted++;
    }
    for (const [id, h] of this.health.get(experimentId) ?? new Map<string, HealthAgg>()) {
      const p = get(id);
      p.views = h.views;
      p.errors = h.errors;
      p.avgLcpMs = h.lcpN > 0 ? h.lcpSum / h.lcpN : null;
    }
    return out;
  }

  async claimTick(experimentId: string, token: string, now: number, leaseMs: number): Promise<boolean> {
    const e = this.exps.get(experimentId);
    if (!e || e.leaseUntil >= now) return false;
    e.leaseToken = token;
    e.leaseUntil = now + leaseMs;
    return true;
  }

  async saveTick(experimentId: string, token: string, state: EngineState, audit: AuditEntry[], now: number): Promise<boolean> {
    const e = this.exps.get(experimentId);
    if (!e || e.leaseToken !== token) return false;
    e.state = structuredClone(state);
    e.tickedAt = now;
    e.leaseToken = null;
    e.leaseUntil = 0;
    e.finished = isFinished(state);
    e.audit.push(...structuredClone(audit));
    return true;
  }

  async readAudit(experimentId: string, limit = 200): Promise<AuditEntry[]> {
    const e = this.exps.get(experimentId);
    return e ? structuredClone(e.audit.slice(-limit)) : [];
  }
}
