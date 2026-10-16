// One student as their academy's admin, or the platform owner, sees them: how
// they are doing in every College Board skill, every test and practice set
// they started, and what is assigned to them; and the review of one of their
// sessions. The admin routes show an academy its own students, the platform
// console any academy's (routes/super.js).

import { COL, col, getMany, getRow, queryRows, whereIn } from './store.js';
import { listSessions, withExam } from './sessions.js';
import { sessionResults } from './session.js';
import { countFormQuestions } from './examForm.js';
import { practiceTitle, skillProfile, skillSetSize, testSize } from './practice.js';

export const byName = (a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase());
export const newestFirst = (field) => (a, b) => (b[field]?.getTime?.() ?? 0) - (a[field]?.getTime?.() ?? 0);

/** A row of this institution's, or null (a row of another reads as absent). */
export async function owned(name, id, institutionId) {
  const row = await getRow(name, id);
  return row && row.institution_id === institutionId ? row : null;
}

/** A student of this institution, or null. */
export async function studentOf(id, institutionId) {
  const u = await owned(COL.users, id, institutionId);
  return u && u.role === 'student' ? u : null;
}

// What an assignment is called: its test's title, or the practice set's.
export const assignmentTitle = (a) => (a.kind === 'practice'
  ? practiceTitle('skills', a.practice?.skills || [], a.practice?.difficulty || null)
  : a.exam_title);

/** A student's attempt at each assignment: the finished one first, else the latest. */
export function attemptsByAssignment(sessions) {
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

/**
 * A student of `institutionId` (their row) for their page: their groups,
 * their skill map (with what there is to practise, for assigning topics),
 * every test and practice set they started, and what is assigned to them,
 * directly or through a group.
 */
export async function studentOverview(student, institutionId) {
  const groups = (await queryRows(col(COL.groups).where('member_ids', 'array-contains', student.id)))
    .map((g) => ({ id: g.id, name: g.name }))
    .sort((a, b) => byName(a.name, b.name));
  const profile = await skillProfile(student.id, { institutionId });
  const sessions = (await listSessions([['user_id', '==', student.id], ['institution_id', '==', institutionId]]))
    .sort(newestFirst('started_at')).slice(0, 200);
  const assigned = [
    ...await queryRows(col(COL.assignments).where('institution_id', '==', institutionId).where('user_id', '==', student.id)),
    ...await whereIn(COL.assignments, 'group_id', groups.map((g) => g.id), [['institution_id', '==', institutionId]]),
  ];
  const exams = await getMany(COL.exams, [...sessions, ...assigned].map((x) => x.exam_id).filter(Boolean));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const attempts = attemptsByAssignment(sessions);
  return {
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
  };
}

/** The review of one of this institution's sessions (what its student answered, and why), or null. */
export async function sessionReview(sessionId, institutionId) {
  const s = await owned(COL.sessions, sessionId, institutionId);
  if (!s) return null;
  const u = await getRow(COL.users, s.user_id);
  if (!u) return null;
  return { ...sessionResults(await withExam(s)), studentName: u.display_name, proctor: s.state?.proctor || null };
}
