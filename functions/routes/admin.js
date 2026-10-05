// Admin routes - institution-scoped. Every query filters by the caller's
// institution (req.user.inst) so an academy admin only ever sees and manages
// their own students, groups, exams, assignments, results, and question bank.
// Blueprints are global templates (institution_id IS NULL) shared by all.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query, tx } from '../lib/db.js';
import { asyncHandler, parseBody, notFound, conflict, badRequest } from '../lib/http.js';
import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';
import { hashPassword } from '../lib/auth.js';
import { publicUser } from './auth.js';
import { sessionResults } from '../lib/session.js';
import { materializeForm } from '../lib/assembly.js';
import { extractFromUploads } from '../lib/ingest.js';
import { manualRow } from '../lib/items.js';
import {
  addRowsToExam, moveQuestionsToModule, countFormQuestions, emptyFixedForm, formCountSql, formSections,
} from '../lib/examForm.js';
import { generateQuestions } from '../lib/generate.js';
import { isValidDomain, domainForSkill, canonicalSkill, taxonomyTree } from '../lib/taxonomy.js';
import { aiStatus, getInstitutionCredentials } from '../lib/institutions.js';
import { POOL_SOURCES } from '../lib/pool.js';
import { requireMode } from '../lib/modes.js';
import {
  skillProfile, sectionSpec, practiceTitle, testSize, skillSetSize, MAX_SKILLS,
} from '../lib/practice.js';
import { signInvite, inviteLink } from '../lib/invite.js';
import { sendInvite } from '../lib/mail.js';
import bankRouter from './bank.js';
import settingsRouter from './settings.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'exam';
const rand = () => Math.random().toString(36).slice(2, 6);
const inst = (req) => req.user.inst;

// The institution's own LLM credentials (provider + key + optional model), so
// generation/extraction bill to them. Empty apiKey => platform Anthropic
// fallback inside complete(); REQUIRE_INSTITUTION_KEY makes an own key mandatory.
async function resolveCreds(req) {
  const creds = await getInstitutionCredentials(inst(req));
  if (!creds.apiKey && config.requireInstitutionKey) {
    throw badRequest("Add your institution's LLM API key in Settings to generate or extract questions.");
  }
  return creds;
}

// ============================== Users ======================================

// An institution admin only ever sees and manages STUDENTS in their own
// institution - never other admins (admin accounts are superadmin-managed).
router.get('/users', asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM pa_users WHERE institution_id = $1 AND role = 'student' ORDER BY created_at DESC",
    [inst(req)],
  );
  res.json({ users: rows.map(publicUser) });
}));

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(6).optional(), // omit to invite (link/email instead of a temp password)
});

router.post('/users', asyncHandler(async (req, res) => {
  const d = parseBody(createUserSchema, req.body);
  const email = d.email.toLowerCase().trim();
  const dupe = await query('SELECT id FROM pa_users WHERE email = $1', [email]);
  if (dupe.rows.length) throw conflict('A user with that email already exists');
  const { rows } = await query(
    `INSERT INTO pa_users (email, password_hash, display_name, role, must_change_password, institution_id)
     VALUES ($1, $2, $3, 'student', true, $4) RETURNING *`,
    [email, await hashPassword(d.password || randomUUID()), d.displayName, inst(req)],
  );
  const user = rows[0];
  const link = inviteLink(signInvite({ userId: user.id, email }));
  const instName = (await query('SELECT name FROM pa_institutions WHERE id = $1', [inst(req)])).rows[0]?.name;
  const mail = await sendInvite(email, link, { role: 'student', institution: instName });
  res.status(201).json({ user: publicUser(user), inviteLink: link, emailed: mail.sent });
}));

const patchUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const d = parseBody(patchUserSchema, req.body);
  const sets = [];
  const params = [];
  let i = 1;
  if (d.displayName !== undefined) { sets.push(`display_name = $${i++}`); params.push(d.displayName); }
  if (d.active !== undefined) { sets.push(`active = $${i++}`); params.push(d.active); }
  if (d.password !== undefined) {
    sets.push(`password_hash = $${i++}`); params.push(await hashPassword(d.password));
    sets.push('must_change_password = true');
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(req.params.id, inst(req));
  const { rows } = await query(
    `UPDATE pa_users SET ${sets.join(', ')} WHERE id = $${i++} AND institution_id = $${i} AND role = 'student' RETURNING *`,
    params,
  );
  if (!rows[0]) throw notFound('student');
  res.json({ user: publicUser(rows[0]) });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  // Scoped to students only - admins cannot delete other admins or themselves.
  const r = await query(
    "DELETE FROM pa_users WHERE id = $1 AND institution_id = $2 AND role = 'student'",
    [req.params.id, inst(req)],
  );
  if (!r.rowCount) throw notFound('student');
  res.json({ ok: true });
}));

// Groups, tests and assignments belong to managed institutions; a self-guided
// institution's students practise on their own (lib/modes.js).
const managedOnly = requireMode('managed', 'Groups, tests and assignments are for institution-managed academies.');
router.use(['/groups', '/blueprints', '/exams', '/exam-folders', '/assignments'], managedOnly);
// Questions from uploads or written by AI are for a managed academy's own
// tests (they stay in its private bank, lib/pool.js); a self-guided
// institution serves insat's pool alone, so it has no bank and no AI key.
router.use(['/bank', '/settings/llm-key'], requireMode('managed', 'Making tests from uploads or with AI is only for institution-managed academies.'));

// What an assignment is called: its test's title, or the practice set's.
const assignmentTitle = (a) => (a.kind === 'practice'
  ? practiceTitle('skills', a.practice?.skills || [], a.practice?.difficulty || null)
  : a.exam_title);

// One student, for their page (managed institutions): who they are and their
// groups, their skill map (with what there is to practise, for assigning
// topics), every test and practice set they started, and what is assigned to
// them, directly or through a group.
router.get('/users/:id/overview', managedOnly, asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM pa_users WHERE id = $1 AND institution_id = $2 AND role = 'student'",
    [req.params.id, inst(req)],
  );
  const student = rows[0];
  if (!student) throw notFound('student');
  const { rows: groups } = await query(
    `SELECT g.id, g.name FROM pa_groups g JOIN pa_group_members m ON m.group_id = g.id
      WHERE m.user_id = $1 ORDER BY lower(g.name)`,
    [student.id],
  );
  const profile = await skillProfile(student.id, { institutionId: inst(req) });
  const { rows: sessions } = await query(
    `SELECT s.id, s.status, s.kind, s.assignment_id, s.started_at, s.completed_at,
            s.rw_scaled, s.math_scaled, s.total_scaled, s.practice->>'mode' AS practice_mode,
            COALESCE(e.title, s.title) AS title, e.kind AS exam_kind,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id)::int AS responses,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id AND r.correct)::int AS correct
       FROM pa_sessions s LEFT JOIN pa_exams e ON e.id = s.exam_id
      WHERE s.user_id = $1 AND s.institution_id = $2
      ORDER BY s.started_at DESC LIMIT 200`,
    [student.id, inst(req)],
  );
  const { rows: assigned } = await query(
    `SELECT DISTINCT ON (a.id) a.*, e.title AS exam_title, e.scope, g.name AS group_name,
            CASE WHEN e.kind = 'fixed' THEN ${formCountSql('e')} END AS custom_count,
            s.id AS session_id, s.status AS session_status
       FROM pa_assignments a
       LEFT JOIN pa_exams e ON e.id = a.exam_id
       LEFT JOIN pa_groups g ON g.id = a.group_id
       LEFT JOIN pa_sessions s ON s.assignment_id = a.id AND s.user_id = $1
      WHERE a.institution_id = $2
        AND (a.user_id = $1 OR a.group_id IN (SELECT group_id FROM pa_group_members WHERE user_id = $1))
      ORDER BY a.id, (s.status = 'completed') DESC NULLS LAST, s.started_at DESC NULLS LAST`,
    [student.id, inst(req)],
  );
  res.json({
    student: publicUser(student),
    groups,
    profile,
    sessions: sessions.map((s) => ({
      sessionId: s.id, status: s.status, kind: s.kind, assigned: Boolean(s.assignment_id),
      practiceMode: s.practice_mode, custom: s.exam_kind === 'fixed', title: s.title, startedAt: s.started_at, completedAt: s.completed_at,
      rwScaled: s.rw_scaled, mathScaled: s.math_scaled, totalScaled: s.total_scaled,
      questionCount: s.responses, correct: s.correct,
    })),
    assignments: assigned
      .sort((a, b) => b.created_at - a.created_at)
      .map((a) => ({
        id: a.id, kind: a.kind, title: assignmentTitle(a), scope: a.scope, practice: a.practice, custom: a.custom_count != null,
        via: a.target_type === 'group' ? a.group_name : null, hidden: a.hidden, dueAt: a.due_at, createdAt: a.created_at,
        status: a.session_status || 'not_started', sessionId: a.session_id || null,
        questionCount: a.kind === 'practice'
          ? skillSetSize(a.practice?.skills || [], a.practice?.perSkill)
          : (a.scope ? testSize(a.scope) : a.custom_count ?? null),
      })),
  });
}));

// ============================== Groups =====================================

router.get('/groups', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, COUNT(m.user_id)::int AS member_count
       FROM pa_groups g LEFT JOIN pa_group_members m ON m.group_id = g.id
      WHERE g.institution_id = $1
      GROUP BY g.id ORDER BY g.created_at DESC`,
    [inst(req)],
  );
  res.json({
    groups: rows.map((g) => ({
      id: g.id, name: g.name, description: g.description,
      memberCount: g.member_count, createdAt: g.created_at,
    })),
  });
}));

router.post('/groups', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1), description: z.string().optional().default('') }), req.body);
  const { rows } = await query(
    'INSERT INTO pa_groups (name, description, institution_id) VALUES ($1, $2, $3) RETURNING *',
    [d.name, d.description, inst(req)],
  );
  res.status(201).json({ group: { id: rows[0].id, name: rows[0].name, description: rows[0].description, memberCount: 0 } });
}));

router.patch('/groups/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1).optional(), description: z.string().optional() }), req.body);
  const { rows } = await query(
    `UPDATE pa_groups SET name = COALESCE($1, name), description = COALESCE($2, description)
      WHERE id = $3 AND institution_id = $4 RETURNING *`,
    [d.name ?? null, d.description ?? null, req.params.id, inst(req)],
  );
  if (!rows[0]) throw notFound('group');
  res.json({ group: rows[0] });
}));

router.delete('/groups/:id', asyncHandler(async (req, res) => {
  const r = await query('DELETE FROM pa_groups WHERE id = $1 AND institution_id = $2', [req.params.id, inst(req)]);
  if (!r.rowCount) throw notFound('group');
  res.json({ ok: true });
}));

async function assertGroupOwned(groupId, institutionId) {
  const g = await query('SELECT id FROM pa_groups WHERE id = $1 AND institution_id = $2', [groupId, institutionId]);
  if (!g.rows.length) throw notFound('group');
}

router.get('/groups/:id/members', asyncHandler(async (req, res) => {
  await assertGroupOwned(req.params.id, inst(req));
  const { rows } = await query(
    `SELECT u.* FROM pa_group_members m JOIN pa_users u ON u.id = m.user_id
      WHERE m.group_id = $1 ORDER BY u.display_name`,
    [req.params.id],
  );
  res.json({ members: rows.map(publicUser) });
}));

// Add one student (userId) or many (userIds) to a group in a single call.
router.post('/groups/:id/members', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ userId: z.string().uuid().optional(), userIds: z.array(z.string().uuid()).optional() }),
    req.body,
  );
  await assertGroupOwned(req.params.id, inst(req));
  const ids = d.userIds && d.userIds.length ? d.userIds : (d.userId ? [d.userId] : []);
  if (!ids.length) throw badRequest('No students given');

  // Keep only students that belong to this institution.
  const { rows: valid } = await query(
    "SELECT id FROM pa_users WHERE id = ANY($1::uuid[]) AND institution_id = $2 AND role = 'student'",
    [ids, inst(req)],
  );
  if (!valid.length) throw badRequest('No matching students in your institution');
  const validIds = valid.map((r) => r.id);

  const already = await query(
    'SELECT COUNT(*)::int AS n FROM pa_group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
    [req.params.id, validIds],
  );
  await query(
    `INSERT INTO pa_group_members (group_id, user_id)
     SELECT $1, x FROM unnest($2::uuid[]) AS x
     ON CONFLICT DO NOTHING`,
    [req.params.id, validIds],
  );
  res.json({ ok: true, added: validIds.length - already.rows[0].n, selected: validIds.length });
}));

router.delete('/groups/:id/members/:userId', asyncHandler(async (req, res) => {
  await assertGroupOwned(req.params.id, inst(req));
  await query('DELETE FROM pa_group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
  res.json({ ok: true });
}));

// ============================ Blueprints ===================================
// Global templates (institution_id IS NULL) plus any the institution authored.

router.get('/blueprints', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM pa_blueprints
      WHERE institution_id IS NULL OR institution_id = $1
      ORDER BY is_default DESC, created_at DESC`,
    [inst(req)],
  );
  res.json({ blueprints: rows });
}));

router.post('/blueprints', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ name: z.string().min(1), description: z.string().optional().default(''), spec: z.any() }),
    req.body,
  );
  const { rows } = await query(
    'INSERT INTO pa_blueprints (name, description, spec, institution_id) VALUES ($1, $2, $3::jsonb, $4) RETURNING *',
    [d.name, d.description, JSON.stringify(d.spec), inst(req)],
  );
  res.status(201).json({ blueprint: rows[0] });
}));

router.delete('/blueprints/:id', asyncHandler(async (req, res) => {
  const used = await query('SELECT 1 FROM pa_exams WHERE blueprint_id = $1 LIMIT 1', [req.params.id]);
  if (used.rows.length) throw conflict('Blueprint is in use by an exam');
  const r = await query('DELETE FROM pa_blueprints WHERE id = $1 AND institution_id = $2', [req.params.id, inst(req)]);
  if (!r.rowCount) throw notFound('blueprint (or it is a global template)');
  res.json({ ok: true });
}));

// ============================== Exams ======================================

router.get('/exams', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, b.name AS blueprint_name,
            COALESCE(
              (SELECT array_agg(m.folder_id) FROM pa_exam_folder_members m WHERE m.exam_id = e.id),
              '{}'
            ) AS folder_ids
       FROM pa_exams e LEFT JOIN pa_blueprints b ON b.id = e.blueprint_id
      WHERE e.institution_id = $1
      ORDER BY e.created_at DESC`,
    [inst(req)],
  );
  res.json({
    exams: rows.map((e) => ({
      id: e.id, title: e.title, code: e.code, timingMode: e.timing_mode,
      kind: e.kind, active: e.active,
      locked: e.locked, unlocksAt: e.unlocks_at,
      blueprintId: e.blueprint_id,
      // The folders this exam is filed under (empty = "Ungrouped").
      folderIds: e.folder_ids || [],
      // A SAT test names its test and size; legacy blueprint exams keep their
      // blueprint name; a custom test (the academy's own questions) counts its
      // questions and names the sections it has.
      scope: e.scope,
      blueprintName: e.kind === 'sat' ? SAT_TESTS[e.scope] : e.kind === 'fixed' ? null : e.blueprint_name,
      questionCount: e.kind === 'sat' ? testSize(e.scope) : e.kind === 'fixed' ? countFormQuestions(e.form) : null,
      sections: e.kind === 'fixed' ? formSections(e.form) : null,
      createdAt: e.created_at,
    })),
    // Whether tests can be made from uploads or with AI right now, and the
    // domains and skills a custom question can be filed under.
    ai: await aiStatus(inst(req)),
    taxonomy: taxonomyTree(),
  });
}));

// A managed institution's SAT tests (kind 'sat'): the digital SAT or one of
// its sections, assembled anew for every attempt from the pool, exactly as a
// self-guided test is, so every student who is given it gets their own form.
const SAT_TESTS = { full: 'Full SAT', rw: 'Reading and Writing', math: 'Math' };

// File a just-created exam into folders. Create-time convenience mirroring
// PUT /exams/:id/folders: folders outside the institution are silently
// dropped; returns the ids actually filed.
async function fileExamInFolders(examId, folderIds, institutionId) {
  if (!folderIds || !folderIds.length) return [];
  const { rows } = await query(
    'SELECT id FROM pa_exam_folders WHERE id = ANY($1::uuid[]) AND institution_id = $2',
    [folderIds, institutionId],
  );
  const valid = rows.map((r) => r.id);
  if (valid.length) {
    await query(
      `INSERT INTO pa_exam_folder_members (folder_id, exam_id)
       SELECT x, $1 FROM unnest($2::uuid[]) AS x ON CONFLICT DO NOTHING`,
      [examId, valid],
    );
  }
  return valid;
}

// Create a SAT test (`kind: 'sat'` with a `scope`), or an empty custom test
// (`kind: 'fixed'`): the academy's own questions, which it then adds by hand,
// from an upload, or written by AI. A custom test is timed at the SAT's pace
// ('full') or untimed.
router.post('/exams', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({
      title: z.string().trim().min(1),
      code: z.string().optional(),
      kind: z.enum(['fixed', 'sat']).default('fixed'),
      scope: z.enum(['full', 'rw', 'math']).optional(),
      timingMode: z.enum(['full', 'untimed']).default('untimed'),
      folderIds: z.array(z.string().uuid()).optional(),
    }).refine((x) => x.kind !== 'sat' || x.scope, { message: 'Choose the full SAT or a section' }),
    req.body,
  );
  const code = (d.code && d.code.trim()) || `${slug(d.title)}-${rand()}`;
  const dupe = await query('SELECT id FROM pa_exams WHERE code = $1 AND institution_id = $2', [code, inst(req)]);
  if (dupe.rows.length) throw conflict('An exam with that code already exists');
  const sat = d.kind === 'sat';
  const { rows } = await query(
    `INSERT INTO pa_exams (title, code, blueprint_id, kind, scope, form, timing_mode, institution_id)
     VALUES ($1, $2, NULL, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
    [d.title, code, d.kind, sat ? d.scope : null, sat ? null : JSON.stringify(emptyFixedForm()), d.timingMode, inst(req)],
  );
  const folderIds = await fileExamInFolders(rows[0].id, d.folderIds, inst(req));
  res.status(201).json({ exam: shapeNewExam(rows[0], folderIds) });
}));

/** A just-made test, in the shape GET /exams lists it. */
function shapeNewExam(e, folderIds) {
  const sat = e.kind === 'sat';
  return {
    id: e.id, title: e.title, code: e.code, timingMode: e.timing_mode, kind: e.kind, scope: e.scope,
    active: e.active, locked: e.locked, unlocksAt: e.unlocks_at,
    blueprintName: sat ? SAT_TESTS[e.scope] : null,
    questionCount: sat ? testSize(e.scope) : countFormQuestions(e.form),
    sections: sat ? null : formSections(e.form),
    folderIds,
  };
}

// What every custom test is made with: a title, its timing and its folders.
// From an upload these come as multipart fields (folder ids as a JSON list).
const customTestSchema = z.object({
  title: z.string().trim().min(1, 'Give the test a title.'),
  timingMode: z.enum(['full', 'untimed']).default('untimed'),
  folderIds: z.array(z.string().uuid()).optional(),
});

/**
 * Make a custom test of these question rows: each goes into this academy's
 * own bank (private to it, so a result counts toward the student's skills)
 * and into the test, in the module it came from. Nothing is made when no row
 * can be served.
 */
async function createCustomTest(req, d, rows) {
  const code = `${slug(d.title)}-${rand()}`;
  const { rows: made } = await query(
    `INSERT INTO pa_exams (title, code, blueprint_id, kind, form, timing_mode, institution_id)
     VALUES ($1, $2, NULL, 'fixed', $3::jsonb, $4, $5) RETURNING id`,
    [d.title, code, JSON.stringify(emptyFixedForm()), d.timingMode, inst(req)],
  );
  const examId = made[0].id;
  const added = await addRowsToExam(examId, inst(req), rows);
  if (!added.appended) {
    await query('DELETE FROM pa_exams WHERE id = $1', [examId]);
    throw badRequest('None of those questions could be used: each needs four answer choices, or an answer to enter.');
  }
  const folderIds = await fileExamInFolders(examId, d.folderIds, inst(req));
  const { rows: exam } = await query('SELECT * FROM pa_exams WHERE id = $1', [examId]);
  return { exam: shapeNewExam(exam[0], folderIds), questions: added.appended };
}

/** Multipart sends a list as JSON text; anything unreadable is no list. */
function listField(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Hide/show an exam from students, rename it, or change its timing. Hidden
// exams stay visible to the admin but disappear from every student's
// assignment list. A new timing applies to attempts started after it.
router.patch('/exams/:id', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({
      active: z.boolean().optional(),
      title: z.string().trim().min(1).optional(),
      timingMode: z.enum(['full', 'untimed']).optional(),
      // Release control: lock/unlock, with an optional automatic unlock moment.
      // Unlocking always clears any scheduled time so it can't linger stale.
      locked: z.boolean().optional(),
      unlocksAt: z.string().datetime({ offset: true }).nullable().optional(),
    }),
    req.body,
  );
  const sets = [];
  const params = [];
  let i = 1;
  if (d.active !== undefined) { sets.push(`active = $${i++}`); params.push(d.active); }
  if (d.title !== undefined) { sets.push(`title = $${i++}`); params.push(d.title); }
  if (d.timingMode !== undefined) { sets.push(`timing_mode = $${i++}`); params.push(d.timingMode); }
  if (d.locked !== undefined) { sets.push(`locked = $${i++}`); params.push(d.locked); }
  if (d.locked === false) { sets.push('unlocks_at = NULL'); }
  else if (d.unlocksAt !== undefined) { sets.push(`unlocks_at = $${i++}`); params.push(d.unlocksAt); }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(req.params.id, inst(req));
  const { rows } = await query(
    `UPDATE pa_exams SET ${sets.join(', ')} WHERE id = $${i++} AND institution_id = $${i}
     RETURNING id, title, active, locked, unlocks_at, timing_mode`,
    params,
  );
  if (!rows[0]) throw notFound('exam');
  const e = rows[0];
  res.json({ exam: { id: e.id, title: e.title, active: e.active, locked: e.locked, unlocksAt: e.unlocks_at, timingMode: e.timing_mode } });
}));

// A custom test from uploaded images or PDFs (a whole practice test works):
// the model reads out every question, using the file's answer key when it has
// one, and the test serves exactly those, the same to every student.
router.post('/exams/from-upload', upload.array('files'), asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw badRequest('Choose at least one file to upload.');
  const d = parseBody(customTestSchema, {
    title: req.body.title, timingMode: req.body.timingMode || undefined, folderIds: listField(req.body.folderIds),
  });
  const section = ['Math', 'English'].includes(req.body.section) ? req.body.section : '';
  const creds = await resolveCreds(req);
  const { rows: extracted, notes } = await extractFromUploads(files, { creds, section });
  if (!extracted.length) {
    throw badRequest(`No questions could be read from ${files.length === 1 ? 'that file' : 'those files'}.${notes.length ? ` (${notes.join('; ')})` : ''}`);
  }
  res.status(201).json({ ...await createCustomTest(req, d, extracted), notes });
}));

// What AI writes in one go: questions of one section and domain (one skill of
// it, or a looser focus, when `topic` names one), at one difficulty.
const aiSchema = z.object({
  section: z.enum(['rw', 'math']),
  domain: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  n: z.number().int().min(1).max(20).default(5),
  topic: z.string().trim().max(200).optional().default(''),
});

/** Have the model write questions; the ones its own independent check confirmed. */
async function writeWithAI(req, d) {
  if (!isValidDomain(d.section, d.domain)) throw badRequest('Choose a domain of that section.');
  const results = await generateQuestions({
    section: d.section, domain: d.domain, difficulty: d.difficulty, n: d.n, topic: d.topic, creds: await resolveCreds(req),
  });
  const verified = results.filter((r) => r.status === 'verified').map((r) => r.row);
  return { verified, flagged: results.length - verified.length };
}

// A custom test of questions AI writes. Every draft is solved again
// independently and kept only when that check agrees on the answer and the
// skill (lib/generate.js), so the test can come out shorter than asked.
router.post('/exams/from-ai', asyncHandler(async (req, res) => {
  const d = parseBody(customTestSchema.merge(aiSchema), req.body);
  const { verified, flagged } = await writeWithAI(req, d);
  if (!verified.length) {
    throw badRequest(flagged
      ? 'None of the questions passed the answer check, so no test was made. Try again.'
      : 'The AI returned no usable questions, so no test was made. Try again.');
  }
  res.status(201).json({ ...await createCustomTest(req, d, verified), requested: d.n, flagged });
}));

// What makes a question servable: four filled, distinct choices, or an answer
// to enter; and a domain and skill of its section, so a result counts toward
// the student's skills.
function checkQuestion(d, section) {
  if (!isValidDomain(section, d.domain)) throw badRequest('Choose a domain of the question\'s section.');
  if (!canonicalSkill(d.domain, d.skill)) throw badRequest('Choose the skill the question tests.');
  if (d.answerType === 'grid-in') {
    if (section !== 'math') throw badRequest('Only a Math question can have an answer to enter.');
    if (!String(d.answerText || '').trim()) throw badRequest('Enter the correct answer.');
    return;
  }
  const choices = (d.choices || []).map((c) => String(c ?? '').trim());
  if (choices.length !== 4 || choices.some((c) => !c)) throw badRequest('Fill in all four answer choices.');
  if (new Set(choices.map((c) => c.toLowerCase())).size < 4) throw badRequest('The four answer choices must differ.');
}

const questionFields = {
  domain: z.string(),
  skill: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  passage: z.string().optional().nullable(),
  question: z.string().trim().min(1, 'Write the question.'),
  answerType: z.enum(['multiple-choice', 'grid-in']).default('multiple-choice'),
  choices: z.array(z.string()).optional(),
  correctIdx: z.number().int().min(0).max(3).optional(),
  answerText: z.string().optional().nullable(),
  // Why the answer is right. Explanations of each choice stay as long as the
  // choices and the answer do.
  explanation: z.string().optional().default(''),
};

// Edit one question of a custom test. The edit is this test's copy of it; the
// question's classification (domain, skill, difficulty) also goes to the
// academy's bank, where each student's skill map reads it.
router.patch('/exams/:id/question', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ qid: z.string().min(1), ...questionFields }), req.body);
  const { rows } = await query(
    "SELECT form FROM pa_exams WHERE id = $1 AND institution_id = $2 AND kind = 'fixed'",
    [req.params.id, inst(req)],
  );
  if (!rows[0] || !rows[0].form) throw notFound('fixed exam');
  const form = rows[0].form;

  let found = null;
  const apply = (q) => {
    if (q.qid !== d.qid) return q;
    checkQuestion(d, q.section);
    const isGrid = d.answerType === 'grid-in';
    const choices = isGrid ? [] : d.choices.map((c) => c.trim());
    const correctIdx = isGrid ? 0 : d.correctIdx ?? 0;
    const sameAnswer = !isGrid && q.answerType !== 'grid-in' && correctIdx === q.correctIdx
      && choices.every((c, i) => c === String(q.choices?.[i] ?? '').trim());
    const old = q.rationale || {};
    const perChoice = sameAnswer ? Object.fromEntries(['A', 'B', 'C', 'D'].filter((k) => old[k]).map((k) => [k, old[k]])) : {};
    const { answerText: _answer, accepted: _accepted, ...rest } = q;
    const answerText = isGrid ? String(d.answerText).trim() : null;
    found = {
      ...rest,
      domain: d.domain,
      skill: canonicalSkill(d.domain, d.skill),
      difficulty: d.difficulty,
      question: d.question,
      passage: q.section === 'rw' ? (d.passage ? String(d.passage).trim() : null) : null,
      answerType: isGrid ? 'grid-in' : 'multiple-choice',
      choices,
      correctIdx,
      // An edited answer replaces the source's list of accepted entries.
      ...(isGrid ? { answerText, accepted: answerText === q.answerText ? q.accepted || [] : [] } : {}),
      rationale: { ...perChoice, correct: d.explanation.trim() },
    };
    return found;
  };
  for (const s of form.sections || []) {
    for (const m of s.modules || []) {
      if (m.questions) m.questions = m.questions.map(apply);
      if (m.variants) {
        m.variants.easy = (m.variants.easy || []).map(apply);
        m.variants.hard = (m.variants.hard || []).map(apply);
      }
    }
  }
  if (!found) throw notFound('question');

  await query('UPDATE pa_exams SET form = $1::jsonb WHERE id = $2 AND institution_id = $3', [JSON.stringify(form), req.params.id, inst(req)]);
  // Never a pool question (one can be in a test when an upload matched it exactly).
  if (found.itemId) {
    await query(
      `UPDATE pa_items SET domain = $1, skill = $2, difficulty = $3
        WHERE id = $4 AND institution_id = $5 AND NOT (source = ANY($6::text[]))`,
      [found.domain, found.skill, found.difficulty, found.itemId, inst(req), POOL_SOURCES],
    );
  }
  res.json({ question: found });
}));

// ----- Add questions to a custom test (by hand / with AI / from an upload) --
// Each goes into the academy's own bank (lib/examForm.js) and into the test.

router.post('/exams/:id/questions/manual', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({
    section: z.enum(['rw', 'math']), module: z.number().int().min(1).max(2).optional(), ...questionFields,
  }), req.body);
  checkQuestion(d, d.section);
  const result = await addRowsToExam(req.params.id, inst(req), [manualRow(d)], { module: d.module });
  if (!result) throw notFound('exam');
  if (!result.appended) throw conflict('That question is already in this test.');
  res.status(201).json({ appended: result.appended });
}));

router.post('/exams/:id/questions/generate', asyncHandler(async (req, res) => {
  const d = parseBody(aiSchema.extend({ module: z.number().int().min(1).max(2).optional() }), req.body);
  const { verified, flagged } = await writeWithAI(req, d);
  const result = await addRowsToExam(req.params.id, inst(req), verified, { module: d.module });
  if (!result) throw notFound('exam');
  res.json({ requested: d.n, verified: verified.length, flagged, appended: result.appended });
}));

// Parse an upload section+module target ("rw:1" | "math:2"); '' = auto-detect.
function parseTarget(raw) {
  const m = /^(rw|math):(1|2)$/.exec((raw || '').toString());
  return m ? { kind: m[1], module: Number(m[2]) } : null;
}

router.post('/exams/:id/questions/upload', upload.array('files'), asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw badRequest('Choose at least one file to upload.');
  const creds = await resolveCreds(req);
  const target = parseTarget(req.body.target);
  const section = target ? (target.kind === 'math' ? 'Math' : 'English') : '';
  const { rows: extracted, notes } = await extractFromUploads(files, { creds, section, target });
  if (!extracted.length) {
    throw badRequest(`No questions could be read from ${files.length === 1 ? 'that file' : 'those files'}.${notes.length ? ` (${notes.join('; ')})` : ''}`);
  }
  // Each extracted row already carries its module (forced by target, or detected).
  const result = await addRowsToExam(req.params.id, inst(req), extracted);
  if (!result) throw notFound('exam');
  res.status(201).json({ extracted: extracted.length, appended: result.appended, notes });
}));

// Move questions to another module within their own section (R&W↔R&W, Math↔Math).
router.post('/exams/:id/questions/move', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ qids: z.array(z.string().min(1)).min(1), module: z.number().int().min(1).max(2) }),
    req.body,
  );
  const result = await moveQuestionsToModule(req.params.id, inst(req), d.qids, d.module);
  if (!result) throw notFound('exam');
  res.json(result);
}));

// Remove a single question from a fixed exam's stored form.
router.delete('/exams/:id/questions/:qid', asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT form FROM pa_exams WHERE id = $1 AND institution_id = $2 AND kind = 'fixed'",
    [req.params.id, inst(req)],
  );
  if (!rows[0] || !rows[0].form) throw notFound('fixed exam');
  const form = rows[0].form;
  let removed = false;
  const drop = (qs) => (qs || []).filter((q) => {
    if (q.qid === req.params.qid) { removed = true; return false; }
    return true;
  });
  for (const s of form.sections || []) {
    s.modules = (s.modules || []).map((m) => {
      if (m.questions) m.questions = drop(m.questions);
      if (m.variants) {
        m.variants.easy = drop(m.variants.easy);
        m.variants.hard = drop(m.variants.hard);
      }
      return m;
    });
  }
  if (!removed) throw notFound('question');
  await query('UPDATE pa_exams SET form = $1::jsonb WHERE id = $2 AND institution_id = $3', [JSON.stringify(form), req.params.id, inst(req)]);
  res.json({ ok: true });
}));

// Preview the SAT questions an exam produces. Exams materialize a unique form
// per attempt, so this assembles ONE representative form from the blueprint
// (sampling the bank only - no generation, no token spend) and returns it WITH
// answers, for the admin to inspect what students will be tested on.
router.get('/exams/:id/preview', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.title, e.timing_mode, e.kind, e.scope, e.form, b.spec
       FROM pa_exams e LEFT JOIN pa_blueprints b ON b.id = e.blueprint_id
      WHERE e.id = $1 AND e.institution_id = $2`,
    [req.params.id, inst(req)],
  );
  if (!rows[0]) throw notFound('exam');
  const exam = rows[0];

  const form = exam.kind === 'fixed' && exam.form
    ? exam.form
    : await materializeForm(exam.kind === 'sat' ? sectionSpec(exam.scope) : exam.spec, { institutionId: inst(req), buildTemplates: false });
  const sections = form.sections.map((s) => ({
    kind: s.kind,
    name: s.name,
    modules: s.modules.map((m) => (
      m.adaptive
        ? {
            ordinal: m.ordinal,
            adaptive: true,
            groups: [
              { label: 'Easier second module', questions: m.variants.easy },
              { label: 'Harder second module', questions: m.variants.hard },
            ],
          }
        : { ordinal: m.ordinal, adaptive: false, groups: [{ label: null, questions: m.questions }] }
    )),
  }));
  res.json({ title: rows[0].title, timingMode: rows[0].timing_mode, sections, notes: form.meta?.notes || [] });
}));

// Delete an exam and everything that hangs off it. pa_sessions.exam_id is ON
// DELETE RESTRICT, so any student attempt would otherwise block the delete -
// clear the sessions first (their responses cascade), inside a transaction.
// Assignments cascade automatically.
router.delete('/exams/:id', asyncHandler(async (req, res) => {
  const deleted = await tx(async (client) => {
    await client.query(
      'DELETE FROM pa_sessions WHERE exam_id = $1 AND institution_id = $2',
      [req.params.id, inst(req)],
    );
    const r = await client.query(
      'DELETE FROM pa_exams WHERE id = $1 AND institution_id = $2',
      [req.params.id, inst(req)],
    );
    return r.rowCount;
  });
  if (!deleted) throw notFound('exam');
  res.json({ ok: true });
}));

// =========================== Exam folders ==================================
// Institution-scoped named containers for organizing exams. Many-to-many: an
// exam may sit in several folders; an exam in none is "Ungrouped". Deleting a
// folder leaves its exams untouched (membership rows cascade away).

router.get('/exam-folders', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.name, f.parent_id, f.created_at,
            (SELECT COUNT(*)::int FROM pa_exam_folder_members m WHERE m.folder_id = f.id) AS exam_count
       FROM pa_exam_folders f
      WHERE f.institution_id = $1
      ORDER BY f.name ASC`,
    [inst(req)],
  );
  res.json({
    folders: rows.map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, examCount: f.exam_count, createdAt: f.created_at })),
  });
}));

router.post('/exam-folders', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1), parentId: z.string().uuid().nullable().optional() }), req.body);
  const name = d.name.trim();
  const parentId = d.parentId || null;
  if (parentId) {
    const p = await query('SELECT parent_id FROM pa_exam_folders WHERE id = $1 AND institution_id = $2', [parentId, inst(req)]);
    if (!p.rows.length) throw notFound('parent folder');
    if (p.rows[0].parent_id) throw badRequest('Folders can only nest one level deep');
  }
  // Names must be unique among siblings (same parent, or both top-level).
  const dupe = await query(
    'SELECT id FROM pa_exam_folders WHERE lower(name) = lower($1) AND institution_id = $2 AND parent_id IS NOT DISTINCT FROM $3',
    [name, inst(req), parentId],
  );
  if (dupe.rows.length) throw conflict('A folder with that name already exists here');
  const { rows } = await query(
    'INSERT INTO pa_exam_folders (name, parent_id, institution_id) VALUES ($1, $2, $3) RETURNING *',
    [name, parentId, inst(req)],
  );
  res.status(201).json({ folder: { id: rows[0].id, name: rows[0].name, parentId: rows[0].parent_id, examCount: 0, createdAt: rows[0].created_at } });
}));

router.patch('/exam-folders/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1) }), req.body);
  const name = d.name.trim();
  // Must exist in this institution; grab its parent to scope the dup check.
  const cur = await query('SELECT parent_id FROM pa_exam_folders WHERE id = $1 AND institution_id = $2', [req.params.id, inst(req)]);
  if (!cur.rows.length) throw notFound('folder');
  // No two folders may share a name at the same level (matches create), but a
  // folder never collides with itself (renaming to the same/again-cased name).
  const dupe = await query(
    'SELECT id FROM pa_exam_folders WHERE lower(name) = lower($1) AND institution_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND id <> $4',
    [name, inst(req), cur.rows[0].parent_id, req.params.id],
  );
  if (dupe.rows.length) throw conflict('A folder with that name already exists here');
  const { rows } = await query(
    'UPDATE pa_exam_folders SET name = $1 WHERE id = $2 AND institution_id = $3 RETURNING id, name, parent_id',
    [name, req.params.id, inst(req)],
  );
  res.json({ folder: { id: rows[0].id, name: rows[0].name, parentId: rows[0].parent_id } });
}));

router.delete('/exam-folders/:id', asyncHandler(async (req, res) => {
  const r = await query('DELETE FROM pa_exam_folders WHERE id = $1 AND institution_id = $2', [req.params.id, inst(req)]);
  if (!r.rowCount) throw notFound('folder');
  res.json({ ok: true });
}));

// Replace an exam's full folder membership in one call (fits the checkbox UI).
router.put('/exams/:id/folders', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ folderIds: z.array(z.string().uuid()).default([]) }), req.body);
  await tx(async (client) => {
    const owned = await client.query(
      'SELECT id FROM pa_exams WHERE id = $1 AND institution_id = $2',
      [req.params.id, inst(req)],
    );
    if (!owned.rows.length) throw notFound('exam');

    // Keep only folders that belong to this institution.
    let valid = [];
    if (d.folderIds.length) {
      const { rows } = await client.query(
        'SELECT id FROM pa_exam_folders WHERE id = ANY($1::uuid[]) AND institution_id = $2',
        [d.folderIds, inst(req)],
      );
      valid = rows.map((r) => r.id);
    }

    await client.query('DELETE FROM pa_exam_folder_members WHERE exam_id = $1', [req.params.id]);
    if (valid.length) {
      await client.query(
        `INSERT INTO pa_exam_folder_members (folder_id, exam_id)
         SELECT x, $1 FROM unnest($2::uuid[]) AS x ON CONFLICT DO NOTHING`,
        [req.params.id, valid],
      );
    }
    return valid;
  });
  res.json({ ok: true });
}));

// Assign every exam in a folder (and its subfolders) to student groups and/or
// individual students in one shot. Pairs that already have an identical
// assignment (same exam, same target) are skipped, so re-assigning a folder
// after adding one exam only creates the missing rows.
router.post('/exam-folders/:id/assign', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({
      groupIds: z.array(z.string().uuid()).default([]),
      userIds: z.array(z.string().uuid()).default([]),
      dueAt: z.string().datetime().optional(),
    }),
    req.body,
  );
  if (!d.groupIds.length && !d.userIds.length) throw badRequest('Pick at least one group or student');

  const owned = await query(
    'SELECT id FROM pa_exam_folders WHERE id = $1 AND institution_id = $2',
    [req.params.id, inst(req)],
  );
  if (!owned.rows.length) throw notFound('folder');

  // Every exam filed in this folder or any of its subfolders (deduped).
  const { rows: examRows } = await query(
    `SELECT DISTINCT m.exam_id
       FROM pa_exam_folder_members m
      WHERE m.folder_id = $1
         OR m.folder_id IN (SELECT id FROM pa_exam_folders WHERE parent_id = $1)`,
    [req.params.id],
  );
  const examIds = examRows.map((r) => r.exam_id);
  if (!examIds.length) throw badRequest('This folder has no exams to assign');

  // Keep only targets that belong to this institution.
  const groupIds = d.groupIds.length
    ? (await query('SELECT id FROM pa_groups WHERE id = ANY($1::uuid[]) AND institution_id = $2', [d.groupIds, inst(req)])).rows.map((r) => r.id)
    : [];
  const userIds = d.userIds.length
    ? (await query("SELECT id FROM pa_users WHERE id = ANY($1::uuid[]) AND institution_id = $2 AND role = 'student'", [d.userIds, inst(req)])).rows.map((r) => r.id)
    : [];
  if (!groupIds.length && !userIds.length) throw badRequest('No matching groups or students in your institution');

  const dueAt = d.dueAt || null;
  const created = await tx(async (client) => {
    let n = 0;
    if (groupIds.length) {
      const r = await client.query(
        `INSERT INTO pa_assignments (exam_id, target_type, user_id, group_id, assigned_by, due_at, institution_id)
         SELECT p.exam_id, 'group', NULL, p.target_id, $3, $4, $5
           FROM (SELECT e.exam_id, g.target_id FROM unnest($1::uuid[]) AS e(exam_id) CROSS JOIN unnest($2::uuid[]) AS g(target_id)) p
          WHERE NOT EXISTS (
            SELECT 1 FROM pa_assignments a
             WHERE a.exam_id = p.exam_id AND a.target_type = 'group' AND a.group_id = p.target_id
          )`,
        [examIds, groupIds, req.user.sub, dueAt, inst(req)],
      );
      n += r.rowCount;
    }
    if (userIds.length) {
      const r = await client.query(
        `INSERT INTO pa_assignments (exam_id, target_type, user_id, group_id, assigned_by, due_at, institution_id)
         SELECT p.exam_id, 'user', p.target_id, NULL, $3, $4, $5
           FROM (SELECT e.exam_id, u.target_id FROM unnest($1::uuid[]) AS e(exam_id) CROSS JOIN unnest($2::uuid[]) AS u(target_id)) p
          WHERE NOT EXISTS (
            SELECT 1 FROM pa_assignments a
             WHERE a.exam_id = p.exam_id AND a.target_type = 'user' AND a.user_id = p.target_id
          )`,
        [examIds, userIds, req.user.sub, dueAt, inst(req)],
      );
      n += r.rowCount;
    }
    return n;
  });

  const pairs = examIds.length * (groupIds.length + userIds.length);
  res.status(201).json({ exams: examIds.length, targets: groupIds.length + userIds.length, created, skipped: pairs - created });
}));

// =========================== Assignments ===================================

router.get('/assignments', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, e.title AS exam_title, e.scope, u.display_name AS user_name, g.name AS group_name,
            (SELECT COUNT(DISTINCT s.user_id)::int FROM pa_sessions s
              WHERE s.assignment_id = a.id AND s.status = 'completed') AS completed_count,
            CASE WHEN a.target_type = 'group'
                 THEN (SELECT COUNT(*)::int FROM pa_group_members m WHERE m.group_id = a.group_id)
                 ELSE 1 END AS target_size
       FROM pa_assignments a
       LEFT JOIN pa_exams e ON e.id = a.exam_id
       LEFT JOIN pa_users u ON u.id = a.user_id
       LEFT JOIN pa_groups g ON g.id = a.group_id
      WHERE a.institution_id = $1
      ORDER BY a.created_at DESC`,
    [inst(req)],
  );
  res.json({
    assignments: rows.map((a) => ({
      id: a.id, kind: a.kind, examId: a.exam_id, title: assignmentTitle(a), scope: a.scope, practice: a.practice,
      targetType: a.target_type, targetId: a.user_id || a.group_id,
      targetName: a.user_name || a.group_name, hidden: a.hidden,
      dueAt: a.due_at, createdAt: a.created_at, completedCount: a.completed_count, targetSize: a.target_size,
    })),
  });
}));

// Per-assignment visibility: hide/show this exam for this group or student
// only - the exam itself and its other assignments are untouched.
router.patch('/assignments/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ hidden: z.boolean() }), req.body);
  const { rows } = await query(
    `UPDATE pa_assignments SET hidden = $1
      WHERE id = $2 AND institution_id = $3 RETURNING id, hidden`,
    [d.hidden, req.params.id, inst(req)],
  );
  if (!rows[0]) throw notFound('assignment');
  res.json({ assignment: rows[0] });
}));

// Give a test, or practice topics, to any number of students and groups at
// once: one assignment per target. Each student's attempt is their own
// (tests are assembled per attempt; practice is built from the student's
// record when they start it). A test already given to a target is skipped.
const assignSchema = z.object({
  kind: z.enum(['exam', 'practice']).default('exam'),
  examId: z.string().uuid().optional(),
  practice: z.object({
    skills: z.array(z.string()).min(1).max(MAX_SKILLS),
    difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
    perSkill: z.number().int().min(3).max(15).optional(),
  }).optional(),
  userIds: z.array(z.string().uuid()).default([]),
  groupIds: z.array(z.string().uuid()).default([]),
  dueAt: z.string().datetime().optional(),
}).refine((d) => (d.kind === 'exam' ? !!d.examId : !!d.practice), {
  message: 'A test assignment needs a test; a practice assignment needs skills',
});

router.post('/assignments', asyncHandler(async (req, res) => {
  const d = parseBody(assignSchema, req.body);
  let practice = null;
  if (d.kind === 'exam') {
    const exam = await query('SELECT id FROM pa_exams WHERE id = $1 AND institution_id = $2', [d.examId, inst(req)]);
    if (!exam.rows.length) throw badRequest('Unknown test');
  } else {
    const skills = [...new Set(d.practice.skills)].filter((s) => domainForSkill(s));
    if (!skills.length) throw badRequest('Choose at least one skill to practice.');
    practice = { skills, difficulty: d.practice.difficulty || null, ...(d.practice.perSkill ? { perSkill: d.practice.perSkill } : {}) };
  }
  // Only this institution's students and groups.
  const userIds = d.userIds.length
    ? (await query("SELECT id FROM pa_users WHERE id = ANY($1::uuid[]) AND institution_id = $2 AND role = 'student'", [d.userIds, inst(req)])).rows.map((r) => r.id)
    : [];
  const groupIds = d.groupIds.length
    ? (await query('SELECT id FROM pa_groups WHERE id = ANY($1::uuid[]) AND institution_id = $2', [d.groupIds, inst(req)])).rows.map((r) => r.id)
    : [];
  if (!userIds.length && !groupIds.length) throw badRequest('Pick at least one student or group from your academy.');

  const targets = [...userIds.map((id) => ['user', id]), ...groupIds.map((id) => ['group', id])];
  const created = await tx(async (client) => {
    let n = 0;
    for (const [type, id] of targets) {
      if (d.kind === 'exam') {
        const given = await client.query(
          `SELECT 1 FROM pa_assignments WHERE kind = 'exam' AND exam_id = $1 AND target_type = $2
              AND (user_id = $3 OR group_id = $3)`,
          [d.examId, type, id],
        );
        if (given.rows.length) continue;
      }
      await client.query(
        `INSERT INTO pa_assignments (kind, exam_id, practice, target_type, user_id, group_id, assigned_by, due_at, institution_id)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)`,
        [d.kind, d.kind === 'exam' ? d.examId : null, practice && JSON.stringify(practice), type,
          type === 'user' ? id : null, type === 'group' ? id : null, req.user.sub, d.dueAt || null, inst(req)],
      );
      n += 1;
    }
    return n;
  });
  res.status(201).json({ created, skipped: targets.length - created });
}));

router.delete('/assignments/:id', asyncHandler(async (req, res) => {
  const r = await query('DELETE FROM pa_assignments WHERE id = $1 AND institution_id = $2', [req.params.id, inst(req)]);
  if (!r.rowCount) throw notFound('assignment');
  res.json({ ok: true });
}));

// ============================== Results ====================================

router.get('/results', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id AS session_id, s.status, s.started_at, s.completed_at, s.kind, s.assignment_id,
            s.practice->>'mode' AS practice_mode, COALESCE(s.practice->>'mode', e.scope) AS scope,
            s.rw_scaled, s.math_scaled, s.total_scaled,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id)::int AS answered_total,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id AND r.correct)::int AS correct,
            u.id AS user_id, u.display_name, u.email, COALESCE(e.title, s.title) AS exam_title, e.kind AS exam_kind
       FROM pa_sessions s
       JOIN pa_users u ON u.id = s.user_id
       LEFT JOIN pa_exams e ON e.id = s.exam_id
      WHERE s.institution_id = $1
      ORDER BY s.started_at DESC LIMIT 500`,
    [inst(req)],
  );
  res.json({
    results: rows.map((r) => ({
      sessionId: r.session_id, status: r.status, kind: r.kind, practiceMode: r.practice_mode,
      // What the score is of: 'full', one section ('rw', 'math'), 'skills', or null (an older exam).
      // A custom test (the academy's own questions) is scored by the number correct.
      scope: r.scope, assigned: Boolean(r.assignment_id), custom: r.exam_kind === 'fixed',
      correct: r.correct, questionCount: r.answered_total,
      userId: r.user_id, studentName: r.display_name, studentEmail: r.email,
      examTitle: r.exam_title, startedAt: r.started_at, completedAt: r.completed_at,
      rwScaled: r.rw_scaled, mathScaled: r.math_scaled, totalScaled: r.total_scaled,
    })),
  });
}));

// Aggregate analytics for the institution.
router.get('/analytics', asyncHandler(async (req, res) => {
  const id = inst(req);
  const overall = (await query(
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*)::int AS attempts,
            round(avg(total_scaled) FILTER (WHERE status = 'completed' AND rw_scaled IS NOT NULL AND math_scaled IS NOT NULL))::int AS avg_total,
            round(avg(rw_scaled)    FILTER (WHERE status = 'completed'))::int AS avg_rw,
            round(avg(math_scaled)  FILTER (WHERE status = 'completed'))::int AS avg_math
       FROM pa_sessions WHERE institution_id = $1`,
    [id],
  )).rows[0];

  const byDomain = (await query(
    `SELECT i.section, i.domain,
            count(*)::int AS total,
            sum(CASE WHEN r.correct THEN 1 ELSE 0 END)::int AS correct
       FROM pa_responses r
       JOIN pa_sessions s ON s.id = r.session_id
       JOIN pa_items i ON i.id = r.item_id
      WHERE s.institution_id = $1
      GROUP BY i.section, i.domain
      ORDER BY i.section, i.domain`,
    [id],
  )).rows;

  const scores = (await query(
    `SELECT total_scaled FROM pa_sessions
      WHERE institution_id = $1 AND status = 'completed' AND total_scaled IS NOT NULL
      ORDER BY total_scaled`,
    [id],
  )).rows.map((r) => r.total_scaled);

  res.json({
    overall,
    scores,
    byDomain: byDomain.map((d) => ({
      section: d.section, domain: d.domain, total: d.total, correct: d.correct,
      accuracy: d.total ? Math.round((100 * d.correct) / d.total) : 0,
    })),
  });
}));

// Results as CSV (auth'd; the client fetches with the bearer token and downloads).
router.get('/results.csv', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.display_name, u.email, COALESCE(e.title, s.title) AS exam_title, s.status,
            s.total_scaled, s.rw_scaled, s.math_scaled, s.started_at, s.completed_at,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id)::int AS questions,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id AND r.correct)::int AS correct
       FROM pa_sessions s JOIN pa_users u ON u.id = s.user_id LEFT JOIN pa_exams e ON e.id = s.exam_id
      WHERE s.institution_id = $1 ORDER BY s.started_at DESC`,
    [inst(req)],
  );
  const esc = (v) => {
    const s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Student', 'Email', 'Exam', 'Status', 'Total', 'Reading and Writing', 'Math', 'Correct', 'Questions', 'Started', 'Completed'];
  const lines = [header.join(',')];
  for (const r of rows) {
    // One section is not a total score: the Total column stays empty for it.
    // A skill set or a custom test has no scaled score, only the number correct.
    const total = r.rw_scaled != null && r.math_scaled != null ? r.total_scaled : null;
    const done = r.status === 'completed';
    lines.push([r.display_name, r.email, r.exam_title, r.status, total, r.rw_scaled, r.math_scaled,
      done ? r.correct : null, done ? r.questions : null, r.started_at, r.completed_at].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="insat-results.csv"');
  res.send(lines.join('\n'));
}));

// Delete a single result/session - whether in-progress or completed. Responses
// cascade (pa_responses.session_id ON DELETE CASCADE).
router.delete('/results/:sessionId', asyncHandler(async (req, res) => {
  const r = await query(
    'DELETE FROM pa_sessions WHERE id = $1 AND institution_id = $2',
    [req.params.sessionId, inst(req)],
  );
  if (!r.rowCount) throw notFound('session');
  res.json({ ok: true });
}));

router.get('/results/:sessionId', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, u.display_name, COALESCE(e.title, s.title) AS exam_title
       FROM pa_sessions s JOIN pa_users u ON u.id = s.user_id LEFT JOIN pa_exams e ON e.id = s.exam_id
      WHERE s.id = $1 AND s.institution_id = $2`,
    [req.params.sessionId, inst(req)],
  );
  const s = rows[0];
  if (!s) throw notFound('session');
  res.json({
    results: {
      ...sessionResults(s),
      studentName: s.display_name,
      proctor: s.state?.proctor || null,
    },
  });
}));

// ======================== Question bank ====================================

router.use('/bank', bankRouter);

// ======================== Institution settings =============================

router.use('/settings', settingsRouter);

export default router;
