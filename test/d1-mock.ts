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
  /** D1's batch: run multiple prepared statements atomically. */
  batch<T = unknown>(statements: MockBound[]): Promise<Array<{ results: T[]; meta: RunResult['meta'] }>>;
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
    async batch<T>(statements: MockBound[]) {
      // Serial execution to match D1's batch ordering. better-sqlite3
      // is synchronous so atomicity within a single Node tick is fine
      // for the test surface — we're verifying the SQL semantics of
      // each statement, not real transaction rollback. Tests that need
      // true transactional rollback assertions should use a real D1
      // (Miniflare via @cloudflare/vitest-pool-workers).
      const out: Array<{ results: T[]; meta: RunResult['meta'] }> = [];
      for (const s of statements) {
        const r = await s.run();
        out.push({ results: [] as T[], meta: r.meta });
      }
      return out;
    },
    raw: db,
  };
}
