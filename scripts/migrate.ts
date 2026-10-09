// Creates or updates the tables. Safe to run again.
//   vercel env pull .env.local && npm run db:migrate
// or, with psql:  psql "$DATABASE_URL" -f db/001_init.sql
import { fileURLToPath } from 'node:url';
import { databaseUrl } from '../src/server/context.ts';
import { migrate } from '../src/server/migrate.ts';
import { neonSql } from '../src/server/neon.ts';

const url = databaseUrl(process.env);
if (!url) {
  console.error('No database: set DATABASE_URL (npm run db:migrate reads .env.local)');
  process.exit(1);
}
const files = await migrate(neonSql(url), fileURLToPath(new URL('../db', import.meta.url)));
console.log(`applied: ${files.join(', ')}`);
