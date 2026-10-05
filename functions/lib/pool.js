// The shared question banks, and what keeps an academy's own questions out of
// them.
//
// insat's question pool is the bank of the platform's own institution (slug
// 'satify'): questions from real tests, their variants (lib/variation) and the
// math templates' questions. Every institution's tests and practice draw from
// it, whatever its mode, so a new academy has the whole pool from its first
// day. Only those three sources are the pool. (A check that needs a bank of
// known questions points its throwaway institution's pool_institution_id at
// itself; nothing in the app sets it.)
//
// The generation pool is a hidden institution holding the examples AI
// generation imitates: the reference questions (the College Board bank and
// practice tests, never served) and a copy of insat's pool, which
// syncGlobalPool() keeps current. It is never shown as a tenant in the
// superadmin console.
//
// What a managed academy uploads or writes with AI for its own tests stays in
// its own bank, private: it is served only in those tests and never enters
// either pool.
//
// Each API instance keeps the banks it serves from in memory (bankRows): the
// first draw reads the whole bank, and later draws read only what changed
// since, by the items' updated_at (a server timestamp every item write sets).

import { FieldValue } from 'firebase-admin/firestore';
import { COL, col, newId, now, queryRows, rowOf, writeAll } from './store.js';
import { DEFAULT_BLUEPRINTS } from './blueprints.js';

export const POOL_SLUG = 'satify';
export const POOL_SOURCES = ['original', 'variant', 'template'];
export const GLOBAL_POOL_SLUG = '__global_pool__';

/** The field every write to an item sets, so the banks' caches see it. */
export const touched = () => ({ updated_at: FieldValue.serverTimestamp() });

const ids = new Map(); // slug -> institution id

async function institutionBySlug(slug) {
  if (ids.has(slug)) return ids.get(slug);
  const snap = await col(COL.institutions).where('slug', '==', slug).limit(1).get();
  const id = snap.empty ? null : snap.docs[0].id;
  if (id) ids.set(slug, id);
  return id;
}

/** The institution with this slug, made (as `name`) when absent. */
async function ensureInstitution(slug, name) {
  const found = await institutionBySlug(slug);
  if (found) return found;
  const id = newId();
  await col(COL.institutions).doc(id).set({
    name, slug, mode: 'self_guided', active: true, created_at: now(),
    llm_api_key_enc: null, llm_key_hint: null, llm_provider: null, llm_model: null,
    logo_asset_id: null, accent: null, pool_institution_id: null,
  });
  ids.set(slug, id);
  return id;
}

/** The institution whose bank is insat's question pool (made when absent). */
export const poolId = () => ensureInstitution(POOL_SLUG, 'insat');

/** insat's own academy: a new sign-up is one of its students. */
export { poolId as defaultInstitutionId };

/** The institution whose bank an institution's tests and practice draw on. */
export async function poolFor(institutionId) {
  if (institutionId) {
    const snap = await col(COL.institutions).doc(institutionId).get();
    if (snap.exists && snap.get('pool_institution_id')) return snap.get('pool_institution_id');
  }
  return poolId();
}

/** The generation pool institution id (made when absent). */
export const globalPoolId = () => ensureInstitution(GLOBAL_POOL_SLUG, 'Global question pool');
export const ensureGlobalPool = globalPoolId;

/**
 * What a fresh project needs before anyone signs in: insat's institution, the
 * generation pool and the global blueprint templates. Idempotent; the API runs
 * it once per instance.
 */
export async function bootstrap() {
  await poolId();
  await globalPoolId();
  const have = await queryRows(col(COL.blueprints).where('institution_id', '==', null));
  const names = new Set(have.map((b) => b.name));
  await writeAll(DEFAULT_BLUEPRINTS.filter((bp) => !names.has(bp.name)).map((bp) => ['set', col(COL.blueprints).doc(newId()), {
    name: bp.name, description: bp.description, spec: bp.spec, is_default: bp.is_default,
    institution_id: null, created_at: now(),
  }]));
}

// ---------------------------------------------------------------------------
// The banks in memory.
// ---------------------------------------------------------------------------

const REFRESH_MS = 60 * 1000;
const banks = new Map(); // institution id -> { rows: Map(id -> row), since, checkedAt, loading }

async function refresh(institutionId, bank) {
  let q = col(COL.items).where('institution_id', '==', institutionId);
  if (bank.since) q = q.where('updated_at', '>', bank.since);
  const snap = await q.get();
  for (const d of snap.docs) {
    const row = rowOf(d, COL.items);
    bank.rows.set(row.id, row);
    if (row.updated_at && (!bank.since || row.updated_at > bank.since)) bank.since = row.updated_at;
  }
  bank.checkedAt = Date.now();
}

/**
 * Every item of an institution's bank (retired ones included, for the caller
 * to leave out), current to the last minute and to this instance's own writes.
 * The rows are shared: read them, never change them.
 */
export async function bankRows(institutionId) {
  let bank = banks.get(institutionId);
  if (!bank) {
    bank = { rows: new Map(), since: null, checkedAt: 0, loading: null };
    banks.set(institutionId, bank);
  }
  if (!bank.loading && Date.now() - bank.checkedAt > REFRESH_MS) {
    bank.loading = refresh(institutionId, bank).finally(() => { bank.loading = null; });
  }
  if (bank.loading) await bank.loading;
  return bank.rows;
}

/** Rows this instance just wrote, into its copy of their bank. */
export function remember(institutionId, rows) {
  const bank = banks.get(institutionId);
  if (bank) for (const r of rows) bank.rows.set(r.id, r);
}

/** The servable questions of a bank: live, and of the pool's sources. */
export async function servable(institutionId) {
  const out = [];
  for (const r of (await bankRows(institutionId)).values()) {
    if (!r.retired_at && POOL_SOURCES.includes(r.source)) out.push(r);
  }
  return out;
}

/**
 * Keep the generation pool's copy of insat's question pool current
 * (idempotent): what the import and variation scripts, or the templates,
 * added to the pool is copied over. Only the pool is copied; what an academy
 * made for its own tests stays private. Returns the number copied.
 */
export async function syncGlobalPool() {
  const globalId = await globalPoolId();
  const pool = await poolId();
  const have = new Set((await col(COL.items).where('institution_id', '==', globalId).select('content_hash').get())
    .docs.map((d) => d.get('content_hash')));
  const missing = (await queryRows(col(COL.items).where('institution_id', '==', pool).where('retired_at', '==', null)))
    .filter((r) => POOL_SOURCES.includes(r.source) && r.content_hash && !have.has(r.content_hash));
  const ops = [];
  for (const r of missing) {
    const id = newId();
    const { id: _id, updated_at: _u, ...fields } = r;
    ops.push(['set', col(COL.itemHashes).doc(`${globalId}_${r.content_hash}`), { item_id: id }]);
    ops.push(['set', col(COL.items).doc(id), {
      ...fields,
      figure: r.figure == null ? null : JSON.stringify(r.figure),
      institution_id: globalId,
      created_at: now(),
      variant_of: null,
      ...touched(),
    }]);
  }
  await writeAll(ops);
  return missing.length;
}
