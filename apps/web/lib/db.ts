import { createDb, type Db } from '@curbcut/db';

// `next dev` reloads modules often; one connection pool per reload would run
// Postgres out of connections, so the pool lives on globalThis.
const globalForDb = globalThis as typeof globalThis & { curbcutDb?: Db };

/** The app's database connection, created on first use so importing this needs no DATABASE_URL. */
export function getDb(): Db {
  globalForDb.curbcutDb ??= createDb();
  return globalForDb.curbcutDb;
}
