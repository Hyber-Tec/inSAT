// Helpers for a custom test (a 'fixed' exam): the academy's own questions,
// served the same to every student from the test's stored `form`. Each added
// question is written into the academy's own bank, private to it (lib/pool.js),
// so a response links to an item and counts toward the student's skills, and
// an instance of it is appended to the form. Used by the routes that make a
// test from an upload or with AI and that add questions to one.

import { COL, col, docOf, getRow } from './store.js';
import { instanceFromRow } from './assembly.js';
import { findByHash, insertItem, isBankable } from './items.js';

const KIND_ORDER = { rw: 0, math: 1 };

/** A custom test of this institution (its row, form parsed), or null. */
export async function fixedExam(examId, institutionId) {
  const exam = await getRow(COL.exams, examId);
  return exam && exam.institution_id === institutionId && exam.kind === 'fixed' ? exam : null;
}

/** Store a custom test's edited form. */
export const saveForm = (examId, form) => col(COL.exams).doc(examId).update(docOf(COL.exams, { form }));

export const emptyFixedForm = () => ({
  sections: [],
  routing: { thresholdFraction: 0.6 },
  meta: { fixed: true, notes: [] },
});

// Bank item ids already represented in the form, so re-adding the same question
// (e.g. re-uploading a PDF) doesn't duplicate it within one exam.
function existingItemIds(form) {
  const ids = new Set();
  for (const s of form.sections || []) {
    for (const m of s.modules || []) {
      for (const q of m.questions || []) if (q.itemId) ids.add(q.itemId);
      if (m.variants) {
        for (const q of [...(m.variants.easy || []), ...(m.variants.hard || [])]) if (q.itemId) ids.add(q.itemId);
      }
    }
  }
  return ids;
}

// Append one instance into the form's matching section (Reading & Writing or
// Math) and module (1 or 2), creating the section/module the first time.
// Sections are kept in canonical order (R&W before Math) and modules by ordinal.
function appendInstance(form, instance, moduleOrdinal = 1) {
  const ordinal = Number(moduleOrdinal) === 2 ? 2 : 1;
  const kind = instance.section === 'math' ? 'math' : 'rw';
  let section = form.sections.find((s) => s.kind === kind);
  if (!section) {
    section = { kind, name: kind === 'math' ? 'Math' : 'Reading and Writing', timeLimitSec: null, modules: [] };
    form.sections.push(section);
    form.sections.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  }
  if (!Array.isArray(section.modules)) section.modules = [];
  let mod = section.modules.find((m) => m.ordinal === ordinal);
  if (!mod) {
    mod = { key: `${kind}:${ordinal}`, ordinal, adaptive: false, questions: [] };
    section.modules.push(mod);
    section.modules.sort((a, b) => a.ordinal - b.ordinal);
  }
  mod.questions = mod.questions || [];
  mod.questions.push(instance);
}

// Drop modules that ended up with no questions (e.g. after moving them out),
// and sections with no modules - so the editor and runner don't show empties.
function pruneEmpty(form) {
  for (const s of form.sections || []) {
    s.modules = (s.modules || []).filter((m) => (m.questions || []).length > 0 || m.variants);
  }
  form.sections = (form.sections || []).filter((s) => (s.modules || []).length > 0);
}

/**
 * Insert normalized rows into the academy's bank and append a question
 * instance for each into a custom test's form. Each question lands in the
 * given `module` (1 or 2) if provided, otherwise the row's own detected
 * module, otherwise module 1. A question already in the test is not added
 * again; one merely like another is (a test holds what its author put in it).
 * Returns { added, appended } or null if the exam isn't a custom test in this
 * institution.
 */
export async function addRowsToExam(examId, institutionId, rows, { module = null } = {}) {
  const exam = await fixedExam(examId, institutionId);
  if (!exam) return null;
  const form = exam.form || emptyFixedForm();
  if (!Array.isArray(form.sections)) form.sections = [];

  const inForm = existingItemIds(form);
  let added = 0;
  let appended = 0;
  for (const row of rows) {
    if (!isBankable(row)) continue;
    let item = null;
    const result = await insertItem(row, institutionId, { nearDuplicates: 'allow', onAdded: (r) => { item = r; } });
    if (result === 'added') added += 1;
    else item = await findByHash(institutionId, row.content_hash);
    if (item && !inForm.has(item.id)) {
      appendInstance(form, instanceFromRow(item), module || row.module || 1);
      inForm.add(item.id);
      appended += 1;
    }
  }
  await saveForm(examId, form);
  return { added, appended };
}

/**
 * Move questions (by qid) to another module within their OWN section - a R&W
 * question can only move between R&W modules, Math between Math modules. Returns
 * { moved } or null if the exam isn't a fixed exam in this institution.
 */
export async function moveQuestionsToModule(examId, institutionId, qids, targetModule) {
  const ordinal = Number(targetModule) === 2 ? 2 : 1;
  const exam = await fixedExam(examId, institutionId);
  if (!exam || !exam.form) return null;
  const form = exam.form;
  const wanted = new Set(qids);

  // Pull the matching questions out of wherever they currently sit.
  const pulled = [];
  for (const s of form.sections || []) {
    for (const m of s.modules || []) {
      if (!m.questions) continue;
      const keep = [];
      for (const q of m.questions) {
        if (wanted.has(q.qid)) pulled.push(q);
        else keep.push(q);
      }
      m.questions = keep;
    }
  }
  // Re-add each into the target module of its own section (instance.section).
  for (const instance of pulled) appendInstance(form, instance, ordinal);
  pruneEmpty(form);

  await saveForm(examId, form);
  return { moved: pulled.length };
}

/** The sections a custom test has questions in, in order ('rw', 'math'). */
export const formSections = (form) => (form?.sections || [])
  .filter((s) => (s.modules || []).some((m) => (m.questions || []).length))
  .map((s) => s.kind);

// The SAT's own pace: 32 minutes for 27 Reading and Writing questions, 35 for
// 22 Math ones.
const SECONDS_PER_QUESTION = { rw: (32 * 60) / 27, math: (35 * 60) / 22 };

/**
 * A timed custom test gives each module the time its length would have on the
 * SAT, in whole minutes. Set on the copy of the form an attempt is served, so
 * the test can change without touching attempts already started.
 */
export function timedAtSatPace(form) {
  return {
    ...form,
    sections: form.sections.map((s) => ({
      ...s,
      modules: s.modules.map((m) => ({
        ...m,
        timeLimitSec: Math.ceil(((m.questions || []).length * SECONDS_PER_QUESTION[s.kind]) / 60) * 60,
      })),
    })),
  };
}

/** Total questions stored in a fixed exam's form (across sections/modules). */
export function countFormQuestions(form) {
  if (!form || !Array.isArray(form.sections)) return 0;
  let n = 0;
  for (const s of form.sections) {
    for (const m of s.modules || []) {
      n += (m.questions || []).length;
      if (m.variants) n += (m.variants.easy || []).length + (m.variants.hard || []).length;
    }
  }
  return n;
}
