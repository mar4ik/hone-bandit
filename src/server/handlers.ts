import { Engine, chooseVariant, shownVariant, viewFromState } from '../core/engine.ts';
import { hash32, mulberry32 } from '../core/rng.ts';
import { DAY } from '../core/types.ts';
import type { AuditEntry } from '../core/types.ts';
import { KEY_RE, VISITOR_RE, bearerOk, cleanPath, corsFor, isBot, json, matchesPath, noContent, optedOut, preflight } from './http.ts';
import { validateNewExperiment } from './create.ts';
import { DuplicateExperimentError } from './store.ts';
import type { Store } from './store.ts';
import { loadEngine, runTick } from './tick.ts';
import { CONTROL_ID, fullOrder, isFinished } from './types.ts';
import type { DecideResponse, EventBody, ExperimentRow } from './types.ts';

export interface Ctx {
  store: Store;
  now: () => number;
  /** Secret for the admin endpoints. Unset means they are off. */
  adminToken?: string;
  /** Secret the scheduler sends to /api/cron/tick. Unset means that endpoint is off. */
  cronSecret?: string;
  /** Runs work after the response has gone out, where the platform allows it. */
  schedule?: (work: Promise<unknown>) => void;
  /** A busy site thinks for itself when the last tick is older than this. 0 turns it off. */
  tickEveryMs?: number;
}

const DEFAULT_TICK_EVERY = 5 * 60_000;

// ------------------------------------------------------------------ the public endpoints

/** GET /api/decide?e=<experiment>&v=<visitor>&p=<path> */
export async function handleDecide(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const e = url.searchParams.get('e') ?? '';
  const v = url.searchParams.get('v') ?? '';
  const path = cleanPath(url.searchParams.get('p'));
  if (!KEY_RE.test(e) || !VISITOR_RE.test(v) || path === null) return json(400, { error: 'bad_request' });

  const row = await ctx.store.getExperiment(e);
  if (!row) return json(404, { error: 'unknown_experiment' });
  const def = row.def;
  const cors = corsFor(req, def.allowedOrigins);
  if (!cors.ok) return json(403, { error: 'origin_not_allowed' }, cors.headers);

  const now = ctx.now();
  const onTarget = matchesPath(def.target, path);
  const reply = (r: Partial<DecideResponse>): Response =>
    json(200, { v: 1, variant: CONTROL_ID, assigned: false, target: onTarget, changes: [], track: false, goal: null, ...r } satisfies DecideResponse, cors.headers);
  const changesOf = (variantId: string) => (variantId === CONTROL_ID || !onTarget ? [] : def.variants[variantId].changes);

  // People who asked not to be tracked, bots and a pressed kill switch all see the original and leave no trace.
  if (row.killed || optedOut(req) || isBot(req)) return reply({});

  const state = row.state;
  if (state.stage === 'promoted') {
    const winner = state.winnerId as string;
    return reply({ variant: winner, changes: changesOf(winner) });
  }
  if (state.stage === 'stopped') return reply({});

  const view = viewFromState(def.id, fullOrder(def), state, false);
  let stored;
  if (onTarget) {
    const proposed = chooseVariant(view, v);
    stored = (await ctx.store.upsertVisitor(def.id, v, proposed, state.phase, now)).row;
  } else {
    stored = await ctx.store.getVisitor(def.id, v);
    if (!stored) return reply({ variant: null });
  }
  const shown = shownVariant(view, stored.variantId);

  const every = ctx.tickEveryMs ?? DEFAULT_TICK_EVERY;
  if (ctx.schedule && every > 0 && now - row.tickedAt > every) ctx.schedule(runTick(ctx.store, def.id, now).catch(() => 'busy'));

  return reply({ variant: shown, assigned: true, changes: changesOf(shown), track: true, goal: def.goal });
}

/** POST /api/event with a small JSON text body. Always answers 204 so the page learns nothing from it. */
export async function handleEvent(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const text = await req.text();
  if (text.length > 2048) return json(413, { error: 'too_large' });
  const body = parseEvent(text);
  if (!body) return json(400, { error: 'bad_request' });

  const row = await ctx.store.getExperiment(body.e);
  if (!row) return json(404, { error: 'unknown_experiment' });
  const def = row.def;
  const cors = corsFor(req, def.allowedOrigins);
  if (!cors.ok) return json(403, { error: 'origin_not_allowed' }, cors.headers);
  const ok = () => noContent(cors.headers);

  if (row.killed || isFinished(row.state) || optedOut(req) || isBot(req)) return ok();
  const now = ctx.now();

  if (body.t === 'goal') {
    if (def.goal.type === 'pageview' && !matchesPath({ path: def.goal.path }, body.p)) return ok();
    await ctx.store.recordGoal(def.id, body.v, now, def.config.windowDays * DAY);
    return ok();
  }

  if (!matchesPath(def.target, body.p)) return ok();
  const visitor = await ctx.store.getVisitor(def.id, body.v);
  if (!visitor) return ok();
  const view = viewFromState(def.id, fullOrder(def), row.state, false);
  const shown = shownVariant(view, visitor.variantId);
  if (body.t === 'view') await ctx.store.recordHealth(def.id, shown, now, { view: true, error: body.err === 1 });
  else await ctx.store.recordHealth(def.id, shown, now, { view: false, error: body.err === 1, lcpMs: body.lcp });
  return ok();
}

function parseEvent(text: string): EventBody | null {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null) return null;
  const b = x as Record<string, unknown>;
  const p = cleanPath(typeof b.p === 'string' ? b.p : null);
  if (typeof b.e !== 'string' || !KEY_RE.test(b.e) || typeof b.v !== 'string' || !VISITOR_RE.test(b.v) || p === null) return null;
  if (b.t !== 'view' && b.t !== 'health' && b.t !== 'goal') return null;
  if (b.err !== undefined && b.err !== 0 && b.err !== 1) return null;
  if (b.lcp !== undefined && (typeof b.lcp !== 'number' || !Number.isFinite(b.lcp) || b.lcp < 0 || b.lcp > 120_000)) return null;
  return { e: b.e, v: b.v, t: b.t, p, err: b.err as number | undefined, lcp: b.lcp as number | undefined };
}

export function handleOptions(): Response {
  return preflight();
}

// ------------------------------------------------------------------ the scheduler

/** GET or POST /api/cron/tick, with the cron secret as a bearer token. */
export async function handleTick(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.cronSecret) return json(503, { error: 'cron_not_configured' });
  if (!bearerOk(req, ctx.cronSecret)) return json(401, { error: 'unauthorized' });
  const now = ctx.now();
  const results: Record<string, string> = {};
  for (const id of await ctx.store.listActive()) {
    try {
      results[id] = await runTick(ctx.store, id, now);
    } catch (err) {
      results[id] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return json(200, { ok: true, at: now, results });
}

// ------------------------------------------------------------------ the owner's endpoints

/**
 * /api/admin/experiments            POST create, GET list
 * /api/admin/experiments/:id        GET status
 * /api/admin/experiments/:id/kill   POST  {"reason": "..."}
 * /api/admin/experiments/:id/resume POST  {"reason": "..."}
 * /api/admin/experiments/:id/tick   POST  think now
 */
export async function handleAdmin(req: Request, ctx: Ctx): Promise<Response> {
  if (!ctx.adminToken) return json(503, { error: 'admin_not_configured' });
  if (!bearerOk(req, ctx.adminToken)) return json(401, { error: 'unauthorized' });

  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const at = parts.indexOf('admin');
  const route = at >= 0 ? parts.slice(at + 1) : [];
  if (route[0] !== 'experiments') return json(404, { error: 'not_found' });
  const now = ctx.now();

  if (route.length === 1) {
    if (req.method === 'GET') return json(200, { experiments: await ctx.store.listAll() });
    if (req.method === 'POST') return createExperiment(req, ctx, now);
    return json(405, { error: 'method_not_allowed' });
  }

  const id = route[1];
  const row = await ctx.store.getExperiment(id);
  if (!row) return json(404, { error: 'unknown_experiment' });

  if (route.length === 2) {
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    return json(200, await status(ctx, row, now));
  }

  if (route.length === 3 && req.method === 'POST') {
    const action = route[2];
    if (action === 'kill' || action === 'resume') {
      const reason = await reasonFrom(req);
      const entry: AuditEntry = { at: now, actor: 'person', action: action === 'kill' ? 'kill_switch_on' : 'kill_switch_off', reason };
      const changed = await ctx.store.setKilled(id, action === 'kill', entry);
      return json(200, { ok: true, changed, killed: action === 'kill' });
    }
    if (action === 'tick') return json(200, { ok: true, result: await runTick(ctx.store, id, now) });
  }
  return json(404, { error: 'not_found' });
}

async function reasonFrom(req: Request): Promise<string> {
  try {
    const b = (await req.json()) as { reason?: unknown };
    if (typeof b.reason === 'string' && b.reason.trim()) return b.reason.trim().slice(0, 300);
  } catch {
    // no body is fine
  }
  return 'no reason given';
}

async function createExperiment(req: Request, ctx: Ctx, now: number): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_request', errors: ['body is not JSON'] });
  }
  const made = validateNewExperiment(body);
  if (!made.ok) return json(422, { error: 'invalid', errors: made.errors });
  const def = made.def;
  const engine = new Engine(def.config, CONTROL_ID, def.order, mulberry32(hash32(`${def.id}|${now}`)), now);
  try {
    await ctx.store.createExperiment(def, engine.toState(), engine.audit, now);
  } catch (err) {
    if (err instanceof DuplicateExperimentError) return json(409, { error: 'exists' });
    throw err;
  }
  return json(201, { ok: true, id: def.id, stage: engine.stage, weights: engine.weights });
}

async function status(ctx: Ctx, row: ExperimentRow, now: number) {
  const engine = await loadEngine(ctx.store, row, now);
  const snap = engine.snapshot();
  return {
    id: row.def.id,
    name: row.def.name,
    createdAt: row.createdAt,
    tickedAt: row.tickedAt,
    target: row.def.target,
    goal: row.def.goal,
    allowedOrigins: row.def.allowedOrigins,
    ...snap,
    variants: snap.variants.map((v) => ({ ...v, label: v.id === CONTROL_ID ? 'Original' : row.def.variants[v.id].label })),
    /** Counts so far, including visitors whose window has not closed. The numbers above only include closed ones. */
    progress: await ctx.store.progress(row.def.id),
    audit: await ctx.store.readAudit(row.def.id, 100),
  };
}
