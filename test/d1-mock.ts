/**
 * Thin D1Database mock backed by better-sqlite3 (in-memory SQLite).
 *
 * D1 is asynchronous; better-sqlite3 is synchronous. We wrap calls
 * in Promise.resolve so the API surface our Pages Functions use
 * (`.prepare().bind().run() | .first() | .all()`) works without
 * change. Only the surface our code touches is implemented — this
 * isn't a complete D1 polyfill.
 *
 * Migrations are applied at construction time by reading every
 * migrations/000*.sql file in lexical order. Tests can then operate
 * on a real schema without round-tripping Cloudflare.
 */

import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface RunResult { meta: { changes: number; last_row_id: number } }

export interface MockD1 {
  prepare(sql: string): MockStatement;
  /** Direct SQLite handle for assertions. Not part of D1's API. */
  raw: Database.Database;
}

interface MockStatement {
  bind(...args: unknown[]): MockBound;
  run(): Promise<RunResult>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface MockBound extends MockStatement {}

function wrap(stmt: Database.Statement, args: unknown[] = []): MockBound {
  return {
    bind(...rest: unknown[]) { return wrap(stmt, [...args, ...rest]); },
    async run() {
      const r = stmt.run(...(args as any[]));
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
    async first<T>() {
      const row = stmt.get(...(args as any[])) as T | undefined;
      return row ?? null;
    },
    async all<T>() {
      const rows = stmt.all(...(args as any[])) as T[];
      return { results: rows };
    },
  };
}

export function createMockD1(): MockD1 {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Apply migrations in lexical order. Wrangler's d1_migrations table
  // doesn't need to exist — we just run the SQL.
  const migrationsDir = join(import.meta.dirname ?? join(__dirname), '..', 'migrations');
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    db.exec(sql);
  }

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return wrap(stmt);
    },
    raw: db,
  };
}
