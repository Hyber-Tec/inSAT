// Session scoring: turn a materialized form + the student's answers + the
// chosen Module-2 routing into a results payload and the per-question response
// rows. Shared by the student finish/results routes and the admin results view.

import { routeFromModule1, sectionScaledScore, plainScaled } from './scoring.js';
import { DOMAINS, DOMAIN_LABEL, SKILLS } from './taxonomy.js';

const SECTION_KINDS = ['rw', 'math'];

const findSection = (form, kind) => form.sections.find((s) => s.kind === kind);
const module1 = (section) => section?.modules.find((m) => m.ordinal === 1);
const module2 = (section) => section?.modules.find((m) => m.ordinal === 2);

function questionsOf(mod, routing) {
  if (!mod) return [];
  if (mod.adaptive) return mod.variants?.[routing] || mod.variants?.easy || [];
  return mod.questions || [];
}

/** Grid-in (student-produced response) match.
 *
 *  When the item carries the source's list of accepted entries (the College
 *  Board prints them: "7/6, 1.166, and 1.167 are examples of ways to enter a
 *  correct answer"), an entry counts only if it equals one of them, as text or
 *  as a number. That is how the SAT scores it: an unreduced fraction such as
 *  14/12 is fine, a shorter rounding such as 1.17 is not, and a question with
 *  two solutions accepts either one.
 *
 *  Without a list (generated or hand-written items), fall back to numeric or
 *  fraction equivalence within a small tolerance (e.g. 2/3 = .667). */
export function gridMatch(given, expected, accepted = []) {
  // Thousands separators are not part of an entry ("1,188" and "1188" are one answer).
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/\u2212/g, '-')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const toNum = (s) => {
    const m = /^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/.exec(s);
    if (m) { const b = Number(m[2]); return b ? Number(m[1]) / b : NaN; }
    const n = s === '' ? NaN : Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const g = norm(given);
  if (!g) return false;
  const gn = toNum(g);

  const list = (Array.isArray(accepted) ? accepted : []).map(norm).filter(Boolean);
  if (list.length) {
    return list.some((a) => {
      if (a === g) return true;
      const an = toNum(a);
      return Number.isFinite(an) && Number.isFinite(gn) && Math.abs(an - gn) <= 1e-9 * Math.max(1, Math.abs(an));
    });
  }

  const e = norm(expected);
  if (g === e) return true;
  const en = toNum(e);
  if (Number.isFinite(gn) && Number.isFinite(en)) {
    return Math.abs(gn - en) <= Math.max(1e-4, 0.005 * Math.abs(en));
  }
  return false;
}

/** Whether one answer to one question instance is correct. */
const gridCorrect = (q, given) => gridMatch(given, q.answerText, q.accepted);

export function countCorrect(questions, answers) {
  let correct = 0;
  for (const q of questions) {
    if (isCorrectAnswer(q, answers)) correct++;
  }
  return { correct, total: questions.length };
}

/** Module-2 routing for a section from Module-1 performance. */
export function computeRouting(form, answers, sectionKind, thresholdFraction = 0.6) {
  const section = findSection(form, sectionKind);
  const { correct, total } = countCorrect(module1(section)?.questions || [], answers);
  return routeFromModule1(correct, total, thresholdFraction);
}

const isCorrectAnswer = (q, answers) => (q.answerType === 'grid-in'
  ? gridCorrect(q, answers[q.qid])
  : answers[q.qid] === q.correctIdx);

const isAnswered = (q, answers) => (q.answerType === 'grid-in'
  ? String(answers[q.qid] ?? '').trim() !== ''
  : answers[q.qid] !== undefined && answers[q.qid] !== null);

/** Correct/total per content domain, in taxonomy display order. Feeds the
 *  admin-side analysis ("what are they weak in"). */
function domainBreakdown(kind, questions, answers) {
  const order = DOMAINS[kind] || [];
  const map = new Map();
  for (const q of questions) {
    const id = q.domain || 'other';
    if (!map.has(id)) map.set(id, { domain: id, label: DOMAIN_LABEL[id] || id, correct: 0, total: 0 });
    const d = map.get(id);
    d.total += 1;
    if (isCorrectAnswer(q, answers)) d.correct += 1;
  }
  const rank = (id) => { const i = order.indexOf(id); return i === -1 ? order.length : i; };
  return [...map.values()].sort((a, b) => rank(a.domain) - rank(b.domain));
}

/** Correct/total per College Board skill, in taxonomy order. Feeds the
 *  student's own "what to work on next". Forms built before items carried a
 *  skill have none, and contribute nothing here. */
function skillBreakdown(kind, questions, answers) {
  const order = (DOMAINS[kind] || []).flatMap((d) => SKILLS[d] || []);
  const map = new Map();
  for (const q of questions) {
    if (!q.skill) continue;
    if (!map.has(q.skill)) map.set(q.skill, { skill: q.skill, domain: q.domain, correct: 0, total: 0 });
    const s = map.get(q.skill);
    s.total += 1;
    if (isCorrectAnswer(q, answers)) s.correct += 1;
  }
  const rank = (skill) => { const i = order.indexOf(skill); return i === -1 ? order.length : i; };
  return [...map.values()].sort((a, b) => rank(a.skill) - rank(b.skill));
}

function reviewQ(q, answers, moduleLabel) {
  const given = answers[q.qid];
  const isGrid = q.answerType === 'grid-in';
  const isCorrect = isGrid ? gridCorrect(q, given) : given === q.correctIdx;
  return {
    qid: q.qid,
    moduleLabel,
    section: q.section,
    domain: q.domain,
    skill: q.skill || '',
    passage: q.passage,
    question: q.question,
    choices: q.choices,
    answerType: q.answerType,
    correctIdx: isGrid ? null : q.correctIdx,
    correctAnswer: isGrid ? q.answerText : null,
    selectedIdx: isGrid ? null : (given ?? null),
    selectedText: isGrid ? (given ?? null) : null,
    isCorrect,
    rationale: q.rationale,
    figure: q.figure,
    assetId: q.assetId,
  };
}

/** Build the full results payload (scaled scores + per-question review). */
export function buildResults(form, state, routing) {
  const answers = state.answers || {};
  const threshold = form.routing?.thresholdFraction ?? 0.6;
  const sections = [];
  let totalScaled = 0, totalCorrect = 0, totalQuestions = 0;

  for (const kind of SECTION_KINDS) {
    const section = findSection(form, kind);
    if (!section) continue;
    const route = routing[kind] || computeRouting(form, answers, kind, threshold);
    const adaptive = !!module2(section)?.adaptive;
    const m1qs = module1(section)?.questions || [];
    const m2qs = questionsOf(module2(section), route);
    const c1 = countCorrect(m1qs, answers);
    const c2 = countCorrect(m2qs, answers);
    // Only an adaptive section has a route, and only a route sets a ceiling: a
    // fixed section scales straight from its accuracy instead of jumping at the
    // routing threshold as if Module 1 had chosen a harder Module 2.
    const scaled = adaptive
      ? sectionScaledScore(c1.correct, c1.total, c2.correct, c2.total, route)
      : plainScaled(c1.correct + c2.correct, c1.total + c2.total);
    const allQs = [...m1qs, ...m2qs];
    sections.push({
      kind,
      name: section.name,
      route: adaptive ? route : null,
      adaptive,
      scaled,
      correct: c1.correct + c2.correct,
      total: c1.total + c2.total,
      unanswered: allQs.filter((q) => !isAnswered(q, answers)).length,
      domains: domainBreakdown(kind, allQs, answers),
      skills: skillBreakdown(kind, allQs, answers),
      questions: [
        ...m1qs.map((q) => reviewQ(q, answers, 'Module 1')),
        ...m2qs.map((q) => reviewQ(q, answers, adaptive ? `Module 2 · ${route}` : 'Module 2')),
      ],
    });
    totalScaled += scaled;
    totalCorrect += c1.correct + c2.correct;
    totalQuestions += c1.total + c2.total;
  }
  return { sections, routing, threshold, totalScaled, totalCorrect, totalQuestions };
}

/** Whether a session's results carry a scaled score. A skill practice set, a
 *  handful of questions on a few skills, has none, and nor has a custom test
 *  (an academy's own questions, not built like the SAT): their result is the
 *  number correct. */
export const hasScaledScore = (s) => !(s.kind === 'practice' && s.practice?.mode === 'skills') && !s.form?.meta?.fixed;

/** Results for a stored session (row with `exam_title`), shaped for display. */
export function sessionResults(s, state = s.state || {}, routing = s.routing || {}) {
  const results = buildResults(s.form, state, routing);
  if (!hasScaledScore(s)) {
    results.totalScaled = null;
    for (const sec of results.sections) sec.scaled = null;
  }
  return { ...results, examTitle: s.exam_title, kind: s.kind || 'assigned', practice: s.practice || null };
}

/** Flatten the served questions into pa_responses rows. */
export function responseRows(form, state, routing) {
  const answers = state.answers || {};
  const marked = state.marked || {};
  const rows = [];
  for (const kind of SECTION_KINDS) {
    const section = findSection(form, kind);
    if (!section) continue;
    const route = routing[kind] || 'easy';
    const sets = [
      [`${kind}:1`, module1(section)?.questions || []],
      [`${kind}:2`, questionsOf(module2(section), route)],
    ];
    for (const [moduleKey, qs] of sets) {
      for (const q of qs) {
        const given = answers[q.qid];
        const isGrid = q.answerType === 'grid-in';
        rows.push({
          qInstanceId: q.qid,
          itemId: q.itemId || null,
          moduleKey,
          selectedIdx: isGrid ? null : (given ?? null),
          selectedText: isGrid ? (given ?? null) : null,
          correct: isGrid ? gridCorrect(q, given) : given === q.correctIdx,
          isMarked: !!marked[q.qid],
        });
      }
    }
  }
  return rows;
}
