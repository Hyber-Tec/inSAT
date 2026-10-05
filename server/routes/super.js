// Superadmin routes - platform owner only. Provision institutions (academies)
// and their first admin, each self-guided or managed (lib/modes.js).

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { asyncHandler, parseBody, notFound, conflict, badRequest } from '../lib/http.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../lib/auth.js';
import { publicUser } from './auth.js';
import { signInvite, inviteLink } from '../lib/invite.js';
import { sendInvite } from '../lib/mail.js';
import { GLOBAL_POOL_SLUG, POOL_SLUG } from '../lib/pool.js';
import { MODES } from '../lib/modes.js';

const router = Router();

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'academy';

// insat's own institution holds the question pool every institution draws on
// (lib/pool.js); its items are its questions, an academy's are its own.
const shapeInstitution = (i) => ({
  id: i.id, name: i.name, slug: i.slug, mode: i.mode, active: i.active, createdAt: i.created_at,
  adminCount: i.admin_count, studentCount: i.student_count, itemCount: i.item_count, examCount: i.exam_count,
  holdsPool: i.slug === POOL_SLUG,
});

async function createInstitutionAdmin(institutionId, { email, displayName, password }, institutionName) {
  const addr = email.toLowerCase().trim();
  const dupe = await query('SELECT id FROM pa_users WHERE email = $1', [addr]);
  if (dupe.rows.length) throw conflict('A user with that email already exists');
  const { rows } = await query(
    `INSERT INTO pa_users (email, password_hash, display_name, role, must_change_password, institution_id)
     VALUES ($1, $2, $3, 'admin', true, $4) RETURNING *`,
    [addr, await hashPassword(password || randomUUID()), displayName || 'Administrator', institutionId],
  );
  const link = inviteLink(signInvite({ userId: rows[0].id, email: addr }));
  const mail = await sendInvite(addr, link, { role: 'an administrator', institution: institutionName });
  return { admin: rows[0], inviteLink: link, emailed: mail.sent };
}

// List institutions with rollup counts.
router.get('/institutions', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT i.*,
        (SELECT COUNT(*)::int FROM pa_users u WHERE u.institution_id = i.id AND u.role = 'admin')   AS admin_count,
        (SELECT COUNT(*)::int FROM pa_users u WHERE u.institution_id = i.id AND u.role = 'student')  AS student_count,
        (SELECT COUNT(*)::int FROM pa_items it WHERE it.institution_id = i.id AND it.retired_at IS NULL) AS item_count,
        (SELECT COUNT(*)::int FROM pa_exams e WHERE e.institution_id = i.id)                          AS exam_count
       FROM pa_institutions i WHERE i.slug <> $1 ORDER BY i.created_at DESC`,
    [GLOBAL_POOL_SLUG],
  );
  res.json({ institutions: rows.map(shapeInstitution) });
}));

// Create an institution, optionally with its first admin in one step.
const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  mode: z.enum(MODES).default('self_guided'),
  adminEmail: z.string().email().optional(),
  adminName: z.string().optional(),
  adminPassword: z.string().min(6).optional(),
});

router.post('/institutions', asyncHandler(async (req, res) => {
  const d = parseBody(createSchema, req.body);
  const slug = (d.slug && d.slug.trim()) || slugify(d.name);
  const dupe = await query('SELECT id FROM pa_institutions WHERE slug = $1', [slug]);
  if (dupe.rows.length) throw conflict('An institution with that slug already exists');
  const { rows } = await query(
    'INSERT INTO pa_institutions (name, slug, mode) VALUES ($1, $2, $3) RETURNING *',
    [d.name, slug, d.mode],
  );
  const institution = rows[0];
  // New institutions start with no exams: a managed institution's admin creates
  // their own tests; a self-guided one's students start practice themselves.

  let result = null;
  if (d.adminEmail) {
    result = await createInstitutionAdmin(institution.id, { email: d.adminEmail, displayName: d.adminName, password: d.adminPassword }, institution.name);
  }
  res.status(201).json({
    institution: shapeInstitution({ ...institution, admin_count: result ? 1 : 0, student_count: 0, item_count: 0, exam_count: 0 }),
    admin: result ? publicUser(result.admin) : null,
    inviteLink: result ? result.inviteLink : null,
    emailed: result ? result.emailed : false,
  });
}));

// Rename an institution or change its mode. Changing the mode deletes nothing:
// a managed institution's groups, tests and assignments wait, unused, until it
// is managed again.
router.patch('/institutions/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().trim().min(1).optional(), mode: z.enum(MODES).optional() }), req.body);
  if (d.name === undefined && d.mode === undefined) throw badRequest('Nothing to update');
  const { rows } = await query(
    `UPDATE pa_institutions SET name = COALESCE($1, name), mode = COALESCE($2, mode)
      WHERE id = $3 AND slug <> $4 RETURNING *`,
    [d.name ?? null, d.mode ?? null, req.params.id, GLOBAL_POOL_SLUG],
  );
  if (!rows[0]) throw notFound('institution');
  res.json({ institution: { id: rows[0].id, name: rows[0].name, mode: rows[0].mode } });
}));

// Deleting an institution deletes everything in it, its questions included,
// so the one holding insat's question pool (and the generation pool) never is.
router.delete('/institutions/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT slug FROM pa_institutions WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('institution');
  if ([POOL_SLUG, GLOBAL_POOL_SLUG].includes(rows[0].slug)) {
    throw badRequest("This institution holds insat's question pool, which every institution's tests and practice draw on, so it cannot be deleted.");
  }
  await query('DELETE FROM pa_institutions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Admins of an institution.
router.get('/institutions/:id/admins', asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM pa_users WHERE institution_id = $1 AND role = 'admin' ORDER BY created_at DESC",
    [req.params.id],
  );
  res.json({ admins: rows.map(publicUser) });
}));

router.post('/institutions/:id/admins', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ email: z.string().email(), displayName: z.string().min(1), password: z.string().min(6).optional() }),
    req.body,
  );
  const i = await query('SELECT id, name FROM pa_institutions WHERE id = $1', [req.params.id]);
  if (!i.rows.length) throw notFound('institution');
  const r = await createInstitutionAdmin(req.params.id, d, i.rows[0].name);
  res.status(201).json({ admin: publicUser(r.admin), inviteLink: r.inviteLink, emailed: r.emailed });
}));

// Manage an existing admin: deactivate / reactivate, or reset their password.
router.patch('/institutions/:id/admins/:adminId', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ active: z.boolean().optional(), password: z.string().min(6).optional() }),
    req.body,
  );
  const sets = [];
  const params = [];
  let i = 1;
  if (d.active !== undefined) { sets.push(`active = $${i++}`); params.push(d.active); }
  if (d.password !== undefined) {
    sets.push(`password_hash = $${i++}`); params.push(await hashPassword(d.password));
    sets.push('must_change_password = true');
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(req.params.adminId, req.params.id);
  const { rows } = await query(
    `UPDATE pa_users SET ${sets.join(', ')} WHERE id = $${i++} AND institution_id = $${i} AND role = 'admin' RETURNING *`,
    params,
  );
  if (!rows[0]) throw notFound('admin');
  res.json({ admin: publicUser(rows[0]) });
}));

// Remove an admin from an institution.
router.delete('/institutions/:id/admins/:adminId', asyncHandler(async (req, res) => {
  const r = await query(
    "DELETE FROM pa_users WHERE id = $1 AND institution_id = $2 AND role = 'admin'",
    [req.params.adminId, req.params.id],
  );
  if (!r.rowCount) throw notFound('admin');
  res.json({ ok: true });
}));

// Students of an institution - optional ?search= matches name or email.
router.get('/institutions/:id/students', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const params = [req.params.id];
  let where = "institution_id = $1 AND role = 'student'";
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (display_name ILIKE $2 OR email ILIKE $2)`;
  }
  const { rows } = await query(
    `SELECT * FROM pa_users WHERE ${where} ORDER BY created_at DESC`,
    params,
  );
  res.json({ students: rows.map(publicUser) });
}));

// Manage a student: deactivate / reactivate.
router.patch('/institutions/:id/students/:studentId', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ active: z.boolean().optional() }), req.body);
  if (d.active === undefined) throw badRequest('Nothing to update');
  const { rows } = await query(
    `UPDATE pa_users SET active = $1 WHERE id = $2 AND institution_id = $3 AND role = 'student' RETURNING *`,
    [d.active, req.params.studentId, req.params.id],
  );
  if (!rows[0]) throw notFound('student');
  res.json({ student: publicUser(rows[0]) });
}));

// Remove a student from an institution.
router.delete('/institutions/:id/students/:studentId', asyncHandler(async (req, res) => {
  const r = await query(
    "DELETE FROM pa_users WHERE id = $1 AND institution_id = $2 AND role = 'student'",
    [req.params.studentId, req.params.id],
  );
  if (!r.rowCount) throw notFound('student');
  res.json({ ok: true });
}));

export default router;
