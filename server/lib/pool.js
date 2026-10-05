// The shared question banks, and what keeps an academy's own questions out of
// them.
//
// insat's question pool is the bank of the platform's own institution (slug
// 'satify', made on boot): questions from real tests, their variants
// (lib/variation) and the math templates' questions. Every institution's tests
// and practice draw from it, whatever its mode, so a new academy has the whole
// pool from its first day. Only those three sources are the pool. (A check
// that needs a bank of known questions points its throwaway institution's
// pool_institution_id at itself; nothing in the app sets it.)
//
// The generation pool is a hidden institution holding the examples AI
// generation imitates: the reference questions (the College Board bank and
// practice tests, never served) and a copy of insat's pool. It is never shown
// as a tenant in the superadmin console.
//
// What a managed academy uploads or writes with AI for its own tests stays in
// its own bank, private: it is served only in those tests and never enters
// either pool.

import { query } from './db.js';

export const POOL_SLUG = 'satify';
export const POOL_SOURCES = ['original', 'variant', 'template'];
export const GLOBAL_POOL_SLUG = '__global_pool__';

let poolCache = null;
let globalCache = null;

/** The institution whose bank is insat's question pool (null until boot has made it). */
export async function poolId() {
  if (poolCache) return poolCache;
  const { rows } = await query('SELECT id FROM pa_institutions WHERE slug = $1', [POOL_SLUG]);
  poolCache = rows[0]?.id || null;
  return poolCache;
}

/** The institution whose bank an institution's tests and practice draw on. */
export async function poolFor(institutionId) {
  if (institutionId) {
    const { rows } = await query('SELECT pool_institution_id FROM pa_institutions WHERE id = $1', [institutionId]);
    if (rows[0]?.pool_institution_id) return rows[0].pool_institution_id;
  }
  return poolId();
}

/** Create the generation pool institution if absent. Call once on boot. */
export async function ensureGlobalPool() {
  const { rows } = await query('SELECT id FROM pa_institutions WHERE slug = $1', [GLOBAL_POOL_SLUG]);
  if (rows[0]) { globalCache = rows[0].id; return globalCache; }
  const r = await query(
    'INSERT INTO pa_institutions (name, slug) VALUES ($1, $2) RETURNING id',
    ['Global question pool', GLOBAL_POOL_SLUG],
  );
  globalCache = r.rows[0].id;
  return globalCache;
}

/** The generation pool institution id (cached after first lookup). */
export async function globalPoolId() {
  if (globalCache) return globalCache;
  return ensureGlobalPool();
}
