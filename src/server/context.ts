import { PgStore } from './pg-store.ts';
import type { Sql } from './pg-store.ts';
import type { Ctx } from './handlers.ts';

/** The settings the server reads from its environment. */
export type Env = Record<string, string | undefined>;

/** The parts that depend on the hosting platform, passed in so everything else can be tested without it. */
export interface Platform {
  /** Opens the database. On Vercel this is the Neon HTTP driver. */
  connect: (url: string) => Sql;
  /** Runs work after the response has gone out. On Vercel this is Next's `after`. */
  schedule?: (work: Promise<unknown>) => void;
  now?: () => number;
}

const DEFAULT_TICK_EVERY_MS = 5 * 60_000;

/** The Vercel Neon integration sets DATABASE_URL (and POSTGRES_URL). */
export function databaseUrl(env: Env): string | null {
  return env.DATABASE_URL || env.POSTGRES_URL || null;
}

/** HONE_TICK_EVERY_MS: 0 turns the on-demand tick off. A value that is not a number is ignored, with a warning. */
export function tickEvery(env: Env): number {
  const raw = env.HONE_TICK_EVERY_MS;
  if (raw === undefined || raw === '') return DEFAULT_TICK_EVERY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`hone: HONE_TICK_EVERY_MS="${raw}" is not a number of milliseconds; using ${DEFAULT_TICK_EVERY_MS}`);
    return DEFAULT_TICK_EVERY_MS;
  }
  return n;
}

/** Builds what the handlers need from the environment. Throws a plain message if the database is not set up. */
export function ctxFromEnv(env: Env, platform: Platform): Ctx {
  const url = databaseUrl(env);
  if (!url) throw new Error('No database: set DATABASE_URL (the Vercel Neon integration does this)');
  return {
    store: new PgStore(platform.connect(url)),
    now: platform.now ?? Date.now,
    adminToken: env.ADMIN_TOKEN || undefined,
    cronSecret: env.CRON_SECRET || undefined,
    schedule: platform.schedule,
    tickEveryMs: tickEvery(env),
  };
}
