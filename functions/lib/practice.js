// Self-guided practice: what a student is weak at, and the practice that
// follows from it.
//
// The profile is accuracy per College Board skill across every completed
// session (assigned exams and practice alike), smoothed so one lucky answer is
// not mastery. Practice is a full SAT, one section, or a set built from chosen
// skills at a difficulty matched to how the student is doing in each.

import { COL, col, getMany } from './store.js';
import { FULL_SAT_SPEC } from './blueprints.js';
import { loadSeenItemIds } from './assembly.js';
import { bankRows, poolFor, servable } from './pool.js';
import { hasTemplates } from './templateItems.js';
import { DOMAINS, DOMAIN_LABEL, SKILLS, domainForSkill, sectionForDomain } from './taxonomy.js';

/**
 * The questions a student answered in their completed sessions, counted per
 * domain and skill of each question as the bank files it now (a question
 * relabelled later counts where it is now filed).
 */
async function answeredBySkill(userId, pool) {
  const snap = await col(COL.sessions).where('user_id', '==', userId).select('status', 'completed_at', 'responses').get();
  const done = snap.docs.map((d) => d.data()).filter((s) => s.status === 'completed');
  const ids = new Set(done.flatMap((s) => (s.responses || []).map((r) => r.item_id).filter(Boolean)));
  const known = await bankRows(pool);
  const items = new Map([...ids].filter((id) => known.has(id)).map((id) => [id, known.get(id)]));
  for (const [id, r] of await getMany(COL.items, [...ids].filter((id) => !items.has(id)), ['domain', 'skill'])) items.set(id, r);
  const out = new Map();
  for (const s of done) {
    const at = s.completed_at?.toDate?.() ?? s.completed_at ?? null;
    for (const r of s.responses || []) {
      const item = r.item_id && items.get(r.item_id);
      if (!item) continue;
      const key = `${item.domain}|${item.skill}`;
      if (!out.has(key)) out.set(key, { domain: item.domain, skill: item.skill, answered: 0, correct: 0, last_practised: null });
      const g = out.get(key);
      g.answered += 1;
      if (r.correct) g.correct += 1;
      if (at && (!g.last_practised || at > g.last_practised)) g.last_practised = at;
    }
  }
  return [...out.values()];
}

// Laplace-smoothed accuracy: (correct + 1) / (answered + 2). Untested reads
// 0.5, 1 of 1 reads 0.67, 9 of 10 reads 0.83: the estimate moves toward the
// raw accuracy as evidence builds instead of jumping to 0% or 100%.
export const mastery = (correct, answered) => (correct + 1) / (answered + 2);

// Thresholds on the smoothed estimate. A skill needs a few answers before it can
// read as strong: 3 of 3 is 0.8.
export function level(correct, answered) {
  if (!answered) return 'untested';
  const m = mastery(correct, answered);
  if (m < 0.55) return 'focus';
  if (m < 0.8) return 'building';
  return 'strong';
}

/** A difficulty to practise a skill at, from how the student is doing in it. */
export function practiceDifficulty(correct, answered) {
  if (!answered) return 'mixed';
  const m = mastery(correct, answered);
  if (m < 0.5) return 'easy';
  if (m < 0.75) return 'mixed';
  return 'hard';
}

/**
 * What can be served per skill: questions in the pool the student's
 * institution draws on (lib/pool.js) that they have not had yet (`ready`), and
 * whether the math templates can build more on demand (`more`).
 */
async function supply(userId, institutionId) {
  const seen = await loadSeenItemIds(userId);
  const rows = await servable(await poolFor(institutionId));
  const ready = new Map();
  const bump = (key) => ready.set(key, (ready.get(key) || 0) + 1);
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    bump(`skill|${r.skill}`);
    bump(`skill|${r.skill}|${r.difficulty}`);
    bump(`section|${r.section}`);
  }
  return {
    skill: (domain, skill) => ({
      ready: ready.get(`skill|${skill}`) || 0,
      more: sectionForDomain(domain) === 'math' && hasTemplates(domain, skill),
      // What a set at one chosen difficulty could draw on.
      byDifficulty: Object.fromEntries(['easy', 'medium', 'hard'].map((d) => [d, {
        ready: ready.get(`skill|${skill}|${d}`) || 0,
        more: sectionForDomain(domain) === 'math' && hasTemplates(domain, skill, d),
      }])),
    }),
    // Every math domain has templates, so a math section can always be built.
    section: (kind) => ({ ready: ready.get(`section|${kind}`) || 0, more: kind === 'math' }),
  };
}

/**
 * Per-skill results for one student, every College Board skill included (a
 * skill never seen is "untested"), in taxonomy order; given the student's
 * `institutionId`, with what its pool has to practise in each.
 */
export async function skillProfile(userId, { institutionId = null } = {}) {
  const rows = await answeredBySkill(userId, await poolFor(institutionId));
  const seen = new Map(rows.map((r) => [`${r.domain}|${r.skill}`, r]));
  const available = institutionId ? await supply(userId, institutionId) : null;
  const skills = [];
  for (const section of ['rw', 'math']) {
    for (const domain of DOMAINS[section]) {
      for (const skill of SKILLS[domain]) {
        const r = seen.get(`${domain}|${skill}`) || { answered: 0, correct: 0, last_practised: null };
        skills.push({
          section,
          domain,
          domainLabel: DOMAIN_LABEL[domain],
          skill,
          answered: r.answered,
          correct: r.correct,
          accuracy: r.answered ? r.correct / r.answered : null,
          mastery: mastery(r.correct, r.answered),
          level: level(r.correct, r.answered),
          lastPractised: r.last_practised,
          ...(available ? available.skill(domain, skill) : {}),
        });
      }
    }
  }
  const answered = skills.reduce((s, x) => s + x.answered, 0);
  // Up to three skills to work on next: the weakest of those with a miss in
  // them (a skill answered right every time is unproven, not weak) that there
  // is something to practise in.
  const practicable = (x) => !available || x.ready > 0 || x.more;
  const recommended = skills
    .filter((x) => x.correct < x.answered && x.level !== 'strong' && practicable(x))
    .sort((a, b) => a.mastery - b.mastery || b.answered - a.answered)
    .slice(0, 3)
    .map((x) => x.skill);
  const sections = available
    ? Object.fromEntries(['rw', 'math'].map((kind) => [kind, available.section(kind)]))
    : undefined;
  return { answered, skills, recommended, sections };
}

// ---------------------------------------------------------------------------
// Practice specs, in the blueprint shape lib/assembly.js materializes.
// ---------------------------------------------------------------------------

export const PRACTICE_MODES = {
  full: 'Full SAT practice test',
  rw: 'Reading and Writing practice',
  math: 'Math practice',
  skills: 'Skill practice',
};

/** A full SAT, or one of its sections, exactly as the digital SAT runs it. */
export function sectionSpec(mode) {
  if (mode === 'full') return FULL_SAT_SPEC;
  return { ...FULL_SAT_SPEC, sections: FULL_SAT_SPEC.sections.filter((s) => s.kind === mode) };
}

/** The most skills one practice set may cover. */
export const MAX_SKILLS = 8;

/** Questions per skill: about a dozen in all, never fewer than three a skill. */
export const perSkillFor = (k) => Math.max(3, Math.min(10, Math.round(12 / Math.max(1, k))));

/**
 * A set of `perSkill` questions for each chosen skill, one untimed module per
 * section, each skill at the difficulty the student's record in it calls for.
 */
export function skillsSpec(skillNames, profile, { perSkill, difficulty = null } = {}) {
  const skills = skillNames.filter((skill) => domainForSkill(skill));
  const n = perSkill ?? perSkillFor(skills.length);
  const bySkill = new Map((profile?.skills || []).map((s) => [s.skill, s]));
  const bySection = { rw: {}, math: {} };
  for (const skill of skills) {
    const domain = domainForSkill(skill);
    const p = bySkill.get(skill) || { correct: 0, answered: 0 };
    // A difficulty the student chose is kept to strictly; otherwise it follows
    // how the student is doing in the skill.
    bySection[sectionForDomain(domain)][skill] = difficulty
      ? { n, difficulty, strict: true }
      : { n, difficulty: practiceDifficulty(p.correct, p.answered) };
  }
  const sections = [];
  for (const kind of ['rw', 'math']) {
    const skills = bySection[kind];
    const count = Object.values(skills).reduce((s, x) => s + x.n, 0);
    if (!count) continue;
    sections.push({
      kind,
      name: kind === 'rw' ? 'Reading and Writing' : 'Math',
      timeLimitSec: null,
      modules: [{ ordinal: 1, adaptive: false, count, difficulty: 'mixed', skills }],
    });
  }
  // Practice, not an exam: it draws from the whole bank, templates included.
  return { routing: { thresholdFraction: 0.6 }, sections, exam: false };
}

/** How many questions a skill set of `skillNames` will hold. */
export const skillSetSize = (skillNames, perSkill) => skillNames.length * (perSkill ?? perSkillFor(skillNames.length));

/** Questions in a full SAT or one of its sections. */
export const testSize = (mode) => sectionSpec(mode).sections
  .reduce((n, s) => n + s.modules.reduce((m, mod) => m + mod.count, 0), 0);

export function practiceTitle(mode, skillNames = [], difficulty = null) {
  if (mode !== 'skills') return PRACTICE_MODES[mode];
  const level = difficulty ? ` (${difficulty})` : '';
  if (skillNames.length === 1) return `Skill practice: ${skillNames[0]}${level}`;
  return `Skill practice: ${skillNames.length} skills${level}`;
}
