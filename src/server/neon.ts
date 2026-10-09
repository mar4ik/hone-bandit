import { neon } from '@neondatabase/serverless';
import type { Sql } from './pg-store.ts';

/**
 * Neon's HTTP driver behind the small `Sql` interface the store uses.
 * One HTTP request per statement; no transactions (the store is written for that).
 * Not run against the real driver yet: see README, "What is not verified".
 */
export function neonSql(url: string): Sql {
  const run = neon(url);
  return {
    async query(text, params = []) {
      const rows = await run.query(text, params);
      return { rows: rows as Array<Record<string, unknown>> };
    },
  };
}
