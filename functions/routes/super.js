// Superadmin routes - platform owner only. Provision institutions (academies)
// and their first admin, each self-guided or managed (lib/modes.js).

import { Router } from 'express';
import { z } from 'zod';
import { COL, col, countOf, deleteWhere, getRow, newId, now, queryRows, writeAll } from '../lib/store.js';
import { asyncHandler, parseBody, notFound, conflict, badRequest } from '../lib/http.js';
import { createAccount, deleteAccount, setActive, setPassword } from '../lib/accounts.js';
import { publicUser } from './auth.js';
import { createInvite, inviteLink } from '../lib/invite.js';
import { sendInvite } from '../lib/mail.js';
import { GLOBAL_POOL_SLUG, POOL_SLUG } from '../lib/pool.js';
import { MODES } from '../lib/modes.js';

const router = Router();

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'academy';
const newestFirst = (a, b) => (b.created_at?.getTime?.() ?? 0) - (a.created_at?.getTime?.() ?? 0);

// insat's own institution holds the question pool every institution draws on
// (lib/pool.js); its items are its questions, an academy's are its own.
const shapeInstitution = (i) => ({
  id: i.id, name: i.name, slug: i.slug, mode: i.mode, active: i.active, createdAt: i.created_at,
  adminCount: i.admin_count, studentCount: i.student_count, itemCount: i.item_count, examCount: i.exam_count,
  holdsPool: i.slug === POOL_SLUG,
});

/** An institution the console manages (never the hidden generation pool), or null. */
async function institutionOf(id) {
  const i = await getRow(COL.institutions, id);
  return i && i.slug !== GLOBAL_POOL_SLUG ? i : null;
}

/** An account of this institution in this role, or null. */
async function memberOf(id, institutionId, role) {
  const u = await getRow(COL.users, id);
  return u && u.institution_id === institutionId && u.role === role ? u : null;
}

async function createInstitutionAdmin(institutionId, { email, displayName, password }, institutionName) {
  const admin = await createAccount({
    email, displayName: displayName || 'Administrator', password, role: 'admin', institutionId,
  });
  const link = inviteLink(await createInvite({ userId: admin.id, email: admin.email }));
  const mail = await sendInvite(admin.email, link, { role: 'an administrator', institution: institutionName });
  return { admin, inviteLink: link, emailed: mail.sent };
}

// List institutions with rollup counts.
router.get('/institutions', asyncHandler(async (_req, res) => {
  const rows = (await queryRows(col(COL.institutions))).filter((i) => i.slug !== GLOBAL_POOL_SLUG).sort(newestFirst);
  const users = (field, value) => col(COL.users).where('institution_id', '==', field).where('role', '==', value);
  const counted = await Promise.all(rows.map(async (i) => ({
    ...i,
    admin_count: await countOf(users(i.id, 'admin')),
    student_count: await countOf(users(i.id, 'student')),
    item_count: await countOf(col(COL.items).where('institution_id', '==', i.id).where('retired_at', '==', null)),
    exam_count: await countOf(col(COL.exams).where('institution_id', '==', i.id)),
  })));
  res.json({ institutions: counted.map(shapeInstitution) });
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
  const dupe = await col(COL.institutions).where('slug', '==', slug).limit(1).select().get();
  if (!dupe.empty) throw conflict('An institution with that slug already exists');
  const institution = {
    id: newId(), name: d.name, slug, mode: d.mode, active: true, created_at: now(),
    llm_api_key_enc: null, llm_key_hint: null, llm_provider: null, llm_model: null,
    logo_asset_id: null, accent: null, pool_institution_id: null,
  };
  const { id, ...fields } = institution;
  await col(COL.institutions).doc(id).set(fields);
  // New institutions start with no exams: a managed institution's admin creates
  // their own tests; a self-guided one's students start practice themselves.

  let result = null;
  if (d.adminEmail) {
    result = await createInstitutionAdmin(id, { email: d.adminEmail, displayName: d.adminName, password: d.adminPassword }, d.name);
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
  const i = await institutionOf(req.params.id);
  if (!i) throw notFound('institution');
  const changes = {};
  if (d.name !== undefined) changes.name = d.name;
  if (d.mode !== undefined) changes.mode = d.mode;
  await col(COL.institutions).doc(i.id).update(changes);
  res.json({ institution: { id: i.id, name: changes.name ?? i.name, mode: changes.mode ?? i.mode } });
}));

// Deleting an institution deletes everything in it, its questions included,
// so the one holding insat's question pool (and the generation pool) never is.
router.delete('/institutions/:id', asyncHandler(async (req, res) => {
  const i = await getRow(COL.institutions, req.params.id);
  if (!i) throw notFound('institution');
  if ([POOL_SLUG, GLOBAL_POOL_SLUG].includes(i.slug)) {
    throw badRequest("This institution holds insat's question pool, which every institution's tests and practice draw on, so it cannot be deleted.");
  }
  const members = await col(COL.users).where('institution_id', '==', i.id).select().get();
  for (const m of members.docs) await deleteAccount(m.id);
  const items = await col(COL.items).where('institution_id', '==', i.id).select('content_hash').get();
  await writeAll(items.docs.filter((d) => d.get('content_hash')).map((d) => ['delete', col(COL.itemHashes).doc(`${i.id}_${d.get('content_hash')}`)]));
  for (const name of [COL.items, COL.sessions, COL.assignments, COL.groups, COL.exams, COL.examFolders, COL.blueprints]) {
    await deleteWhere(col(name).where('institution_id', '==', i.id));
  }
  await col(COL.institutions).doc(i.id).delete();
  res.json({ ok: true });
}));

// Admins of an institution.
router.get('/institutions/:id/admins', asyncHandler(async (req, res) => {
  const rows = await queryRows(col(COL.users).where('institution_id', '==', req.params.id).where('role', '==', 'admin'));
  res.json({ admins: rows.sort(newestFirst).map(publicUser) });
}));

router.post('/institutions/:id/admins', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ email: z.string().email(), displayName: z.string().min(1), password: z.string().min(6).optional() }),
    req.body,
  );
  const i = await institutionOf(req.params.id);
  if (!i) throw notFound('institution');
  const r = await createInstitutionAdmin(i.id, d, i.name);
  res.status(201).json({ admin: publicUser(r.admin), inviteLink: r.inviteLink, emailed: r.emailed });
}));

// Manage an existing admin: deactivate / reactivate, or reset their password.
router.patch('/institutions/:id/admins/:adminId', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ active: z.boolean().optional(), password: z.string().min(6).optional() }),
    req.body,
  );
  if (d.active === undefined && d.password === undefined) throw badRequest('Nothing to update');
  const admin = await memberOf(req.params.adminId, req.params.id, 'admin');
  if (!admin) throw notFound('admin');
  if (d.active !== undefined) await setActive(admin.id, d.active);
  if (d.password !== undefined) await setPassword(admin.id, d.password, { mustChange: true });
  res.json({ admin: publicUser(await getRow(COL.users, admin.id)) });
}));

// Remove an admin from an institution.
router.delete('/institutions/:id/admins/:adminId', asyncHandler(async (req, res) => {
  if (!(await memberOf(req.params.adminId, req.params.id, 'admin'))) throw notFound('admin');
  await deleteAccount(req.params.adminId);
  res.json({ ok: true });
}));

// Students of an institution - optional ?search= matches name or email.
router.get('/institutions/:id/students', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const rows = (await queryRows(col(COL.users).where('institution_id', '==', req.params.id).where('role', '==', 'student')))
    .filter((u) => !search || String(u.display_name).toLowerCase().includes(search) || String(u.email).toLowerCase().includes(search));
  res.json({ students: rows.sort(newestFirst).map(publicUser) });
}));

// Manage a student: deactivate / reactivate.
router.patch('/institutions/:id/students/:studentId', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ active: z.boolean().optional() }), req.body);
  if (d.active === undefined) throw badRequest('Nothing to update');
  const student = await memberOf(req.params.studentId, req.params.id, 'student');
  if (!student) throw notFound('student');
  await setActive(student.id, d.active);
  res.json({ student: publicUser({ ...student, active: d.active }) });
}));

// Remove a student from an institution.
router.delete('/institutions/:id/students/:studentId', asyncHandler(async (req, res) => {
  if (!(await memberOf(req.params.studentId, req.params.id, 'student'))) throw notFound('student');
  await deleteAccount(req.params.studentId);
  res.json({ ok: true });
}));

export default router;
