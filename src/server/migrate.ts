import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from './pg-store.ts';

/** Splits a migration file into statements. The files are written so that this simple split is safe. */
export function splitStatements(text: string): string[] {
  const noComments = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Runs every db/*.sql file in name order. Each file is safe to run again. */
export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    for (const statement of splitStatements(readFileSync(join(dir, f), 'utf8'))) await sql.query(statement);
  }
  return files;
}
