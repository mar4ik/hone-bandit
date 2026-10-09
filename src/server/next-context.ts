import { after } from 'next/server';
import { ctxFromEnv } from './context.ts';
import type { Ctx } from './handlers.ts';
import { neonSql } from './neon.ts';

let cached: Ctx | null = null;

/** The one place the Next.js and Neon packages are touched. Everything it calls is tested without them. */
export function getCtx(): Ctx {
  cached ??= ctxFromEnv(process.env, { connect: neonSql, schedule: (work) => after(work) });
  return cached;
}
