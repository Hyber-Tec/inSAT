// Student routes: list my assigned exams, start/resume an attempt (materializes
// a unique form), autosave progress, route Module 2 adaptively, and finish
// (scored server-side). The full form with answers stays on the server.
//
// Self-guided practice runs through the same sessions: a student starts a full
// test, one section, or a set built from chosen skills, and their per-skill
// profile says which skills to pick. In a managed institution (lib/modes.js)
// students start only what is assigned to them: tests, and practice topics
// built the same way as self-guided skill practice.

import { Router } from 'express';
import { z } from 'zod';
import { COL, col, getMany, getRow, queryRows, whereIn } from '../lib/store.js';
import { asyncHandler, parseBody, notFound, badRequest } from '../lib/http.js';
import { materializeForm, sanitizeForm } from '../lib/assembly.js';
import { sessionResults, responseRows, computeRouting } from '../lib/session.js';
import {
  answeredIn, createSession, listSessions, sessionFields, updateSession, withExam,
} from '../lib/sessions.js';
import {
  skillProfile, sectionSpec, skillsSpec, practiceTitle, testSize, skillSetSize, PRACTICE_MODES, MAX_SKILLS,
} from '../lib/practice.js';
import { requireMode } from '../lib/modes.js';
import { domainForSkill } from '../lib/taxonomy.js';
import { countFormQuestions, timedAtSatPace } from '../lib/examForm.js';

const router = Router();

// A practice session has no exam: its title and timing live on the session.
// A test's attempt keeps the timing the test had when it started (older
// attempts, from before that was kept, read the test's).
async function loadSession(sessionId, userId) {
  const s = await getRow(COL.sessions, sessionId);
  return s && s.user_id === userId ? withExam(s) : null;
}

/** The groups a student is in. */
const groupsOf = (userId) => queryRows(col(COL.groups).where('member_ids', 'array-contains', userId));

/** Everything assigned to a student, directly or through a group. */
async function assignmentsFor(userId, groupIds) {
  const direct = await queryRows(col(COL.assignments).where('user_id', '==', userId));
  const viaGroups = await whereIn(COL.assignments, 'group_id', groupIds);
  return [...new Map([...direct, ...viaGroups].map((a) => [a.id, a])).values()];
}

/** Whether a test is locked right now (a scheduled unlock may have passed). */
const lockedNow = (e) => Boolean(e?.locked && (!e.unlocks_at || e.unlocks_at > new Date()));

/** A student's attempt at each assignment: the finished one first, else the latest. */
function attemptsByAssignment(sessions) {
  const best = new Map();
  const better = (a, b) => (a.status === 'completed') !== (b.status === 'completed')
    ? a.status === 'completed'
    : a.started_at > b.started_at;
  for (const s of sessions) {
    if (!s.assignment_id) continue;
    const cur = best.get(s.assignment_id);
    if (!cur || better(s, cur)) best.set(s.assignment_id, s);
  }
  return best;
}

function sessionPayload(s) {
  return {
    sessionId: s.id,
    examId: s.exam_id,
    examTitle: s.exam_title,
    kind: s.kind,
    practice: s.practice || null,
    status: s.status,
    timingMode: s.timing_mode,
    form: sanitizeForm(s.form),
    state: s.state || {},
    routing: s.routing || {},
  };
}


// --- My assignments ---------------------------------------------------------
// Students may belong to several groups, so alongside the flat assignment list
// we return their memberships and tag each group-assigned exam with its group,
// letting the dashboard filter "which group am I looking at".

router.get('/assignments', asyncHandler(async (req, res) => {
  const me = req.user.sub;
  const groups = await groupsOf(me);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const all = (await assignmentsFor(me, groups.map((g) => g.id))).filter((a) => !a.hidden);
  const exams = await getMany(COL.exams, all.map((a) => a.exam_id).filter(Boolean));
  const attempts = attemptsByAssignment(await listSessions([['user_id', '==', me]]));
  // One entry per assignment, with my attempt at it (the finished one first).
  const rows = all
    .filter((a) => a.kind === 'practice' || exams.get(a.exam_id)?.active === true)
    .sort((a, b) => b.created_at - a.created_at);
  res.json({
    assignments: rows.map((a) => {
      const e = a.exam_id ? exams.get(a.exam_id) : null;
      const s = attempts.get(a.id) || null;
      const locked = a.kind === 'practice' ? null : lockedNow(e);
      const done = s?.status === 'completed';
      return {
        id: a.id,
        kind: a.kind,
        examId: e?.id ?? null,
        examTitle: a.kind === 'practice'
          ? practiceTitle('skills', a.practice?.skills || [], a.practice?.difficulty || null)
          : e?.title ?? null,
        scope: e?.scope ?? null,
        // A custom test (the academy's own questions) is scored by the number correct.
        custom: e?.kind === 'fixed',
        skills: a.practice?.skills || [],
        questionCount: a.kind === 'practice'
          ? skillSetSize(a.practice?.skills || [], a.practice?.perSkill)
          : (e?.scope ? testSize(e.scope) : e?.kind === 'fixed' ? countFormQuestions(e.form) : null),
        timingMode: a.kind === 'practice' ? 'untimed' : e?.timing_mode ?? null,
        dueAt: a.due_at,
        assignedVia: a.target_type,
        groupId: a.group_id,
        groupName: a.group_id ? groupName.get(a.group_id) ?? null : null,
        locked,
        unlocksAt: locked ? e.unlocks_at : null,
        status: s?.status || 'not_started',
        sessionId: s?.id || null,
        totalScaled: s?.total_scaled ?? null,
        rwScaled: s?.rw_scaled ?? null,
        mathScaled: s?.math_scaled ?? null,
        correct: done ? s.correct_count ?? 0 : null,
        answered: done ? s.response_count ?? 0 : null,
        completedAt: s?.completed_at ?? null,
      };
    }),
    groups: groups
      .map((g) => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  });
}));

// --- Start / resume an attempt ---------------------------------------------

router.post('/assignments/:id/start', asyncHandler(async (req, res) => {
  const me = req.user.sub;
  const assignment = await getRow(COL.assignments, req.params.id);
  const mine = assignment && !assignment.hidden && (assignment.user_id === me
    || (assignment.group_id && (await groupsOf(me)).some((g) => g.id === assignment.group_id)));
  if (!mine) throw notFound('assignment');
  const exam = assignment.exam_id ? await getRow(COL.exams, assignment.exam_id) : null;
  const practice = assignment.kind === 'practice';
  if (!practice && exam?.active === false) throw badRequest('This exam is not currently available.');
  if (!practice && lockedNow(exam)) {
    throw badRequest(exam.unlocks_at
      ? `This exam is locked until ${new Date(exam.unlocks_at).toLocaleString()}.`
      : 'This exam is locked. Your instructor will release it when it is time.');
  }

  // An assignment is done once: resume the attempt in progress, or hand back
  // the finished one for review.
  const open = (await listSessions([['user_id', '==', me], ['assignment_id', '==', req.params.id]], ['status', 'started_at']))
    .sort((a, b) => (b.status === 'in_progress') - (a.status === 'in_progress') || b.started_at - a.started_at);
  if (open[0]) {
    return res.json(sessionPayload(await loadSession(open[0].id, me)));
  }

  if (practice) {
    const p = await assemblePractice(me, req.user.inst, {
      mode: 'skills', skills: assignment.practice?.skills || [],
      difficulty: assignment.practice?.difficulty || null, perSkill: assignment.practice?.perSkill,
    });
    const id = await createSession({
      assignment_id: req.params.id, exam_id: null, user_id: me, form: p.form, institution_id: req.user.inst,
      kind: 'practice', title: p.title, timing_mode: p.timingMode, practice: p.practice,
    });
    return res.json(sessionPayload(await loadSession(id, me)));
  }

  // A custom test serves its own stored form: the same questions for
  // everyone, timed at the SAT's pace unless it is untimed. A SAT test, or a
  // legacy blueprint exam, is assembled anew for each attempt (so every
  // student gets their own form).
  let form;
  if (exam?.kind === 'fixed' && exam.form) {
    if (!countFormQuestions(exam.form)) throw badRequest('This test has no questions yet. Let your instructor know.');
    form = exam.timing_mode === 'untimed' ? exam.form : timedAtSatPace(exam.form);
  } else {
    let spec = exam?.kind === 'sat' ? sectionSpec(exam.scope) : null;
    if (!spec) {
      const bp = exam?.blueprint_id ? await getRow(COL.blueprints, exam.blueprint_id) : null;
      if (!bp) throw notFound('blueprint');
      spec = bp.spec;
    }
    form = await materializeForm(spec, { userId: me, institutionId: req.user.inst });
    if (!servedCount(form) || form.sections.some((sec) => sec.modules.some(emptyModule))) {
      throw badRequest('Not enough questions are available for this test yet. Let your instructor know.');
    }
  }
  const id = await createSession({
    assignment_id: req.params.id, exam_id: assignment.exam_id, user_id: me, form,
    institution_id: req.user.inst, timing_mode: exam?.timing_mode ?? null,
  });
  res.json(sessionPayload(await loadSession(id, me)));
}));

router.get('/sessions/:id', asyncHandler(async (req, res) => {
  const s = await loadSession(req.params.id, req.user.sub);
  if (!s) throw notFound('session');
  res.json(sessionPayload(s));
}));

// Autosave progress (answers / marked / crossed / position) for resume.
router.patch('/sessions/:id/state', asyncHandler(async (req, res) => {
  const { state } = parseBody(z.object({ state: z.any() }), req.body);
  const s = await sessionFields(req.params.id, ['user_id', 'status']);
  if (!s || s.user_id !== req.user.sub || s.status !== 'in_progress') throw notFound('active session');
  await updateSession(s.id, { state: state || {} });
  res.json({ ok: true });
}));

// Decide the Module-2 route for a section from Module-1 answers.
router.post('/sessions/:id/route', asyncHandler(async (req, res) => {
  const { sectionKind, state } = parseBody(
    z.object({ sectionKind: z.enum(['rw', 'math']), state: z.any().optional() }),
    req.body,
  );
  const s = await loadSession(req.params.id, req.user.sub);
  if (!s) throw notFound('session');
  const mergedState = state || s.state || {};
  const route = computeRouting(s.form, mergedState.answers || {}, sectionKind, s.form.routing?.thresholdFraction);
  const routing = { ...(s.routing || {}), [sectionKind]: route };
  await updateSession(s.id, { state: mergedState, routing });
  res.json({ routing: route });
}));

// Finish and score the attempt.
router.post('/sessions/:id/finish', asyncHandler(async (req, res) => {
  const { state } = parseBody(z.object({ state: z.any().optional() }), req.body);
  const s = await loadSession(req.params.id, req.user.sub);
  if (!s) throw notFound('session');

  const mergedState = state || s.state || {};
  const answers = mergedState.answers || {};
  const threshold = s.form.routing?.thresholdFraction ?? 0.6;
  const routing = { ...(s.routing || {}) };
  for (const kind of ['rw', 'math']) {
    if (s.form.sections.some((sec) => sec.kind === kind) && !routing[kind]) {
      routing[kind] = computeRouting(s.form, answers, kind, threshold);
    }
  }

  const results = sessionResults(s, mergedState, routing);
  const rw = results.sections.find((x) => x.kind === 'rw');
  const math = results.sections.find((x) => x.kind === 'math');

  // One response per question served, kept on the session.
  const responses = responseRows(s.form, mergedState, routing).map((r) => ({
    q_instance_id: r.qInstanceId, item_id: r.itemId, module_key: r.moduleKey, selected_idx: r.selectedIdx,
    selected_text: r.selectedText ?? null, correct: r.correct, is_marked: r.isMarked,
  }));
  await updateSession(s.id, {
    state: mergedState, routing, status: 'completed',
    rw_scaled: rw?.scaled ?? null, math_scaled: math?.scaled ?? null, total_scaled: results.totalScaled,
    completed_at: new Date(), responses,
    response_count: responses.length, correct_count: responses.filter((r) => r.correct).length,
  });

  res.json({ results });
}));

router.get('/sessions/:id/results', asyncHandler(async (req, res) => {
  const s = await loadSession(req.params.id, req.user.sub);
  if (!s) throw notFound('session');
  if (s.status !== 'completed') throw badRequest('Session not completed');
  res.json({ results: sessionResults(s) });
}));

// --- Self-guided practice ----------------------------------------------------

// Accuracy per College Board skill across everything this student has
// finished, with what there is to practise in each.
router.get('/profile', asyncHandler(async (req, res) => {
  res.json(await skillProfile(req.user.sub, { institutionId: req.user.inst }));
}));

/** Questions a student will actually see: Module 1 plus one Module 2 route. */
function servedCount(form) {
  let n = 0;
  for (const sec of form.sections) {
    for (const m of sec.modules) {
      n += m.adaptive
        ? Math.max(m.variants.easy.length, m.variants.hard.length)
        : m.questions.length;
    }
  }
  return n;
}

/** A module with nothing to serve (an adaptive one needs both of its routes). */
function emptyModule(m) {
  return m.adaptive ? !m.variants.easy.length || !m.variants.hard.length : !m.questions.length;
}

/** What each requested part came up short by, in words a student can use. */
function shortfalls(spec, form, skills) {
  const out = [];
  if (skills.length) {
    const got = new Map();
    for (const sec of form.sections) {
      for (const m of sec.modules) for (const q of m.questions || []) got.set(q.skill, (got.get(q.skill) || 0) + 1);
    }
    for (const sec of spec.sections) {
      for (const [skill, want] of Object.entries(sec.modules[0].skills)) {
        const have = got.get(skill) || 0;
        if (have < want.n) out.push({ skill, have, want: want.n });
      }
    }
    return out;
  }
  spec.sections.forEach((sec, i) => {
    const built = form.sections[i];
    sec.modules.forEach((mod, j) => {
      const m = built.modules[j];
      const have = m.adaptive ? Math.min(m.variants.easy.length, m.variants.hard.length) : m.questions.length;
      if (have < mod.count) out.push({ section: sec.name, module: mod.ordinal, have, want: mod.count });
    });
  });
  return out;
}

/**
 * Assemble a practice set: a full test or one section exactly as the SAT runs
 * it, or about a dozen questions over chosen skills, each at the difficulty
 * the student's record calls for unless one is set. A 400 the student can read
 * when the pool cannot serve it.
 */
async function assemblePractice(me, institutionId, { mode, skills = [], difficulty = null, perSkill, timed = true }) {
  let spec;
  let chosen = [];
  if (mode === 'skills') {
    chosen = [...new Set(skills)].filter((x) => domainForSkill(x));
    if (!chosen.length) throw badRequest('Choose at least one skill to practice.');
    spec = skillsSpec(chosen, await skillProfile(me), { difficulty, perSkill });
  } else {
    spec = sectionSpec(mode);
  }

  const form = await materializeForm(spec, { userId: me, institutionId });
  const short = shortfalls(spec, form, chosen);
  if (mode === 'skills') {
    // A skill set spans up to two sections; one with nothing to serve is left out.
    form.sections = form.sections.filter((sec) => !sec.modules.every(emptyModule));
  }
  if (!servedCount(form) || form.sections.some((sec) => sec.modules.some(emptyModule))) {
    const what = mode === 'skills'
      ? (chosen.length === 1 ? chosen[0] : 'these skills')
      : { full: 'a full practice test', rw: 'Reading and Writing', math: 'Math' }[mode];
    const level = mode === 'skills' && difficulty ? ` at ${difficulty} difficulty` : '';
    throw badRequest(`Not enough questions are available for ${what}${level} yet.`);
  }

  return {
    form,
    title: practiceTitle(mode, chosen, difficulty),
    timingMode: mode === 'skills' || timed === false ? 'untimed' : 'full',
    practice: { mode, skills: chosen, difficulty: difficulty || null, questionCount: servedCount(form), short },
  };
}

const PracticeBody = z.object({
  mode: z.enum(Object.keys(PRACTICE_MODES)),
  skills: z.array(z.string()).max(MAX_SKILLS).optional(),
  // Full tests and sections run on the SAT's clock unless the student opts out.
  timed: z.boolean().optional(),
  // A skill set at one difficulty; omitted, each skill follows the student's record.
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
});

// In a managed institution practice is assigned, not self-started.
const selfGuidedOnly = requireMode('self_guided', 'Your academy assigns your practice. Start it from what is assigned to you.');

router.post('/practice', selfGuidedOnly, asyncHandler(async (req, res) => {
  const me = req.user.sub;
  const d = parseBody(PracticeBody, req.body);
  const p = await assemblePractice(me, req.user.inst, { mode: d.mode, skills: d.skills || [], difficulty: d.difficulty || null, timed: d.timed });
  const id = await createSession({
    user_id: me, form: p.form, institution_id: req.user.inst,
    kind: 'practice', title: p.title, timing_mode: p.timingMode, practice: p.practice,
  });
  res.json(sessionPayload(await loadSession(id, me)));
}));

// My practice sessions, newest first: in-progress ones to resume, finished
// ones with their result, less any I discarded.
router.get('/practice', asyncHandler(async (req, res) => {
  const rows = (await listSessions([['user_id', '==', req.user.sub], ['kind', '==', 'practice']]))
    .filter((s) => !s.hidden_at)
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, 100);
  res.json({
    practice: rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      mode: r.practice?.mode || null,
      skills: r.practice?.skills || [],
      status: r.status,
      timingMode: r.timing_mode,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      questionCount: r.status === 'completed' ? r.response_count ?? 0 : (r.practice?.questionCount ?? null),
      answered: answeredIn(r.state),
      correct: r.status === 'completed' ? r.correct_count ?? 0 : null,
      totalScaled: r.total_scaled, rwScaled: r.rw_scaled, mathScaled: r.math_scaled,
    })),
  });
}));

// Discard a practice session. An unfinished one is deleted, so its questions go
// back to the pool for this student. A finished one only leaves the student's
// list: the profile is built on it, the academy sees it in Progress, and its
// questions stay seen.
router.delete('/practice/:id', selfGuidedOnly, asyncHandler(async (req, res) => {
  const s = await sessionFields(req.params.id, ['user_id', 'kind', 'status', 'hidden_at']);
  if (!s || s.user_id !== req.user.sub || s.kind !== 'practice') throw notFound('practice session');
  if (s.status === 'in_progress') await col(COL.sessions).doc(s.id).delete();
  else if (s.status === 'completed' && !s.hidden_at) await updateSession(s.id, { hidden_at: new Date() });
  else throw notFound('practice session');
  res.json({ ok: true });
}));

export default router;
