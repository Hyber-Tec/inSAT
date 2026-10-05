// Postgres access: a shared pool, a query helper, a transaction helper, and
// idempotent schema application. Same code runs against local docker Postgres
// or a hosted Neon/Railway database - only DATABASE_URL changes.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const { Pool } = pg;

// Enable TLS for hosted Postgres (Neon/Railway/Render). node-postgres doesn't
// auto-read sslmode from the URL, so turn it on when the URL asks for it or
// when it isn't a local connection.
const url = config.databaseUrl;
const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
const wantsSsl = /\bsslmode=require\b/.test(url) || process.env.PGSSL === 'true' || !isLocal;

export const pool = new Pool({
  connectionString: url,
  max: 10,
  ssl: wantsSsl ? { rejectUnauthorized: false } : false,
});

export const query = (text, params) => pool.query(text, params);

/** Run fn inside a transaction, committing on success and rolling back on throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const schemaPath = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));
const migratePath = fileURLToPath(new URL('../../db/migrate.sql', import.meta.url));

/**
 * Apply db/schema.sql when the app tables are absent. Detects the marker table
 * `pa_users`; if present, assumes the base schema is current and does nothing
 * (so we never re-run destructively against a populated production database).
 */
export async function ensureSchema() {
  const { rows } = await pool.query("SELECT to_regclass('public.pa_users') AS t");
  if (rows[0]?.t) return false;
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  return true;
}

/**
 * Apply db/migrate.sql every boot. It is idempotent (ADD COLUMN IF NOT EXISTS,
 * etc.), so it safely brings older databases up to the multi-tenant schema and
 * is a no-op once applied.
 */
export async function runMigrations() {
  const sql = readFileSync(migratePath, 'utf8');
  await pool.query(sql);
}
