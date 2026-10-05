/**
 * Database connection pool - node-postgres.
 *
 * The pool is created once per process and reused across requests.
 * In serverless environments (Vercel, AWS Lambda) you'd swap this for
 * a serverless-friendly client like Neon's serverless driver or a
 * connection pooler such as PgBouncer / Supavisor in transaction mode.
 */

import { Pool, PoolClient, QueryResult } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://satify:satify@localhost:5433/satify',
  max: Number(process.env.DB_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Log to observability stack - never let an idle-client error kill the process.
  console.error('pg_pool_idle_error', err);
});

export const db = {
  /**
   * Single-query convenience. Wraps acquire / query / release.
   */
  async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    return pool.query<T>(text, params);
  },

  /**
   * Run a function inside a transaction. Rolls back on throw.
   *
   *   await db.transaction(async (tx) => {
   *     await tx.query('INSERT ...');
   *     await tx.query('UPDATE ...');
   *   });
   */
  async transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      throw err;
    } finally {
      client.release();
    }
  },

  /** Close the pool. Call on shutdown. */
  async close() { await pool.end(); },
};
