import { emptyMeasurements, fillMeasurements } from '../core/engine.ts';
import type { EngineState, Measurements } from '../core/engine.ts';
import { DAY } from '../core/types.ts';
import type { AuditEntry } from '../core/types.ts';
import { DuplicateExperimentError } from './store.ts';
import type { Health, MeasureSpec, Progress, Store, VisitorRow } from './store.ts';
import { isFinished } from './types.ts';
import type { ExperimentDef, ExperimentRow } from './types.ts';

/**
 * The only thing the store needs from a Postgres driver.
 * `pg`, `@neondatabase/serverless` and the small driver used in the tests all fit behind this.
 * Every call is ONE statement: the HTTP driver cannot run several in a row on one connection.
 */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

type Row = Record<string, unknown>;

/** Postgres bigint comes back as a string from most drivers. */
const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x));
const json = <T>(x: unknown): T => (typeof x === 'string' ? (JSON.parse(x) as T) : (x as T));

function auditParam(entries: AuditEntry[]): string {
  return JSON.stringify(entries.map((a) => ({ at: a.at, actor: a.actor, action: a.action, variant_id: a.variantId ?? null, reason: a.reason })));
}

// Rows of audit entries, passed as one JSON text, in order.
const AUDIT_ROWS = `ROWS FROM (jsonb_to_recordset($ARG::jsonb) AS (at bigint, actor text, action text, variant_id text, reason text)) WITH ORDINALITY AS a(at, actor, action, variant_id, reason, ord)`;
const auditRows = (n: number) => AUDIT_ROWS.replace('$ARG', `$${n}`);

export class PgStore implements Store {
  private sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  private async rows(text: string, params: unknown[]): Promise<Row[]> {
    return (await this.sql.query(text, params)).rows;
  }

  async createExperiment(def: ExperimentDef, state: EngineState, audit: AuditEntry[], now: number): Promise<void> {
    try {
      await this.sql.query(
        `WITH e AS (
           INSERT INTO experiments (id, name, def, state, finished, created_at, ticked_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::boolean, $6::bigint, $6::bigint)
           RETURNING id
         )
         INSERT INTO audit (experiment_id, at, actor, action, variant_id, reason)
         SELECT e.id, a.at, a.actor, a.action, a.variant_id, a.reason FROM e, ${auditRows(7)} ORDER BY a.ord`,
        [def.id, def.name, JSON.stringify(def), JSON.stringify(state), isFinished(state), now, auditParam(audit)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new DuplicateExperimentError(def.id);
      throw err;
    }
  }

  async getExperiment(id: string): Promise<ExperimentRow | null> {
    const [r] = await this.rows('SELECT def, state, killed, created_at, ticked_at FROM experiments WHERE id = $1', [id]);
    if (!r) return null;
    return { def: json<ExperimentDef>(r.def), state: json<EngineState>(r.state), killed: r.killed === true, createdAt: num(r.created_at), tickedAt: num(r.ticked_at) };
  }

  async listActive(): Promise<string[]> {
    return (await this.rows('SELECT id FROM experiments WHERE finished = false ORDER BY created_at, id', [])).map((r) => String(r.id));
  }

  async listAll() {
    const rows = await this.rows("SELECT id, name, state->>'stage' AS stage, killed, created_at FROM experiments ORDER BY created_at, id", []);
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), stage: String(r.stage), killed: r.killed === true, createdAt: num(r.created_at) }));
  }

  async upsertVisitor(experimentId: string, visitorId: string, variantId: string, phase: number, now: number) {
    const query = `WITH ins AS (
         INSERT INTO visitors (experiment_id, visitor_id, variant_id, phase, assigned_at)
         VALUES ($1, $2, $3, $4::integer, $5::bigint)
         ON CONFLICT (experiment_id, visitor_id) DO NOTHING
         RETURNING variant_id, phase, assigned_at, converted_at
       )
       SELECT variant_id, phase, assigned_at, converted_at, true AS created FROM ins
       UNION ALL
       SELECT v.variant_id, v.phase, v.assigned_at, v.converted_at, false
         FROM visitors v
        WHERE v.experiment_id = $1 AND v.visitor_id = $2 AND NOT EXISTS (SELECT 1 FROM ins)`;
    let [r] = await this.rows(query, [experimentId, visitorId, variantId, phase, now]);
    if (!r) {
      // Someone else stored this visitor a moment ago and our statement could not see it yet. Read it now.
      const again = await this.getVisitor(experimentId, visitorId);
      if (!again) throw new Error('visitor vanished');
      return { row: again, created: false };
    }
    return { row: visitorFrom(r), created: r.created === true };
  }

  async getVisitor(experimentId: string, visitorId: string): Promise<VisitorRow | null> {
    const [r] = await this.rows('SELECT variant_id, phase, assigned_at, converted_at FROM visitors WHERE experiment_id = $1 AND visitor_id = $2', [experimentId, visitorId]);
    return r ? visitorFrom(r) : null;
  }

  async recordGoal(experimentId: string, visitorId: string, now: number, windowMs: number): Promise<boolean> {
    const r = await this.rows(
      `UPDATE visitors SET converted_at = $3::bigint
        WHERE experiment_id = $1 AND visitor_id = $2 AND converted_at IS NULL AND $3::bigint - assigned_at <= $4::bigint
        RETURNING 1 AS ok`,
      [experimentId, visitorId, now, windowMs],
    );
    return r.length > 0;
  }

  async recordHealth(experimentId: string, variantId: string, now: number, h: Health): Promise<void> {
    const lcp = h.lcpMs;
    await this.sql.query(
      `WITH hl AS (
         INSERT INTO health (experiment_id, variant_id, views, errors, lcp_n, lcp_sum, lcp_sumsq)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6::double precision, $7::double precision)
         ON CONFLICT (experiment_id, variant_id) DO UPDATE SET
           views = health.views + EXCLUDED.views,
           errors = health.errors + EXCLUDED.errors,
           lcp_n = health.lcp_n + EXCLUDED.lcp_n,
           lcp_sum = health.lcp_sum + EXCLUDED.lcp_sum,
           lcp_sumsq = health.lcp_sumsq + EXCLUDED.lcp_sumsq
         RETURNING 1
       )
       INSERT INTO day_views (experiment_id, day, views)
       SELECT $1, $8::integer, 1 WHERE $3::bigint > 0
       ON CONFLICT (experiment_id, day) DO UPDATE SET views = day_views.views + 1`,
      [experimentId, variantId, h.view ? 1 : 0, h.error ? 1 : 0, lcp === undefined ? 0 : 1, lcp ?? 0, lcp === undefined ? 0 : lcp * lcp, Math.floor(now / DAY)],
    );
  }

  async setKilled(experimentId: string, killed: boolean, entry: AuditEntry): Promise<boolean> {
    const [r] = await this.rows(
      `WITH upd AS (
         UPDATE experiments SET killed = $2::boolean WHERE id = $1 AND killed IS DISTINCT FROM $2::boolean RETURNING id
       ), ins AS (
         INSERT INTO audit (experiment_id, at, actor, action, variant_id, reason)
         SELECT upd.id, $3::bigint, $4, $5, NULL, $6 FROM upd
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM upd)::integer AS changed`,
      [experimentId, killed, entry.at, entry.actor, entry.action, entry.reason],
    );
    return num(r.changed) > 0;
  }

  async measure(experimentId: string, spec: MeasureSpec): Promise<Measurements> {
    const [r] = await this.rows(
      `WITH base AS (
         SELECT phase, variant_id, assigned_at, converted_at, true AS counted
           FROM visitors WHERE experiment_id = $1 AND phase IS DISTINCT FROM $2::integer
         UNION ALL
         SELECT phase, variant_id, assigned_at, converted_at, rn <= $3::integer
           FROM (SELECT phase, variant_id, assigned_at, converted_at,
                        row_number() OVER (PARTITION BY variant_id ORDER BY seq) AS rn
                   FROM visitors WHERE experiment_id = $1 AND phase = $2::integer) c
       ), flagged AS (
         SELECT phase, variant_id, counted, assigned_at, converted_at,
                (assigned_at <= $4::bigint) AS settled,
                (converted_at IS NOT NULL) AS converted
           FROM base
       ), agg AS (
         SELECT phase, variant_id,
                count(*)::integer AS assigned,
                (count(*) FILTER (WHERE counted))::integer AS counted_n,
                (count(*) FILTER (WHERE counted AND settled AND converted))::integer AS counted_s,
                (count(*) FILTER (WHERE counted AND settled AND NOT converted))::integer AS counted_f,
                (count(*) FILTER (WHERE settled AND converted))::integer AS s,
                (count(*) FILTER (WHERE settled AND NOT converted))::integer AS f,
                (count(*) FILTER (WHERE settled AND converted AND converted_at - assigned_at > $5::bigint))::integer AS late
           FROM flagged GROUP BY phase, variant_id
       )
       SELECT
         (SELECT coalesce(json_agg(agg), '[]'::json) FROM agg) AS visitors,
         (SELECT coalesce(json_agg(h), '[]'::json)
            FROM (SELECT variant_id, views, errors, lcp_n, lcp_sum, lcp_sumsq FROM health WHERE experiment_id = $1) h) AS health,
         (SELECT coalesce(json_agg(d), '[]'::json)
            FROM (SELECT day, views FROM day_views WHERE experiment_id = $1 AND day >= $6::integer) d) AS days`,
      [experimentId, spec.confirmPhase, spec.confirmN, spec.now - spec.windowMs, spec.lagMs, Math.floor(spec.now / DAY) - 8],
    );

    const m = emptyMeasurements(spec.order, spec.phase + 1);
    for (const v of json<Row[]>(r.visitors)) {
      const phase = num(v.phase);
      const id = String(v.variant_id);
      if (phase >= m.phases.length) fillMeasurements(m, spec.order, phase + 1);
      const t = m.variants[id].total;
      t.n += num(v.assigned);
      t.s += num(v.s);
      t.f += num(v.f);
      m.lagN += num(v.s);
      m.lagLate += num(v.late);
      m.phases[phase].tally[id] += num(v.assigned);
      const c = m.phases[phase].counts[id];
      c.n += num(v.counted_n);
      c.s += num(v.counted_s);
      c.f += num(v.counted_f);
    }
    for (const h of json<Row[]>(r.health)) {
      const id = String(h.variant_id);
      if (!m.variants[id]) continue;
      Object.assign(m.variants[id], { views: num(h.views), errors: num(h.errors), lcpN: num(h.lcp_n), lcpSum: num(h.lcp_sum), lcpSumSq: num(h.lcp_sumsq) });
    }
    for (const d of json<Row[]>(r.days)) m.dayViews[num(d.day)] = num(d.views);
    return m;
  }

  async progress(experimentId: string): Promise<Record<string, Progress>> {
    const [r] = await this.rows(
      `SELECT
         (SELECT coalesce(json_agg(v), '[]'::json)
            FROM (SELECT variant_id, count(*)::integer AS visitors, count(converted_at)::integer AS converted
                    FROM visitors WHERE experiment_id = $1 GROUP BY variant_id) v) AS visitors,
         (SELECT coalesce(json_agg(h), '[]'::json)
            FROM (SELECT variant_id, views, errors, lcp_n, lcp_sum FROM health WHERE experiment_id = $1) h) AS health`,
      [experimentId],
    );
    const out: Record<string, Progress> = {};
    const get = (id: string) => (out[id] ??= { visitors: 0, converted: 0, views: 0, errors: 0, avgLcpMs: null });
    for (const v of json<Row[]>(r.visitors)) Object.assign(get(String(v.variant_id)), { visitors: num(v.visitors), converted: num(v.converted) });
    for (const h of json<Row[]>(r.health)) {
      const p = get(String(h.variant_id));
      p.views = num(h.views);
      p.errors = num(h.errors);
      p.avgLcpMs = num(h.lcp_n) > 0 ? num(h.lcp_sum) / num(h.lcp_n) : null;
    }
    return out;
  }

  async claimTick(experimentId: string, token: string, now: number, leaseMs: number): Promise<boolean> {
    const r = await this.rows(
      `UPDATE experiments SET lease_token = $2, lease_until = $3::bigint + $4::bigint
        WHERE id = $1 AND lease_until < $3::bigint
        RETURNING id`,
      [experimentId, token, now, leaseMs],
    );
    return r.length > 0;
  }

  async saveTick(experimentId: string, token: string, state: EngineState, audit: AuditEntry[], now: number): Promise<boolean> {
    const [r] = await this.rows(
      `WITH upd AS (
         UPDATE experiments
            SET state = $3::jsonb, finished = $4::boolean, ticked_at = $5::bigint, lease_token = NULL, lease_until = 0
          WHERE id = $1 AND lease_token = $2
          RETURNING id
       ), ins AS (
         INSERT INTO audit (experiment_id, at, actor, action, variant_id, reason)
         SELECT upd.id, a.at, a.actor, a.action, a.variant_id, a.reason FROM upd, ${auditRows(6)} ORDER BY a.ord
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM upd)::integer AS saved`,
      [experimentId, token, JSON.stringify(state), isFinished(state), now, auditParam(audit)],
    );
    return num(r.saved) > 0;
  }

  async readAudit(experimentId: string, limit = 200): Promise<AuditEntry[]> {
    const rows = await this.rows('SELECT at, actor, action, variant_id, reason FROM audit WHERE experiment_id = $1 ORDER BY id DESC LIMIT $2::integer', [experimentId, limit]);
    return rows
      .reverse()
      .map((a) => ({ at: num(a.at), actor: a.actor as AuditEntry['actor'], action: String(a.action), variantId: a.variant_id === null ? undefined : String(a.variant_id), reason: String(a.reason) }));
  }
}

function visitorFrom(r: Row): VisitorRow {
  return { variantId: String(r.variant_id), phase: num(r.phase), assignedAt: num(r.assigned_at), convertedAt: r.converted_at === null || r.converted_at === undefined ? null : num(r.converted_at) };
}
