// Admin routes - institution-scoped. Every read filters by the caller's
// institution (req.user.inst) so an academy admin only ever sees and manages
// their own students, groups, exams, assignments, results, and question bank.
// Blueprints are global templates (institution_id null) shared by all.
//
// What the database used to cascade (ON DELETE CASCADE / SET NULL) is done
// here: deleting a group, test or assignment removes what hung off it.

import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import {
  COL, col, deleteWhere, getMany, getRow, newId, now, queryRows, rowsOf, whereIn, writeAll,
} from '../lib/store.js';
import { asyncHandler, parseBody, notFound, conflict, badRequest } from '../lib/http.js';
import { auth } from '../lib/firebase.js';
import { config } from '../lib/config.js';
import { createAccount, deleteAccount, setActive, setPassword } from '../lib/accounts.js';
import { publicUser } from './auth.js';
import { sessionResults } from '../lib/session.js';
import { LIST_FIELDS, listSessions, sessionFields, withExam } from '../lib/sessions.js';
import { materializeForm } from '../lib/assembly.js';
import { extractFromUploads } from '../lib/ingest.js';
import { manualRow } from '../lib/items.js';
import {
  addRowsToExam, moveQuestionsToModule, countFormQuestions, emptyFixedForm, fixedExam, formSections, saveForm,
} from '../lib/examForm.js';
import { generateQuestions } from '../lib/generate.js';
import { isValidDomain, domainForSkill, canonicalSkill, taxonomyTree } from '../lib/taxonomy.js';
import { aiStatus, getInstitutionCredentials } from '../lib/institutions.js';
import { POOL_SOURCES, bankRows, poolFor, touched } from '../lib/pool.js';
import { requireMode } from '../lib/modes.js';
import {
  skillProfile, sectionSpec, practiceTitle, testSize, skillSetSize, MAX_SKILLS,
} from '../lib/practice.js';
import { createInvite, inviteLink } from '../lib/invite.js';
import { sendInvite } from '../lib/mail.js';
import { multipart } from '../lib/upload.js';
import bankRouter from './bank.js';
import settingsRouter from './settings.js';

const router = Router();
const upload = multipart({ field: 'files', files: 20, fileSize: 25 * 1024 * 1024 });

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'exam';
const rand = () => Math.random().toString(36).slice(2, 6);
const inst = (req) => req.user.inst;
// A user's id: a UUID for an account an admin made, a Firebase uid for one
// its owner made by signing up.
const anId = z.string().min(1).max(128);
const byName = (a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase());
const newestFirst = (field) => (a, b) => (b[field]?.getTime?.() ?? 0) - (a[field]?.getTime?.() ?? 0);

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

/** A row of this institution's, or null (a row of another reads as absent). */
async function owned(name, id, institutionId) {
  const row = await getRow(name, id);
  return row && row.institution_id === institutionId ? row : null;
}

/** A student of this institution, or null. */
async function studentOf(id, institutionId) {
  const u = await owned(COL.users, id, institutionId);
  return u && u.role === 'student' ? u : null;
}

/** Only the ids that are students of this institution. */
async function studentsAmong(ids, institutionId) {
  return [...(await getMany(COL.users, ids)).values()]
    .filter((u) => u.institution_id === institutionId && u.role === 'student')
    .map((u) => u.id);
}

/** Only the ids that are groups of this institution. */
async function groupsAmong(ids, institutionId) {
  return [...(await getMany(COL.groups, ids)).values()].filter((g) => g.institution_id === institutionId).map((g) => g.id);
}

/** Delete assignments; their attempts stay, no longer linked to them. */
async function deleteAssignments(ids) {
  if (!ids.length) return;
  const attempts = await whereIn(COL.sessions, 'assignment_id', ids, [], ['assignment_id']);
  await writeAll([
    ...attempts.map((s) => ['update', col(COL.sessions).doc(s.id), { assignment_id: null }]),
    ...ids.map((id) => ['delete', col(COL.assignments).doc(id)]),
  ]);
}

// ============================== Users ======================================

// An institution admin only ever sees and manages STUDENTS in their own
// institution - never other admins (admin accounts are superadmin-managed).
router.get('/users', asyncHandler(async (req, res) => {
  const rows = await queryRows(col(COL.users).where('institution_id', '==', inst(req)).where('role', '==', 'student'));
  res.json({ users: rows.sort(newestFirst('created_at')).map(publicUser) });
}));

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(6).optional(), // omit to invite (link/email instead of a temp password)
});

router.post('/users', asyncHandler(async (req, res) => {
  const d = parseBody(createUserSchema, req.body);
  const user = await createAccount({
    email: d.email, displayName: d.displayName, password: d.password, role: 'student', institutionId: inst(req),
  });
  const link = inviteLink(await createInvite({ userId: user.id, email: user.email }));
  const instName = (await getRow(COL.institutions, inst(req)))?.name;
  const mail = await sendInvite(user.email, link, { role: 'student', institution: instName });
  res.status(201).json({ user: publicUser(user), inviteLink: link, emailed: mail.sent });
}));

const patchUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const d = parseBody(patchUserSchema, req.body);
  if (d.displayName === undefined && d.active === undefined && d.password === undefined) throw badRequest('Nothing to update');
  const student = await studentOf(req.params.id, inst(req));
  if (!student) throw notFound('student');
  if (d.displayName !== undefined) {
    await col(COL.users).doc(student.id).update({ display_name: d.displayName });
    await auth.updateUser(student.id, { displayName: d.displayName }).catch(() => {});
  }
  if (d.active !== undefined) await setActive(student.id, d.active);
  if (d.password !== undefined) await setPassword(student.id, d.password, { mustChange: true });
  res.json({ user: publicUser(await getRow(COL.users, student.id)) });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  // Scoped to students only - admins cannot delete other admins or themselves.
  if (!(await studentOf(req.params.id, inst(req)))) throw notFound('student');
  await deleteAccount(req.params.id);
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

/** A student's attempt at each assignment: the finished one first, else the latest. */
function attemptsByAssignment(sessions) {
  const best = new Map();
  for (const s of sessions) {
    if (!s.assignment_id) continue;
    const cur = best.get(s.assignment_id);
    const better = !cur || ((s.status === 'completed') !== (cur.status === 'completed')
      ? s.status === 'completed'
      : s.started_at > cur.started_at);
    if (better) best.set(s.assignment_id, s);
  }
  return best;
}

// One student, for their page (managed institutions): who they are and their
// groups, their skill map (with what there is to practise, for assigning
// topics), every test and practice set they started, and what is assigned to
// them, directly or through a group.
router.get('/users/:id/overview', managedOnly, asyncHandler(async (req, res) => {
  const student = await studentOf(req.params.id, inst(req));
  if (!student) throw notFound('student');
  const groups = (await queryRows(col(COL.groups).where('member_ids', 'array-contains', student.id)))
    .map((g) => ({ id: g.id, name: g.name }))
    .sort((a, b) => byName(a.name, b.name));
  const profile = await skillProfile(student.id, { institutionId: inst(req) });
  const sessions = (await listSessions([['user_id', '==', student.id], ['institution_id', '==', inst(req)]]))
    .sort(newestFirst('started_at')).slice(0, 200);
  const assigned = [
    ...await queryRows(col(COL.assignments).where('institution_id', '==', inst(req)).where('user_id', '==', student.id)),
    ...await whereIn(COL.assignments, 'group_id', groups.map((g) => g.id), [['institution_id', '==', inst(req)]]),
  ];
  const exams = await getMany(COL.exams, [...sessions, ...assigned].map((x) => x.exam_id).filter(Boolean));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const attempts = attemptsByAssignment(sessions);
  res.json({
    student: publicUser(student),
    groups,
    profile,
    sessions: sessions.map((s) => {
      const e = s.exam_id ? exams.get(s.exam_id) : null;
      return {
        sessionId: s.id, status: s.status, kind: s.kind, assigned: Boolean(s.assignment_id),
        practiceMode: s.practice?.mode ?? null, custom: e?.kind === 'fixed', title: e?.title ?? s.title,
        startedAt: s.started_at, completedAt: s.completed_at,
        rwScaled: s.rw_scaled, mathScaled: s.math_scaled, totalScaled: s.total_scaled,
        questionCount: s.response_count ?? 0, correct: s.correct_count ?? 0,
      };
    }),
    assignments: assigned
      .sort(newestFirst('created_at'))
      .map((a) => {
        const e = a.exam_id ? exams.get(a.exam_id) : null;
        const customCount = e?.kind === 'fixed' ? countFormQuestions(e.form) : null;
        const s = attempts.get(a.id);
        return {
          id: a.id, kind: a.kind, title: assignmentTitle({ ...a, exam_title: e?.title ?? null }), scope: e?.scope ?? null,
          practice: a.practice ?? null, custom: customCount != null,
          via: a.target_type === 'group' ? groupName.get(a.group_id) ?? null : null, hidden: a.hidden, dueAt: a.due_at,
          createdAt: a.created_at, status: s?.status || 'not_started', sessionId: s?.id || null,
          questionCount: a.kind === 'practice'
            ? skillSetSize(a.practice?.skills || [], a.practice?.perSkill)
            : (e?.scope ? testSize(e.scope) : customCount),
        };
      }),
  });
}));

// ============================== Groups =====================================

const groupRow = (g) => ({
  id: g.id, name: g.name, description: g.description, created_at: g.created_at, institution_id: g.institution_id,
});

router.get('/groups', asyncHandler(async (req, res) => {
  const rows = await queryRows(col(COL.groups).where('institution_id', '==', inst(req)));
  res.json({
    groups: rows.sort(newestFirst('created_at')).map((g) => ({
      id: g.id, name: g.name, description: g.description,
      memberCount: (g.member_ids || []).length, createdAt: g.created_at,
    })),
  });
}));

router.post('/groups', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1), description: z.string().optional().default('') }), req.body);
  const id = newId();
  await col(COL.groups).doc(id).set({
    name: d.name, description: d.description, institution_id: inst(req), created_at: now(), member_ids: [],
  });
  res.status(201).json({ group: { id, name: d.name, description: d.description, memberCount: 0 } });
}));

router.patch('/groups/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1).optional(), description: z.string().optional() }), req.body);
  const group = await owned(COL.groups, req.params.id, inst(req));
  if (!group) throw notFound('group');
  const changes = {};
  if (d.name !== undefined) changes.name = d.name;
  if (d.description !== undefined) changes.description = d.description;
  if (Object.keys(changes).length) await col(COL.groups).doc(group.id).update(changes);
  res.json({ group: groupRow({ ...group, ...changes }) });
}));

router.delete('/groups/:id', asyncHandler(async (req, res) => {
  const group = await owned(COL.groups, req.params.id, inst(req));
  if (!group) throw notFound('group');
  await deleteAssignments((await col(COL.assignments).where('group_id', '==', group.id).select().get()).docs.map((d) => d.id));
  await col(COL.groups).doc(group.id).delete();
  res.json({ ok: true });
}));

async function assertGroupOwned(groupId, institutionId) {
  const g = await owned(COL.groups, groupId, institutionId);
  if (!g) throw notFound('group');
  return g;
}

router.get('/groups/:id/members', asyncHandler(async (req, res) => {
  const group = await assertGroupOwned(req.params.id, inst(req));
  const members = [...(await getMany(COL.users, group.member_ids || [])).values()]
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  res.json({ members: members.map(publicUser) });
}));

// Add one student (userId) or many (userIds) to a group in a single call.
router.post('/groups/:id/members', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ userId: anId.optional(), userIds: z.array(anId).optional() }), req.body);
  const group = await assertGroupOwned(req.params.id, inst(req));
  const ids = d.userIds && d.userIds.length ? d.userIds : (d.userId ? [d.userId] : []);
  if (!ids.length) throw badRequest('No students given');

  // Keep only students that belong to this institution.
  const validIds = await studentsAmong(ids, inst(req));
  if (!validIds.length) throw badRequest('No matching students in your institution');
  const already = validIds.filter((id) => (group.member_ids || []).includes(id)).length;
  await col(COL.groups).doc(group.id).update({ member_ids: FieldValue.arrayUnion(...validIds) });
  res.json({ ok: true, added: validIds.length - already, selected: validIds.length });
}));

router.delete('/groups/:id/members/:userId', asyncHandler(async (req, res) => {
  const group = await assertGroupOwned(req.params.id, inst(req));
  await col(COL.groups).doc(group.id).update({ member_ids: FieldValue.arrayRemove(req.params.userId) });
  res.json({ ok: true });
}));

// ============================ Blueprints ===================================
// Global templates (institution_id null) plus any the institution authored.

router.get('/blueprints', asyncHandler(async (req, res) => {
  const rows = [
    ...await queryRows(col(COL.blueprints).where('institution_id', '==', null)),
    ...await queryRows(col(COL.blueprints).where('institution_id', '==', inst(req))),
  ].sort((a, b) => (b.is_default === true) - (a.is_default === true) || newestFirst('created_at')(a, b));
  res.json({ blueprints: rows });
}));

router.post('/blueprints', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({ name: z.string().min(1), description: z.string().optional().default(''), spec: z.any() }),
    req.body,
  );
  const id = newId();
  const row = { name: d.name, description: d.description, spec: d.spec, is_default: false, institution_id: inst(req), created_at: now() };
  await col(COL.blueprints).doc(id).set(row);
  res.status(201).json({ blueprint: { id, ...row } });
}));

router.delete('/blueprints/:id', asyncHandler(async (req, res) => {
  const used = await col(COL.exams).where('blueprint_id', '==', req.params.id).limit(1).select().get();
  if (!used.empty) throw conflict('Blueprint is in use by an exam');
  const bp = await owned(COL.blueprints, req.params.id, inst(req));
  if (!bp) throw notFound('blueprint (or it is a global template)');
  await col(COL.blueprints).doc(bp.id).delete();
  res.json({ ok: true });
}));

// ============================== Exams ======================================

// A managed institution's SAT tests (kind 'sat'): the digital SAT or one of
// its sections, assembled anew for every attempt from the pool, exactly as a
// self-guided test is, so every student who is given it gets their own form.
const SAT_TESTS = { full: 'Full SAT', rw: 'Reading and Writing', math: 'Math' };

router.get('/exams', asyncHandler(async (req, res) => {
  const rows = (await queryRows(col(COL.exams).where('institution_id', '==', inst(req)))).sort(newestFirst('created_at'));
  const blueprints = await getMany(COL.blueprints, rows.map((e) => e.blueprint_id).filter(Boolean), ['name']);
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
      blueprintName: e.kind === 'sat' ? SAT_TESTS[e.scope] : e.kind === 'fixed' ? null : blueprints.get(e.blueprint_id)?.name ?? null,
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

// File a just-created exam into folders. Create-time convenience mirroring
// PUT /exams/:id/folders: folders outside the institution are silently
// dropped; returns the ids actually filed.
async function fileExamInFolders(examId, folderIds, institutionId) {
  if (!folderIds || !folderIds.length) return [];
  const valid = [...(await getMany(COL.examFolders, folderIds)).values()]
    .filter((f) => f.institution_id === institutionId).map((f) => f.id);
  if (valid.length) await col(COL.exams).doc(examId).update({ folder_ids: FieldValue.arrayUnion(...valid) });
  return valid;
}

/** A new exam row, with the defaults the table had. */
function examRow(fields) {
  return {
    code: null, blueprint_id: null, timing_mode: 'full', active: true, kind: 'blueprint', form: null,
    locked: false, unlocks_at: null, scope: null, folder_ids: [], created_at: now(), ...fields,
  };
}

/** Write an exam (its form as JSON); its id. */
async function insertExam(fields) {
  const id = newId();
  const row = examRow(fields);
  await col(COL.exams).doc(id).set({ ...row, form: row.form ? JSON.stringify(row.form) : null });
  return { id, ...row };
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
      folderIds: z.array(anId).optional(),
    }).refine((x) => x.kind !== 'sat' || x.scope, { message: 'Choose the full SAT or a section' }),
    req.body,
  );
  const code = (d.code && d.code.trim()) || `${slug(d.title)}-${rand()}`;
  const dupe = await col(COL.exams).where('institution_id', '==', inst(req)).where('code', '==', code).limit(1).select().get();
  if (!dupe.empty) throw conflict('An exam with that code already exists');
  const sat = d.kind === 'sat';
  const exam = await insertExam({
    title: d.title, code, kind: d.kind, scope: sat ? d.scope : null, form: sat ? null : emptyFixedForm(),
    timing_mode: d.timingMode, institution_id: inst(req),
  });
  const folderIds = await fileExamInFolders(exam.id, d.folderIds, inst(req));
  res.status(201).json({ exam: shapeNewExam(exam, folderIds) });
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
  folderIds: z.array(anId).optional(),
});

/**
 * Make a custom test of these question rows: each goes into this academy's
 * own bank (private to it, so a result counts toward the student's skills)
 * and into the test, in the module it came from. Nothing is made when no row
 * can be served.
 */
async function createCustomTest(req, d, rows) {
  const code = `${slug(d.title)}-${rand()}`;
  const made = await insertExam({
    title: d.title, code, kind: 'fixed', form: emptyFixedForm(), timing_mode: d.timingMode, institution_id: inst(req),
  });
  const added = await addRowsToExam(made.id, inst(req), rows);
  if (!added.appended) {
    await col(COL.exams).doc(made.id).delete();
    throw badRequest('None of those questions could be used: each needs four answer choices, or an answer to enter.');
  }
  const folderIds = await fileExamInFolders(made.id, d.folderIds, inst(req));
  const exam = await getRow(COL.exams, made.id);
  return { exam: shapeNewExam(exam, folderIds), questions: added.appended };
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
  const changes = {};
  if (d.active !== undefined) changes.active = d.active;
  if (d.title !== undefined) changes.title = d.title;
  if (d.timingMode !== undefined) changes.timing_mode = d.timingMode;
  if (d.locked !== undefined) changes.locked = d.locked;
  if (d.locked === false) changes.unlocks_at = null;
  else if (d.unlocksAt !== undefined) changes.unlocks_at = d.unlocksAt ? new Date(d.unlocksAt) : null;
  if (!Object.keys(changes).length) throw badRequest('Nothing to update');
  const exam = await owned(COL.exams, req.params.id, inst(req));
  if (!exam) throw notFound('exam');
  await col(COL.exams).doc(exam.id).update(changes);
  const e = { ...exam, ...changes };
  res.json({ exam: { id: e.id, title: e.title, active: e.active, locked: e.locked, unlocksAt: e.unlocks_at, timingMode: e.timing_mode } });
}));

// A custom test from uploaded images or PDFs (a whole practice test works):
// the model reads out every question, using the file's answer key when it has
// one, and the test serves exactly those, the same to every student.
router.post('/exams/from-upload', upload, asyncHandler(async (req, res) => {
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
  const exam = await fixedExam(req.params.id, inst(req));
  if (!exam || !exam.form) throw notFound('fixed exam');
  const form = exam.form;

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

  await saveForm(exam.id, form);
  // Never a pool question (one can be in a test when an upload matched it exactly).
  if (found.itemId) {
    const item = await getRow(COL.items, found.itemId);
    if (item && item.institution_id === inst(req) && !POOL_SOURCES.includes(item.source)) {
      await col(COL.items).doc(item.id).update({
        domain: found.domain, skill: found.skill, difficulty: found.difficulty, ...touched(),
      });
    }
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

router.post('/exams/:id/questions/upload', upload, asyncHandler(async (req, res) => {
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
  const exam = await fixedExam(req.params.id, inst(req));
  if (!exam || !exam.form) throw notFound('fixed exam');
  const form = exam.form;
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
  await saveForm(exam.id, form);
  res.json({ ok: true });
}));

// Preview the SAT questions an exam produces. Exams materialize a unique form
// per attempt, so this assembles ONE representative form from the blueprint
// (sampling the bank only - no generation, no token spend) and returns it WITH
// answers, for the admin to inspect what students will be tested on.
router.get('/exams/:id/preview', asyncHandler(async (req, res) => {
  const exam = await owned(COL.exams, req.params.id, inst(req));
  if (!exam) throw notFound('exam');
  const spec = exam.kind === 'sat' ? sectionSpec(exam.scope)
    : exam.blueprint_id ? (await getRow(COL.blueprints, exam.blueprint_id))?.spec : null;

  const form = exam.kind === 'fixed' && exam.form
    ? exam.form
    : await materializeForm(spec, { institutionId: inst(req), buildTemplates: false });
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
  res.json({ title: exam.title, timingMode: exam.timing_mode, sections, notes: form.meta?.notes || [] });
}));

// Delete an exam and everything that hangs off it: every student attempt at
// it, and its assignments.
router.delete('/exams/:id', asyncHandler(async (req, res) => {
  const exam = await owned(COL.exams, req.params.id, inst(req));
  if (!exam) throw notFound('exam');
  await deleteWhere(col(COL.sessions).where('exam_id', '==', exam.id).where('institution_id', '==', inst(req)));
  await deleteAssignments((await col(COL.assignments).where('exam_id', '==', exam.id).select().get()).docs.map((d) => d.id));
  await col(COL.exams).doc(exam.id).delete();
  res.json({ ok: true });
}));

// =========================== Exam folders ==================================
// Institution-scoped named containers for organizing exams. Many-to-many: an
// exam may sit in several folders (its folder_ids); an exam in none is
// "Ungrouped". Deleting a folder leaves its exams untouched.

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

router.get('/exam-folders', asyncHandler(async (req, res) => {
  const folders = await queryRows(col(COL.examFolders).where('institution_id', '==', inst(req)));
  const exams = await col(COL.exams).where('institution_id', '==', inst(req)).select('folder_ids').get();
  const count = new Map();
  for (const d of exams.docs) for (const f of d.get('folder_ids') || []) count.set(f, (count.get(f) || 0) + 1);
  res.json({
    folders: folders
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, examCount: count.get(f.id) || 0, createdAt: f.created_at })),
  });
}));

router.post('/exam-folders', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1), parentId: anId.nullable().optional() }), req.body);
  const name = d.name.trim();
  const parentId = d.parentId || null;
  if (parentId) {
    const p = await owned(COL.examFolders, parentId, inst(req));
    if (!p) throw notFound('parent folder');
    if (p.parent_id) throw badRequest('Folders can only nest one level deep');
  }
  // Names must be unique among siblings (same parent, or both top-level).
  const siblings = await queryRows(col(COL.examFolders).where('institution_id', '==', inst(req)).where('parent_id', '==', parentId));
  if (siblings.some((f) => sameName(f.name, name))) throw conflict('A folder with that name already exists here');
  const id = newId();
  const row = { name, parent_id: parentId, institution_id: inst(req), created_at: now() };
  await col(COL.examFolders).doc(id).set(row);
  res.status(201).json({ folder: { id, name, parentId, examCount: 0, createdAt: row.created_at } });
}));

router.patch('/exam-folders/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ name: z.string().min(1) }), req.body);
  const name = d.name.trim();
  // Must exist in this institution; its parent scopes the dup check.
  const cur = await owned(COL.examFolders, req.params.id, inst(req));
  if (!cur) throw notFound('folder');
  // No two folders may share a name at the same level (matches create), but a
  // folder never collides with itself (renaming to the same/again-cased name).
  const siblings = await queryRows(col(COL.examFolders).where('institution_id', '==', inst(req)).where('parent_id', '==', cur.parent_id ?? null));
  if (siblings.some((f) => f.id !== cur.id && sameName(f.name, name))) throw conflict('A folder with that name already exists here');
  await col(COL.examFolders).doc(cur.id).update({ name });
  res.json({ folder: { id: cur.id, name, parentId: cur.parent_id ?? null } });
}));

router.delete('/exam-folders/:id', asyncHandler(async (req, res) => {
  const folder = await owned(COL.examFolders, req.params.id, inst(req));
  if (!folder) throw notFound('folder');
  // Its subfolders go with it; the exams stay, filed under neither.
  const subfolders = (await col(COL.examFolders).where('parent_id', '==', folder.id).select().get()).docs.map((d) => d.id);
  const gone = [folder.id, ...subfolders];
  const exams = (await col(COL.exams).where('institution_id', '==', inst(req)).select('folder_ids').get()).docs
    .filter((d) => (d.get('folder_ids') || []).some((f) => gone.includes(f)));
  await writeAll([
    ...exams.map((d) => ['update', d.ref, { folder_ids: FieldValue.arrayRemove(...gone) }]),
    ...gone.map((id) => ['delete', col(COL.examFolders).doc(id)]),
  ]);
  res.json({ ok: true });
}));

// Replace an exam's full folder membership in one call (fits the checkbox UI).
router.put('/exams/:id/folders', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ folderIds: z.array(anId).default([]) }), req.body);
  const exam = await owned(COL.exams, req.params.id, inst(req));
  if (!exam) throw notFound('exam');
  // Keep only folders that belong to this institution.
  const valid = d.folderIds.length
    ? [...(await getMany(COL.examFolders, d.folderIds)).values()].filter((f) => f.institution_id === inst(req)).map((f) => f.id)
    : [];
  await col(COL.exams).doc(exam.id).update({ folder_ids: valid });
  res.json({ ok: true });
}));

/** New assignments for the pairs not already given; the count made. */
async function assignPairs({ examIds, targets, assignedBy, dueAt, institutionId }) {
  const given = await whereIn(COL.assignments, 'exam_id', examIds, [['institution_id', '==', institutionId]]);
  const has = new Set(given.map((a) => `${a.exam_id}|${a.target_type}|${a.user_id || a.group_id}`));
  const ops = [];
  for (const examId of examIds) {
    for (const [type, id] of targets) {
      if (has.has(`${examId}|${type}|${id}`)) continue;
      has.add(`${examId}|${type}|${id}`);
      ops.push(['set', col(COL.assignments).doc(newId()), {
        kind: 'exam', exam_id: examId, practice: null, target_type: type,
        user_id: type === 'user' ? id : null, group_id: type === 'group' ? id : null,
        assigned_by: assignedBy, due_at: dueAt, created_at: now(), institution_id: institutionId, hidden: false,
      }]);
    }
  }
  await writeAll(ops);
  return ops.length;
}

// Assign every exam in a folder (and its subfolders) to student groups and/or
// individual students in one shot. Pairs that already have an identical
// assignment (same exam, same target) are skipped, so re-assigning a folder
// after adding one exam only creates the missing rows.
router.post('/exam-folders/:id/assign', asyncHandler(async (req, res) => {
  const d = parseBody(
    z.object({
      groupIds: z.array(anId).default([]),
      userIds: z.array(anId).default([]),
      dueAt: z.string().datetime().optional(),
    }),
    req.body,
  );
  if (!d.groupIds.length && !d.userIds.length) throw badRequest('Pick at least one group or student');

  const folder = await owned(COL.examFolders, req.params.id, inst(req));
  if (!folder) throw notFound('folder');

  // Every exam filed in this folder or any of its subfolders (deduped).
  const subfolders = (await col(COL.examFolders).where('parent_id', '==', folder.id).select().get()).docs.map((x) => x.id);
  const within = new Set([folder.id, ...subfolders]);
  const examIds = (await col(COL.exams).where('institution_id', '==', inst(req)).select('folder_ids').get()).docs
    .filter((x) => (x.get('folder_ids') || []).some((f) => within.has(f)))
    .map((x) => x.id);
  if (!examIds.length) throw badRequest('This folder has no exams to assign');

  // Keep only targets that belong to this institution.
  const groupIds = d.groupIds.length ? await groupsAmong(d.groupIds, inst(req)) : [];
  const userIds = d.userIds.length ? await studentsAmong(d.userIds, inst(req)) : [];
  if (!groupIds.length && !userIds.length) throw badRequest('No matching groups or students in your institution');

  const created = await assignPairs({
    examIds,
    targets: [...groupIds.map((id) => ['group', id]), ...userIds.map((id) => ['user', id])],
    assignedBy: req.user.sub,
    dueAt: d.dueAt ? new Date(d.dueAt) : null,
    institutionId: inst(req),
  });
  const pairs = examIds.length * (groupIds.length + userIds.length);
  res.status(201).json({ exams: examIds.length, targets: groupIds.length + userIds.length, created, skipped: pairs - created });
}));

// =========================== Assignments ===================================

router.get('/assignments', asyncHandler(async (req, res) => {
  const rows = (await queryRows(col(COL.assignments).where('institution_id', '==', inst(req)))).sort(newestFirst('created_at'));
  const exams = await getMany(COL.exams, rows.map((a) => a.exam_id).filter(Boolean), ['title', 'scope']);
  const users = await getMany(COL.users, rows.map((a) => a.user_id).filter(Boolean), ['display_name']);
  const groups = await getMany(COL.groups, rows.map((a) => a.group_id).filter(Boolean), ['name', 'member_ids']);
  const done = new Map();
  for (const s of await listSessions([['institution_id', '==', inst(req)], ['status', '==', 'completed']], ['assignment_id', 'user_id'])) {
    if (!s.assignment_id) continue;
    if (!done.has(s.assignment_id)) done.set(s.assignment_id, new Set());
    done.get(s.assignment_id).add(s.user_id);
  }
  res.json({
    assignments: rows.map((a) => {
      const e = a.exam_id ? exams.get(a.exam_id) : null;
      const g = a.group_id ? groups.get(a.group_id) : null;
      return {
        id: a.id, kind: a.kind, examId: a.exam_id, title: assignmentTitle({ ...a, exam_title: e?.title ?? null }),
        scope: e?.scope ?? null, practice: a.practice ?? null,
        targetType: a.target_type, targetId: a.user_id || a.group_id,
        targetName: (a.user_id && users.get(a.user_id)?.display_name) || g?.name || null, hidden: a.hidden,
        dueAt: a.due_at, createdAt: a.created_at, completedCount: done.get(a.id)?.size || 0,
        targetSize: a.target_type === 'group' ? (g?.member_ids || []).length : 1,
      };
    }),
  });
}));

// Per-assignment visibility: hide/show this exam for this group or student
// only - the exam itself and its other assignments are untouched.
router.patch('/assignments/:id', asyncHandler(async (req, res) => {
  const d = parseBody(z.object({ hidden: z.boolean() }), req.body);
  const a = await owned(COL.assignments, req.params.id, inst(req));
  if (!a) throw notFound('assignment');
  await col(COL.assignments).doc(a.id).update({ hidden: d.hidden });
  res.json({ assignment: { id: a.id, hidden: d.hidden } });
}));

// Give a test, or practice topics, to any number of students and groups at
// once: one assignment per target. Each student's attempt is their own
// (tests are assembled per attempt; practice is built from the student's
// record when they start it). A test already given to a target is skipped.
const assignSchema = z.object({
  kind: z.enum(['exam', 'practice']).default('exam'),
  examId: anId.optional(),
  practice: z.object({
    skills: z.array(z.string()).min(1).max(MAX_SKILLS),
    difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
    perSkill: z.number().int().min(3).max(15).optional(),
  }).optional(),
  userIds: z.array(anId).default([]),
  groupIds: z.array(anId).default([]),
  dueAt: z.string().datetime().optional(),
}).refine((d) => (d.kind === 'exam' ? !!d.examId : !!d.practice), {
  message: 'A test assignment needs a test; a practice assignment needs skills',
});

router.post('/assignments', asyncHandler(async (req, res) => {
  const d = parseBody(assignSchema, req.body);
  let practice = null;
  if (d.kind === 'exam') {
    if (!(await owned(COL.exams, d.examId, inst(req)))) throw badRequest('Unknown test');
  } else {
    const skills = [...new Set(d.practice.skills)].filter((s) => domainForSkill(s));
    if (!skills.length) throw badRequest('Choose at least one skill to practice.');
    practice = { skills, difficulty: d.practice.difficulty || null, ...(d.practice.perSkill ? { perSkill: d.practice.perSkill } : {}) };
  }
  // Only this institution's students and groups.
  const userIds = d.userIds.length ? await studentsAmong(d.userIds, inst(req)) : [];
  const groupIds = d.groupIds.length ? await groupsAmong(d.groupIds, inst(req)) : [];
  if (!userIds.length && !groupIds.length) throw badRequest('Pick at least one student or group from your academy.');

  const targets = [...userIds.map((id) => ['user', id]), ...groupIds.map((id) => ['group', id])];
  const dueAt = d.dueAt ? new Date(d.dueAt) : null;
  let created;
  if (d.kind === 'exam') {
    created = await assignPairs({ examIds: [d.examId], targets, assignedBy: req.user.sub, dueAt, institutionId: inst(req) });
  } else {
    await writeAll(targets.map(([type, id]) => ['set', col(COL.assignments).doc(newId()), {
      kind: 'practice', exam_id: null, practice, target_type: type,
      user_id: type === 'user' ? id : null, group_id: type === 'group' ? id : null,
      assigned_by: req.user.sub, due_at: dueAt, created_at: now(), institution_id: inst(req), hidden: false,
    }]));
    created = targets.length;
  }
  res.status(201).json({ created, skipped: targets.length - created });
}));

router.delete('/assignments/:id', asyncHandler(async (req, res) => {
  const a = await owned(COL.assignments, req.params.id, inst(req));
  if (!a) throw notFound('assignment');
  await deleteAssignments([a.id]);
  res.json({ ok: true });
}));

// ============================== Results ====================================

/** The institution's sessions, newest first, with their students and tests. */
async function institutionSessions(institutionId, { limit = null } = {}) {
  let q = col(COL.sessions).where('institution_id', '==', institutionId).orderBy('started_at', 'desc');
  if (limit) q = q.limit(limit);
  const sessions = rowsOf(await q.select(...LIST_FIELDS).get(), COL.sessions);
  const users = await getMany(COL.users, sessions.map((s) => s.user_id), ['display_name', 'email']);
  const exams = await getMany(COL.exams, sessions.map((s) => s.exam_id).filter(Boolean), ['title', 'kind', 'scope']);
  return sessions
    .filter((s) => users.has(s.user_id))
    .map((s) => ({ s, u: users.get(s.user_id), e: s.exam_id ? exams.get(s.exam_id) : null }));
}

router.get('/results', asyncHandler(async (req, res) => {
  const rows = await institutionSessions(inst(req), { limit: 500 });
  res.json({
    results: rows.map(({ s, u, e }) => ({
      sessionId: s.id, status: s.status, kind: s.kind, practiceMode: s.practice?.mode ?? null,
      // What the score is of: 'full', one section ('rw', 'math'), 'skills', or null (an older exam).
      // A custom test (the academy's own questions) is scored by the number correct.
      scope: s.practice?.mode ?? e?.scope ?? null, assigned: Boolean(s.assignment_id), custom: e?.kind === 'fixed',
      correct: s.correct_count ?? 0, questionCount: s.response_count ?? 0,
      userId: s.user_id, studentName: u.display_name, studentEmail: u.email,
      examTitle: e?.title ?? s.title, startedAt: s.started_at, completedAt: s.completed_at,
      rwScaled: s.rw_scaled, mathScaled: s.math_scaled, totalScaled: s.total_scaled,
    })),
  });
}));

const average = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// Aggregate analytics for the institution.
router.get('/analytics', asyncHandler(async (req, res) => {
  const id = inst(req);
  const sessions = await listSessions([['institution_id', '==', id]], ['status', 'rw_scaled', 'math_scaled', 'total_scaled', 'responses']);
  const done = sessions.filter((s) => s.status === 'completed');
  const overall = {
    completed: done.length,
    attempts: sessions.length,
    avg_total: average(done.filter((s) => s.rw_scaled != null && s.math_scaled != null && s.total_scaled != null).map((s) => s.total_scaled)),
    avg_rw: average(done.filter((s) => s.rw_scaled != null).map((s) => s.rw_scaled)),
    avg_math: average(done.filter((s) => s.math_scaled != null).map((s) => s.math_scaled)),
  };

  // Accuracy per domain of every question answered, as the bank files it now.
  const responses = sessions.flatMap((s) => s.responses || []).filter((r) => r.item_id);
  const known = await bankRows(await poolFor(id));
  const items = new Map();
  const rest = [];
  for (const itemId of new Set(responses.map((r) => r.item_id))) {
    if (known.has(itemId)) items.set(itemId, known.get(itemId));
    else rest.push(itemId);
  }
  for (const [itemId, r] of await getMany(COL.items, rest, ['section', 'domain'])) items.set(itemId, r);
  const byKey = new Map();
  for (const r of responses) {
    const item = items.get(r.item_id);
    if (!item) continue;
    const key = `${item.section}|${item.domain}`;
    if (!byKey.has(key)) byKey.set(key, { section: item.section, domain: item.domain, total: 0, correct: 0 });
    const g = byKey.get(key);
    g.total += 1;
    if (r.correct) g.correct += 1;
  }
  const byDomain = [...byKey.values()].sort((a, b) => (a.section + a.domain < b.section + b.domain ? -1 : 1));

  const scores = done.map((s) => s.total_scaled).filter((t) => t != null).sort((a, b) => a - b);

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
  const rows = await institutionSessions(inst(req));
  const esc = (v) => {
    const s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Student', 'Email', 'Exam', 'Status', 'Total', 'Reading and Writing', 'Math', 'Correct', 'Questions', 'Started', 'Completed'];
  const lines = [header.join(',')];
  for (const { s, u, e } of rows) {
    // One section is not a total score: the Total column stays empty for it.
    // A skill set or a custom test has no scaled score, only the number correct.
    const total = s.rw_scaled != null && s.math_scaled != null ? s.total_scaled : null;
    const done = s.status === 'completed';
    lines.push([u.display_name, u.email, e?.title ?? s.title, s.status, total, s.rw_scaled, s.math_scaled,
      done ? s.correct_count ?? 0 : null, done ? s.response_count ?? 0 : null, s.started_at, s.completed_at].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="insat-results.csv"');
  res.send(lines.join('\n'));
}));

// Delete a single result/session - whether in-progress or completed (its
// responses go with it).
router.delete('/results/:sessionId', asyncHandler(async (req, res) => {
  const s = await sessionFields(req.params.sessionId, ['institution_id']);
  if (!s || s.institution_id !== inst(req)) throw notFound('session');
  await col(COL.sessions).doc(s.id).delete();
  res.json({ ok: true });
}));

router.get('/results/:sessionId', asyncHandler(async (req, res) => {
  const s = await owned(COL.sessions, req.params.sessionId, inst(req));
  if (!s) throw notFound('session');
  const u = await getRow(COL.users, s.user_id);
  if (!u) throw notFound('session');
  const full = await withExam(s);
  res.json({
    results: {
      ...sessionResults(full),
      studentName: u.display_name,
      proctor: s.state?.proctor || null,
    },
  });
}));

// ======================== Question bank ====================================

router.use('/bank', bankRouter);

// ======================== Institution settings =============================

router.use('/settings', settingsRouter);

export default router;
