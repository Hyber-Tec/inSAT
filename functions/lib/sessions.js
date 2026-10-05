// Sessions (one student's attempt at a test or practice set) in Firestore.
//
// A session document holds its form (with the answers, never sent to the
// browser as is), the resume state, the routing, and once finished the
// scores and one response per question served (what pa_responses held). It
// also keeps the ids of the questions its form serves (lib/assembly.js
// seenFields), so the questions a student has met are read without the forms.
// Lists read only the light fields.

import { FieldPath } from 'firebase-admin/firestore';
import { db } from './firebase.js';
import { COL, col, docOf, getRow, isDocId, newId, now, rowOf, rowsOf } from './store.js';
import { seenFields } from './assembly.js';

/** What a list of sessions reads: everything but the form. */
export const LIST_FIELDS = [
  'assignment_id', 'exam_id', 'user_id', 'institution_id', 'status', 'kind', 'title', 'timing_mode', 'practice',
  'state', 'routing', 'rw_scaled', 'math_scaled', 'total_scaled', 'started_at', 'completed_at', 'hidden_at',
  'response_count', 'correct_count',
];

/** Sessions matching `where` ([field, op, value] triples), light fields only. */
export async function listSessions(where, fields = LIST_FIELDS) {
  let q = col(COL.sessions);
  for (const [f, op, v] of where) q = q.where(f, op, v);
  return rowsOf(await q.select(...fields).get(), COL.sessions);
}

/** Some fields of one session, or null. */
export async function sessionFields(id, fields) {
  if (!isDocId(id)) return null;
  const [snap] = await db.getAll(col(COL.sessions).doc(id), { fieldMask: fields });
  return rowOf(snap, COL.sessions);
}

/** A new in-progress session; its id. */
export async function createSession(fields) {
  const id = newId();
  const row = {
    assignment_id: null, exam_id: null, state: {}, routing: {}, status: 'in_progress', kind: 'assigned',
    title: null, timing_mode: null, practice: null, rw_scaled: null, math_scaled: null, total_scaled: null,
    started_at: now(), completed_at: null, hidden_at: null, responses: [], response_count: 0, correct_count: 0,
    ...fields,
    ...seenFields(fields.form),
  };
  await col(COL.sessions).doc(id).set(docOf(COL.sessions, row));
  return id;
}

/**
 * A session with its test's title and timing: a practice session has no test,
 * so its own; a test's attempt keeps the timing the test had when it started
 * (older attempts, from before that was kept, read the test's).
 */
export async function withExam(s) {
  if (!s) return null;
  const e = s.exam_id ? await getRow(COL.exams, s.exam_id) : null;
  return {
    ...s,
    timing_mode: s.timing_mode ?? e?.timing_mode ?? 'untimed',
    exam_title: e?.title ?? s.title,
    exam_kind: e?.kind ?? null,
  };
}

/** Save session fields (a row's worth: state and form are written as JSON). */
export const updateSession = (id, fields) => col(COL.sessions).doc(id).update(docOf(COL.sessions, fields));

/** How many answers a resume state holds (an empty entry is no answer). */
export function answeredIn(state) {
  return Object.values(state?.answers || {}).filter((v) => v !== null && v !== '').length;
}

/** The rows of these sessions by id (light fields). */
export async function sessionsById(ids, fields = LIST_FIELDS) {
  const out = [];
  for (let i = 0; i < ids.length; i += 30) {
    const part = ids.slice(i, i + 30).filter(isDocId);
    if (!part.length) continue;
    out.push(...rowsOf(await col(COL.sessions).where(FieldPath.documentId(), 'in', part).select(...fields).get(), COL.sessions));
  }
  return out;
}
