// Bank rows built from the math templates (lib/templates/math.js). Computed in
// code, so they are free, instant and correct by construction. Used to top the
// bank up offline (scripts/topup-pool.js) and to fill a math cell on demand
// while a form is assembled, before anything reaches for a model.

import { TEMPLATES_BY_DOMAIN, templatesFor, buildItem } from './templates/math.js';
import { contentHash, importRows } from './items.js';

/**
 * Import template rows. Exact repeats are still dropped by content hash, but
 * the near-duplicate gate is skipped: siblings of one template differ only in
 * their numbers by design, and each new sibling is compared against every one
 * already banked, so the gate's small per-pair false-match rate compounds
 * until a template can add nothing (short stems stalled at 8 or 9 items).
 */
export const importTemplateRows = (rows, institutionId) => importRows(rows, institutionId, { nearDuplicates: 'allow' });

/**
 * Up to `need` rows for one (domain, difficulty) cell, or for one skill in it.
 *
 * Only templates that genuinely sit at this difficulty are used: relabelling an
 * easy template as hard would fill the count and lie about the bank. An empty
 * result means no template covers the cell.
 */
export function templateRows({ domain, difficulty, need, skill = null, templateId = null, seed = Date.now() }) {
  const templates = templatesFor(domain, difficulty).filter((t) => (!skill || t.skill === skill) && (!templateId || t.id === templateId));
  if (!templates.length || need <= 0) return [];
  const rows = [];
  // Round-robin across the cell's templates so one shape does not dominate.
  for (let i = 0; rows.length < need && i < need * 12; i += 1) {
    const t = templates[i % templates.length];
    const built = buildItem(t, (seed % 1e6) + i * 104729);
    if (!built) continue;
    rows.push({
      // Hashed with the choices in a fixed order: two draws with the same numbers
      // are the same question even when their options came out shuffled apart.
      content_hash: contentHash({ section: 'math', question: built.question, choices: [...built.choices].sort(), passage: null }),
      section: 'math',
      domain,
      skill: t.skill,
      difficulty,
      passage: null,
      question: built.question,
      choices: built.choices,
      correct_idx: built.correctIdx,
      answer_type: built.answerType,
      answer_text: built.answerText || null,
      rationale: { ...built.rationale, template: t.id, seed: built.seed },
      figure: null,
      svg: null,
      image_ref: null,
      source: 'template',
      verified: true, // computed in code, not guessed by a model
    });
  }
  return rows;
}

/** Whether any template can build items for a skill, at any difficulty. */
/** The templates a draw could build from: one domain, optionally one skill and one difficulty. */
export function templatesIn(domain, { skill = null, difficulty = null } = {}) {
  return (difficulty ? [difficulty] : ['easy', 'medium', 'hard'])
    .flatMap((d) => templatesFor(domain, d).map((t) => ({ id: t.id, skill: t.skill, difficulty: d })))
    .filter((t) => !skill || t.skill === skill);
}

export function hasTemplates(domain, skill, difficulty = null) {
  return (difficulty ? [difficulty] : ['easy', 'medium', 'hard']).some((d) => templatesFor(domain, d).some((t) => t.skill === skill));
}

/** The skills of a domain that some template covers. */
export const templateSkills = (domain) => [...new Set((TEMPLATES_BY_DOMAIN[domain] || []).map((t) => t.skill))];
