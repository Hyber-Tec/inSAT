// insat API bootstrap (multi-tenant): apply schema + migrations, seed
// the superadmin + global blueprint templates, ensure a default institution
// with its demo admin, backfill any legacy rows into it, mount routes, listen.

import express from 'express';
import cors from 'cors';
import { config } from './lib/config.js';
import { query, ensureSchema, runMigrations } from './lib/db.js';
import { hashPassword, requireAuth, requireRole } from './lib/auth.js';
import { DEFAULT_BLUEPRINTS } from './lib/blueprints.js';
import { POOL_SLUG, POOL_SOURCES, ensureGlobalPool } from './lib/pool.js';
import { asyncHandler, errorHandler, notFound } from './lib/http.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import studentRoutes from './routes/student.js';
import superRoutes from './routes/super.js';

// Global blueprint templates (institution_id IS NULL) shared by all academies.
async function seedGlobalBlueprints() {
  for (const bp of DEFAULT_BLUEPRINTS) {
    const existing = await query('SELECT id FROM pa_blueprints WHERE name = $1 AND institution_id IS NULL', [bp.name]);
    if (existing.rows.length) continue;
    await query(
      'INSERT INTO pa_blueprints (name, description, spec, is_default, institution_id) VALUES ($1, $2, $3::jsonb, $4, NULL)',
      [bp.name, bp.description, JSON.stringify(bp.spec), bp.is_default],
    );
  }
}

// The platform superadmin is defined by SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD —
// those env vars are the source of truth, so this RECONCILES the account on every
// boot (creates it, or resets the password to match). Change the env vars and
// restart/redeploy to update the login. (An in-app password change to this
// account is therefore reverted on the next boot.)
async function seedSuperadmin() {
  const email = config.super.email;
  const hash = await hashPassword(config.super.password);
  const { rows } = await query('SELECT id FROM pa_users WHERE email = $1', [email]);
  if (rows[0]) {
    await query(
      "UPDATE pa_users SET password_hash = $1, role = 'superadmin', active = true, institution_id = NULL WHERE id = $2",
      [hash, rows[0].id],
    );
    console.log(`[seed] superadmin reconciled: ${email}`);
  } else {
    await query(
      `INSERT INTO pa_users (email, password_hash, display_name, role, institution_id)
       VALUES ($1, $2, $3, 'superadmin', NULL)`,
      [email, hash, config.super.name],
    );
    console.log(`[seed] superadmin created: ${email}`);
  }
}

// The platform's own institution: insat's self-guided students, and the bank
// that is insat's question pool (lib/pool.js).
async function ensureDefaultInstitution() {
  const { rows } = await query('SELECT id FROM pa_institutions WHERE slug = $1', [POOL_SLUG]);
  if (rows[0]) return rows[0].id;
  const r = await query("INSERT INTO pa_institutions (name, slug) VALUES ('insat', $1) RETURNING id", [POOL_SLUG]);
  return r.rows[0].id;
}

// Demo institution admin lives inside the default institution.
// Demo institution admin — also reconciled from ADMIN_EMAIL / ADMIN_PASSWORD on
// boot (env is the source of truth). Real per-institution admins are created in
// the superadmin console and are NOT affected by this.
async function seedDemoAdmin(institutionId) {
  const email = config.admin.email;
  const hash = await hashPassword(config.admin.password);
  const { rows } = await query('SELECT id FROM pa_users WHERE email = $1', [email]);
  if (rows[0]) {
    await query(
      "UPDATE pa_users SET password_hash = $1, role = 'admin', active = true, institution_id = COALESCE(institution_id, $2) WHERE id = $3",
      [hash, institutionId, rows[0].id],
    );
    return;
  }
  await query(
    `INSERT INTO pa_users (email, password_hash, display_name, role, institution_id)
     VALUES ($1, $2, $3, 'admin', $4)`,
    [email, hash, config.admin.name, institutionId],
  );
  console.log(`[seed] demo admin created: ${email}`);
}

// Keep the generation pool's copy of insat's question pool current
// (idempotent): what the import and variation scripts, or the templates, added
// to the pool comes over on the next boot. Only the pool is copied; what an
// academy made for its own tests stays private (lib/pool.js).
async function backfillGlobalPool(globalId, poolInstitutionId) {
  await query(
    `INSERT INTO pa_items
       (institution_id, content_hash, section, domain, skill, difficulty, passage,
        question, choices, correct_idx, answer_type, rationale, figure, asset_id,
        source, verified, answer_text, accepted, simhash, realism)
     SELECT $1, content_hash, section, domain, skill, difficulty, passage,
            question, choices, correct_idx, answer_type, rationale, figure, asset_id,
            source, verified, answer_text, accepted, simhash, realism
       FROM pa_items
      WHERE institution_id = $2 AND source = ANY($3::text[]) AND retired_at IS NULL
     ON CONFLICT (institution_id, content_hash) DO NOTHING`,
    [globalId, poolInstitutionId, POOL_SOURCES],
  );
}

// Move any legacy (pre-multi-tenant) rows into the default institution.
async function backfillLegacy(institutionId) {
  for (const t of ['pa_users', 'pa_groups', 'pa_items', 'pa_exams', 'pa_assignments', 'pa_sessions']) {
    const where = t === 'pa_users' ? "institution_id IS NULL AND role IN ('admin','student')" : 'institution_id IS NULL';
    await query(`UPDATE ${t} SET institution_id = $1 WHERE ${where}`, [institutionId]);
  }
}

async function boot() {
  if (await ensureSchema()) console.log('[db] base schema applied');
  await runMigrations();
  await seedGlobalBlueprints();
  await seedSuperadmin();
  const globalPool = await ensureGlobalPool();
  const defaultInst = await ensureDefaultInstitution();
  await seedDemoAdmin(defaultInst);
  await backfillLegacy(defaultInst);
  // (No blueprint exam provisioning — exams are admin-built question collections.
  // Provisioning here used to re-create Full/Demo SAT on every boot.)
  await backfillGlobalPool(globalPool, defaultInst);

  const app = express();
  // Allow the configured client origin, plus any localhost / 127.0.0.1 origin in
  // dev (Vite serves on 127.0.0.1 but CLIENT_ORIGIN is often localhost). Requests
  // with no Origin (curl, same-origin) are allowed too. Production stays locked
  // to CLIENT_ORIGIN since an attacker's origin is never localhost.
  const isLocalDevOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  app.use(cors({
    origin(origin, cb) {
      if (!origin || origin === config.clientOrigin || isLocalDevOrigin(origin)) return cb(null, true);
      return cb(null, false);
    },
  }));
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'satify-api' }));

  // Friendly root so hitting the API URL directly isn't a bare "Cannot GET /".
  // This is an API; the app UI lives on the client site.
  app.get('/', (_req, res) => res.json({
    service: 'satify-api',
    ok: true,
    message: 'This is the insat API. Open the client site to use the app.',
    health: '/api/health',
  }));

  // Public: question figure assets (referenced by <img> tags that can't send a JWT).
  app.get('/api/assets/:id', asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT mime, bytes FROM pa_assets WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('asset');
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rows[0].bytes);
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/super', requireAuth, requireRole('superadmin'), superRoutes);
  app.use('/api/admin', requireAuth, requireRole('admin'), adminRoutes);
  app.use('/api/student', requireAuth, requireRole('student'), studentRoutes);

  app.use(errorHandler);

  app.listen(config.port, () => {
    console.log(`[api] insat API listening on :${config.port}`);
    const genKey = config.platformApiKey ? 'platform key set' : 'no platform key (institutions must add their own)';
    console.log(`[api] generation: in-app · ${genKey} · client origin ${config.clientOrigin}`);
  });
}

boot().catch((err) => {
  console.error('[boot] failed:', err);
  process.exit(1);
});
