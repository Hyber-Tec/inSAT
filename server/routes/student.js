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
import { query, tx } from '../lib/db.js';
import { asyncHandler, parseBody, notFound, badRequest } from '../lib/http.js';
import { materializeForm, sanitizeForm } from '../lib/assembly.js';
import { sessionResults, responseRows, computeRouting } from '../lib/session.js';
import {
  skillProfile, sectionSpec, skillsSpec, practiceTitle, testSize, skillSetSize, PRACTICE_MODES, MAX_SKILLS,
} from '../lib/practice.js';
import { requireMode } from '../lib/modes.js';
import { domainForSkill } from '../lib/taxonomy.js';
import { countFormQuestions, formCountSql, timedAtSatPace } from '../lib/examForm.js';

const router = Router();

// A practice session has no exam: its title and timing live on the session.
// A test's attempt keeps the timing the test had when it started (older
// attempts, from before that was kept, read the test's).
async function loadSession(sessionId, userId) {
  const { rows } = await query(
    `SELECT s.*, COALESCE(s.timing_mode, e.timing_mode, 'untimed') AS timing_mode,
            COALESCE(e.title, s.title) AS exam_title
       FROM pa_sessions s LEFT JOIN pa_exams e ON e.id = s.exam_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  );
  return rows[0] || null;
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
  // One row per assignment, with my attempt at it (the finished one first).
  const { rows } = await query(
    `SELECT DISTINCT ON (a.id) a.id, a.kind, a.practice, a.due_at, a.created_at, a.target_type, a.group_id,
            g.name AS group_name,
            e.id AS exam_id, e.title AS exam_title, e.timing_mode, e.scope, e.unlocks_at, e.kind AS exam_kind,
            CASE WHEN e.kind = 'fixed' THEN ${formCountSql('e')} END AS custom_count,
            (e.locked AND (e.unlocks_at IS NULL OR e.unlocks_at > now())) AS locked_now,
            s.id AS session_id, s.status AS session_status, s.completed_at,
            s.total_scaled, s.rw_scaled, s.math_scaled,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id)::int AS responses,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id AND r.correct)::int AS correct
       FROM pa_assignments a
       LEFT JOIN pa_exams e ON e.id = a.exam_id
       LEFT JOIN pa_groups g ON g.id = a.group_id
       LEFT JOIN pa_sessions s ON s.assignment_id = a.id AND s.user_id = $1
      WHERE (a.kind = 'practice' OR e.active = true)
        AND a.hidden = false
        AND (a.user_id = $1
             OR a.group_id IN (SELECT group_id FROM pa_group_members WHERE user_id = $1))
      ORDER BY a.id, (s.status = 'completed') DESC NULLS LAST, s.started_at DESC NULLS LAST`,
    [me],
  );
  rows.sort((a, b) => b.created_at - a.created_at);
  const { rows: groups } = await query(
    `SELECT g.id, g.name
       FROM pa_groups g JOIN pa_group_members m ON m.group_id = g.id
      WHERE m.user_id = $1
      ORDER BY lower(g.name)`,
    [me],
  );
  res.json({
    assignments: rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      examId: a.exam_id,
      examTitle: a.kind === 'practice'
        ? practiceTitle('skills', a.practice?.skills || [], a.practice?.difficulty || null)
        : a.exam_title,
      scope: a.scope,
      // A custom test (the academy's own questions) is scored by the number correct.
      custom: a.exam_kind === 'fixed',
      skills: a.practice?.skills || [],
      questionCount: a.kind === 'practice'
        ? skillSetSize(a.practice?.skills || [], a.practice?.perSkill)
        : (a.scope ? testSize(a.scope) : a.custom_count ?? null),
      timingMode: a.kind === 'practice' ? 'untimed' : a.timing_mode,
      dueAt: a.due_at,
      assignedVia: a.target_type,
      groupId: a.group_id,
      groupName: a.group_name,
      locked: a.locked_now,
      unlocksAt: a.locked_now ? a.unlocks_at : null,
      status: a.session_status || 'not_started',
      sessionId: a.session_id || null,
      totalScaled: a.total_scaled ?? null,
      rwScaled: a.rw_scaled ?? null,
      mathScaled: a.math_scaled ?? null,
      correct: a.session_status === 'completed' ? a.correct : null,
      answered: a.session_status === 'completed' ? a.responses : null,
      completedAt: a.completed_at,
    })),
    groups,
  });
}));

// --- Start / resume an attempt ---------------------------------------------

router.post('/assignments/:id/start', asyncHandler(async (req, res) => {
  const me = req.user.sub;
  const { rows: arows } = await query(
    `SELECT a.*, e.blueprint_id, e.kind AS exam_kind, e.scope, e.form AS exam_form, e.timing_mode AS exam_timing,
            e.active, e.unlocks_at,
            (e.locked AND (e.unlocks_at IS NULL OR e.unlocks_at > now())) AS locked_now
       FROM pa_assignments a LEFT JOIN pa_exams e ON e.id = a.exam_id
      WHERE a.id = $1 AND a.hidden = false
        AND (a.user_id = $2 OR a.group_id IN (SELECT group_id FROM pa_group_members WHERE user_id = $2))`,
    [req.params.id, me],
  );
  const assignment = arows[0];
  if (!assignment) throw notFound('assignment');
  const practice = assignment.kind === 'practice';
  if (!practice && assignment.active === false) throw badRequest('This exam is not currently available.');
  if (!practice && assignment.locked_now) {
    throw badRequest(assignment.unlocks_at
      ? `This exam is locked until ${new Date(assignment.unlocks_at).toLocaleString()}.`
      : 'This exam is locked. Your instructor will release it when it is time.');
  }

  // An assignment is done once: resume the attempt in progress, or hand back
  // the finished one for review.
  const { rows: open } = await query(
    `SELECT id FROM pa_sessions
      WHERE assignment_id = $1 AND user_id = $2
      ORDER BY (status = 'in_progress') DESC, started_at DESC LIMIT 1`,
    [req.params.id, me],
  );
  if (open[0]) {
    return res.json(sessionPayload(await loadSession(open[0].id, me)));
  }

  if (practice) {
    const p = await assemblePractice(me, req.user.inst, {
      mode: 'skills', skills: assignment.practice?.skills || [],
      difficulty: assignment.practice?.difficulty || null, perSkill: assignment.practice?.perSkill,
    });
    const { rows } = await query(
      `INSERT INTO pa_sessions (assignment_id, exam_id, user_id, form, state, routing, status, institution_id,
                                kind, title, timing_mode, practice)
       VALUES ($1, NULL, $2, $3::jsonb, '{}'::jsonb, '{}'::jsonb, 'in_progress', $4, 'practice', $5, $6, $7::jsonb)
       RETURNING id`,
      [req.params.id, me, JSON.stringify(p.form), req.user.inst, p.title, p.timingMode, JSON.stringify(p.practice)],
    );
    return res.json(sessionPayload(await loadSession(rows[0].id, me)));
  }

  // A custom test serves its own stored form: the same questions for
  // everyone, timed at the SAT's pace unless it is untimed. A SAT test, or a
  // legacy blueprint exam, is assembled anew for each attempt (so every
  // student gets their own form).
  let form;
  if (assignment.exam_kind === 'fixed' && assignment.exam_form) {
    if (!countFormQuestions(assignment.exam_form)) throw badRequest('This test has no questions yet. Let your instructor know.');
    form = assignment.exam_timing === 'untimed' ? assignment.exam_form : timedAtSatPace(assignment.exam_form);
  } else {
    let spec = assignment.exam_kind === 'sat' ? sectionSpec(assignment.scope) : null;
    if (!spec) {
      const { rows: bp } = await query('SELECT spec FROM pa_blueprints WHERE id = $1', [assignment.blueprint_id]);
      if (!bp[0]) throw notFound('blueprint');
      spec = bp[0].spec;
    }
    form = await materializeForm(spec, { userId: me, institutionId: req.user.inst });
    if (!servedCount(form) || form.sections.some((sec) => sec.modules.some(emptyModule))) {
      throw badRequest('Not enough questions are available for this test yet. Let your instructor know.');
    }
  }
  const { rows: srows } = await query(
    `INSERT INTO pa_sessions (assignment_id, exam_id, user_id, form, state, routing, status, institution_id, timing_mode)
     VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, '{}'::jsonb, 'in_progress', $5, $6) RETURNING id`,
    [req.params.id, assignment.exam_id, me, JSON.stringify(form), req.user.inst, assignment.exam_timing],
  );
  res.json(sessionPayload(await loadSession(srows[0].id, me)));
}));

router.get('/sessions/:id', asyncHandler(async (req, res) => {
  const s = await loadSession(req.params.id, req.user.sub);
  if (!s) throw notFound('session');
  res.json(sessionPayload(s));
}));

// Autosave progress (answers / marked / crossed / position) for resume.
router.patch('/sessions/:id/state', asyncHandler(async (req, res) => {
  const { state } = parseBody(z.object({ state: z.any() }), req.body);
  const r = await query(
    `UPDATE pa_sessions SET state = $1::jsonb
      WHERE id = $2 AND user_id = $3 AND status = 'in_progress'`,
    [JSON.stringify(state || {}), req.params.id, req.user.sub],
  );
  if (!r.rowCount) throw notFound('active session');
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
  await query('UPDATE pa_sessions SET state = $1::jsonb, routing = $2::jsonb WHERE id = $3 AND user_id = $4', [
    JSON.stringify(mergedState),
    JSON.stringify(routing),
    s.id,
    req.user.sub,
  ]);
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

  await tx(async (client) => {
    await client.query(
      `UPDATE pa_sessions
          SET state = $1::jsonb, routing = $2::jsonb, status = 'completed',
              rw_scaled = $3, math_scaled = $4, total_scaled = $5, completed_at = now()
        WHERE id = $6 AND user_id = $7`,
      [JSON.stringify(mergedState), JSON.stringify(routing), rw?.scaled ?? null, math?.scaled ?? null,
        results.totalScaled, s.id, req.user.sub],
    );
    await client.query('DELETE FROM pa_responses WHERE session_id = $1', [s.id]);
    for (const r of responseRows(s.form, mergedState, routing)) {
      await client.query(
        `INSERT INTO pa_responses (session_id, q_instance_id, item_id, module_key, selected_idx, selected_text, correct, is_marked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.id, r.qInstanceId, r.itemId, r.moduleKey, r.selectedIdx, r.selectedText ?? null, r.correct, r.isMarked],
      );
    }
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
  const { rows } = await query(
    `INSERT INTO pa_sessions (assignment_id, exam_id, user_id, form, state, routing, status, institution_id,
                              kind, title, timing_mode, practice)
     VALUES (NULL, NULL, $1, $2::jsonb, '{}'::jsonb, '{}'::jsonb, 'in_progress', $3, 'practice', $4, $5, $6::jsonb)
     RETURNING id`,
    [me, JSON.stringify(p.form), req.user.inst, p.title, p.timingMode, JSON.stringify(p.practice)],
  );
  res.json(sessionPayload(await loadSession(rows[0].id, me)));
}));

// My practice sessions, newest first: in-progress ones to resume, finished
// ones with their result, less any I discarded.
router.get('/practice', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.title, s.status, s.practice, s.timing_mode, s.started_at, s.completed_at,
            s.rw_scaled, s.math_scaled, s.total_scaled,
            (SELECT count(*) FROM jsonb_each(COALESCE(s.state->'answers', '{}'::jsonb)) a
              WHERE a.value NOT IN ('null'::jsonb, '""'::jsonb))::int AS answered,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id AND r.correct)::int AS correct,
            (SELECT count(*) FROM pa_responses r WHERE r.session_id = s.id)::int AS responses
       FROM pa_sessions s
      WHERE s.user_id = $1 AND s.kind = 'practice' AND s.hidden_at IS NULL
      ORDER BY s.started_at DESC
      LIMIT 100`,
    [req.user.sub],
  );
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
      questionCount: r.status === 'completed' ? r.responses : (r.practice?.questionCount ?? null),
      answered: r.answered,
      correct: r.status === 'completed' ? r.correct : null,
      totalScaled: r.total_scaled, rwScaled: r.rw_scaled, mathScaled: r.math_scaled,
    })),
  });
}));

// Discard a practice session. An unfinished one is deleted, so its questions go
// back to the pool for this student. A finished one only leaves the student's
// list: the profile is built on it, the academy sees it in Progress, and its
// questions stay seen.
router.delete('/practice/:id', selfGuidedOnly, asyncHandler(async (req, res) => {
  const mine = [req.params.id, req.user.sub];
  const deleted = await query(
    `DELETE FROM pa_sessions
      WHERE id = $1 AND user_id = $2 AND kind = 'practice' AND status = 'in_progress'`,
    mine,
  );
  if (!deleted.rowCount) {
    const hidden = await query(
      `UPDATE pa_sessions SET hidden_at = now()
        WHERE id = $1 AND user_id = $2 AND kind = 'practice' AND status = 'completed' AND hidden_at IS NULL`,
      mine,
    );
    if (!hidden.rowCount) throw notFound('practice session');
  }
  res.json({ ok: true });
}));

export default router;
