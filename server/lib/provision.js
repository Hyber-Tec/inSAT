// Per-institution provisioning helpers, shared by the superadmin routes and
// the boot backfill.

import { query } from './db.js';

/**
 * Create the default Demo + Full SAT exams for an institution from the global
 * blueprint templates (institution_id IS NULL). Idempotent.
 */
export async function provisionInstitutionExams(institutionId) {
  const { rows: bps } = await query(
    "SELECT id, name FROM pa_blueprints WHERE institution_id IS NULL AND name IN ('Full SAT', 'Demo SAT')",
  );
  for (const bp of bps) {
    const code = bp.name === 'Full SAT' ? 'full-sat' : 'demo-sat';
    const timing = bp.name === 'Demo SAT' ? 'demo' : 'full';
    await query(
      `INSERT INTO pa_exams (title, code, blueprint_id, timing_mode, institution_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (institution_id, code) DO NOTHING`,
      [bp.name, code, bp.id, timing, institutionId],
    );
  }
}
