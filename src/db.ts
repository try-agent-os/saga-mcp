// Dual-driver database layer.
//
// If DATABASE_URL is set → Postgres (node-postgres / pg). Schema bootstrap is
//   skipped (Neon already has the migrated schema and data).
// Else → SQLite (better-sqlite3), with bootstrap + WAL pragmas as before.
//
// Public API: getDb() returns an async interface with .query / .queryOne /
// .execute / .transaction(fn). All SQL strings use `?` placeholders — when the
// active driver is Postgres they are translated to `$1, $2, …` and SQLite-only
// expressions (`datetime('now')`, `json_each(...)`) are rewritten to PG
// equivalents. This lets every tool file keep its existing SQL strings.

import Database from 'better-sqlite3';
import pg from 'pg';
import { SCHEMA_SQL } from './schema.js';

const { Pool } = pg;

export type SqlParam = unknown;

export interface DB {
  /** Returns all rows for a SELECT (or RETURNING) statement. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Returns the first row or undefined. */
  queryOne<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  /** Runs an INSERT/UPDATE/DELETE without RETURNING. Returns affected row count. */
  execute(sql: string, params?: SqlParam[]): Promise<number>;
  /** Runs `fn` inside a transaction. The DB passed to `fn` is bound to the same connection. */
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  /** Driver kind so callers can branch on driver-specific behaviour (rare). */
  readonly driver: 'pg' | 'sqlite';
}

// ----- Postgres adapter ------------------------------------------------------

// Translate SQLite-flavoured SQL fragments to Postgres equivalents.
// Idempotent: applying twice is safe.
function translateSqlForPg(sql: string): string {
  let out = sql;
  // datetime('now') → to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  out = out.replace(
    /datetime\('now'\)/g,
    "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
  );
  // json_each(<expr>) → jsonb_array_elements_text((<expr>)::jsonb) AS json_each(value)
  // We need to rewrite both the function call and any reference like
  // `json_each.value` that appears in the surrounding WHERE clause.
  out = out.replace(
    /json_each\(([^)]+)\)/g,
    'jsonb_array_elements_text(($1)::jsonb) AS json_each(value)'
  );
  return out;
}

// Replace each unquoted `?` placeholder with `$1, $2, …`. Skips `?` characters
// inside single-quoted string literals.
function convertPlaceholders(sql: string): string {
  let result = '';
  let i = 0;
  let n = 1;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Toggle string-literal mode. Handle escaped quotes ('').
      inString = !inString;
      result += ch;
      i++;
      continue;
    }
    if (!inString && ch === '?') {
      result += `$${n}`;
      n++;
      i++;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

function prepareSqlForPg(sql: string): string {
  return convertPlaceholders(translateSqlForPg(sql));
}

interface PgExecutor {
  query(text: string, params?: SqlParam[]): Promise<pg.QueryResult>;
}

function pgAdapter(executor: PgExecutor, pool: pg.Pool | null): DB {
  const driver = 'pg' as const;
  return {
    driver,
    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const res = await executor.query(prepareSqlForPg(sql), params);
      return res.rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
      const res = await executor.query(prepareSqlForPg(sql), params);
      return (res.rows[0] as T | undefined) ?? undefined;
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<number> {
      const res = await executor.query(prepareSqlForPg(sql), params);
      return res.rowCount ?? 0;
    },
    async transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
      if (!pool) {
        // Already inside a transaction — flatten.
        return fn(this);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txDb = pgAdapter({ query: (t, p) => client.query(t, p) }, null);
        const result = await fn(txDb);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// ----- SQLite adapter --------------------------------------------------------

function sqliteAdapter(rawDb: Database.Database): DB {
  const driver = 'sqlite' as const;
  return {
    driver,
    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      return rawDb.prepare(sql).all(...params) as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
      return rawDb.prepare(sql).get(...params) as T | undefined;
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<number> {
      const info = rawDb.prepare(sql).run(...params);
      return info.changes;
    },
    async transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
      // better-sqlite3 transactions are synchronous, but our handlers are async.
      // We can't pass `fn` to db.transaction() because that wrapper expects a
      // sync callback. Instead, use explicit BEGIN / COMMIT / ROLLBACK — the
      // whole connection is serialised so nesting is fine for our usage.
      rawDb.exec('BEGIN');
      try {
        const result = await fn(sqliteAdapter(rawDb));
        rawDb.exec('COMMIT');
        return result;
      } catch (err) {
        try { rawDb.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },
  };
}

// ----- Initialisation --------------------------------------------------------

let cachedDb: DB | null = null;
let pgPool: pg.Pool | null = null;
let sqliteRaw: Database.Database | null = null;

export function getDb(): DB {
  if (cachedDb) return cachedDb;

  const url = process.env.DATABASE_URL;
  if (url) {
    pgPool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
    });
    // Surface idle-client errors to stderr so silent failures are visible.
    pgPool.on('error', (err) => {
      console.error('[saga-mcp] pg idle client error:', err);
    });
    cachedDb = pgAdapter({ query: (sql, params) => pgPool!.query(sql, params) }, pgPool);
    return cachedDb;
  }

  // SQLite fallback (preserves legacy behaviour exactly).
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error(
      'Neither DATABASE_URL nor DB_PATH is set. Set DATABASE_URL=postgres://… to use Neon, or DB_PATH=/path/to/.tracker.db to use SQLite.'
    );
  }

  sqliteRaw = new Database(dbPath);
  sqliteRaw.pragma('journal_mode = WAL');
  sqliteRaw.pragma('foreign_keys = ON');
  sqliteRaw.pragma('busy_timeout = 5000');
  sqliteRaw.pragma('synchronous = NORMAL');

  sqliteRaw.exec(SCHEMA_SQL);
  // Legacy migrations for existing databases.
  try { sqliteRaw.exec('ALTER TABLE tasks ADD COLUMN source_ref TEXT'); } catch { /* column already exists */ }

  cachedDb = sqliteAdapter(sqliteRaw);
  return cachedDb;
}

export async function closeDb(): Promise<void> {
  if (sqliteRaw) {
    sqliteRaw.close();
    sqliteRaw = null;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  cachedDb = null;
}
