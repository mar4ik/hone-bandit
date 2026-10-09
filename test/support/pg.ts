import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/server/migrate.ts';
import { PgStore } from '../../src/server/pg-store.ts';
import { PgConnection, PgPool, parseDbUrl } from './pg-wire.ts';

export const NO_DB = 'No test database: run scripts/pg-test-server.sh start and export the HONE_TEST_DATABASE line it prints';

const here = dirname(fileURLToPath(import.meta.url));

export interface TestDb {
  store: PgStore;
  sql: PgPool;
  close(): Promise<void>;
}

/** A fresh schema with the migrations applied. Returns null when no test database is configured. */
export async function openTestDb(connections = 4): Promise<TestDb | null> {
  const url = process.env.HONE_TEST_DATABASE;
  if (!url) return null;
  const db = parseDbUrl(url);
  const schema = `t_${process.pid}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = await PgConnection.connect(db);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const sql = await PgPool.connect(db, connections, `-c search_path=${schema}`);
  await migrate(sql, join(here, '..', '..', 'db'));
  return {
    store: new PgStore(sql),
    sql,
    async close() {
      await sql.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
