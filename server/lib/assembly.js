// Exam assembly engine: turn a blueprint spec into a materialized, unique
// per-attempt form. This is what makes every exam differ - items are sampled
// fresh from insat's question pool (lib/pool.js), never one the student has
// already been served, choice order is shuffled, and a math cell that runs
// short is topped up from the templates. Every institution draws on the same
// pool; nothing here calls a model.
//
// The materialized form holds correct answers + rationales and is stored on the
// session. It is NEVER sent to the client verbatim - sanitizeForm() strips the
// answers for delivery; scoring happens server-side against the stored form.

import crypto from 'node:crypto';
import { query } from './db.js';
import { POOL_SOURCES, poolFor } from './pool.js';
import { templateRows, templatesIn, importTemplateRows } from './templateItems.js';
import { domainForSkill } from './taxonomy.js';
import { lineageOf } from './lineage.js';

const rid = () => `q-${crypto.randomUUID()}`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DIFF_PREF = {
  mixed: ['medium', 'easy', 'hard'],
  easy: ['easy', 'medium', 'hard'],
  hard: ['hard', 'medium', 'easy'],
};

// How strongly a pick avoids repeating a skill, against its preference for a
// difficulty: a skill's second question loses to a new skill one difficulty
// step off, but beats one two steps off. Without it a domain draw follows the
// difficulty alone, and since most templates sit at one difficulty, a module's
// whole algebra quota could come from a single skill.
const SKILL_SPREAD = 1.5;
// The same for a math template within a skill: a skill with two templates
// alternates them instead of serving ten of one. A template item also carries
// a small handicap, so a question written in the SAT's style (an original or a
// variant of one) of the wanted difficulty goes first and templates fill in.
const TEMPLATE_SPREAD = 1.5;
const TEMPLATE_BIAS = 0.5;
// An exam (a full practice test, or any form but a skill set) draws the
// questions that read most like the real SAT first: each step down the realism
// scale costs as much as a skill already drawn once, so a template, formulaic by
// construction, comes last and serves only when nothing more exam-like is left
// for this student. A skill set takes the wider mix, for volume.
const REALISM_WEIGHT = 1.5;
const realismOf = (r) => (r.rationale?.template ? 1 : r.realism ?? 4);
// A variant (lib/variation) is its source question with new numbers, so a
// question and its variants form one lineage. A form never holds two of one
// lineage, and a lineage the student has already met costs extra, so fresh
// questions go first. In a practice set the cost is small: once the fresh
// questions run out, the same question with new numbers is better practice
// than a formulaic template. An exam measures, so there familiarity costs as
// much as two steps down the realism scale.
const LINEAGE_SEEN = { practice: 1, exam: 3 };

const LETTERS = ['A', 'B', 'C', 'D'];

// Build a question instance from a bank row: shuffle choices, remap the key
// and the per-choice rationale to the new positions.
export function instanceFromRow(row) {
  const base = {
    qid: rid(),
    itemId: row.id,
    section: row.section,
    domain: row.domain,
    skill: row.skill || '',
    difficulty: row.difficulty,
    passage: row.passage || null,
    question: row.question,
    answerType: row.answer_type,
    figure: row.figure || null,
    assetId: row.asset_id || null,
  };

  // Grid-in (student-produced response): no choices, a free-response answer.
  if (row.answer_type === 'grid-in') {
    return {
      ...base,
      choices: [],
      answerText: String(row.answer_text ?? '').trim(),
      accepted: Array.isArray(row.accepted) ? row.accepted.map(String) : [],
      rationale: { correct: (row.rationale || {}).correct || '' },
    };
  }

  // Multiple choice: shuffle choices and remap the key + per-choice rationale.
  const order = shuffle([0, 1, 2, 3]);
  const choices = order.map((i) => row.choices[i]);
  const correctIdx = order.indexOf(row.correct_idx);
  const rat = row.rationale || {};
  const rationale = { correct: rat.correct || '' };
  order.forEach((origIdx, newIdx) => {
    rationale[LETTERS[newIdx]] = rat[LETTERS[origIdx]] || '';
  });
  return { ...base, choices, correctIdx, rationale };
}

// What the pool holds for one section and domain (and skill).
async function candidatesFor(pool, kind, domain, skill = null) {
  if (!pool) return [];
  const { rows } = await query(
    `SELECT id, section, domain, skill, difficulty, passage, question, choices,
            correct_idx, answer_type, answer_text, accepted, rationale, figure, asset_id, realism, variant_of
       FROM pa_items
      WHERE institution_id = $1 AND section = $2 AND domain = $3 AND retired_at IS NULL
        AND source = ANY($5::text[])
        AND ($4::text IS NULL OR skill = $4)`,
    [pool, kind, domain, skill, POOL_SOURCES],
  );
  return rows;
}

/** Add template-built questions to the pool; the count added. */
async function buildIntoPool(pool, built) {
  if (!pool || !built.length) return 0;
  return (await importTemplateRows(built, pool)).added;
}

async function pickItems({ pool, kind, domain, skill = null, n, difficulty, strict = false, exam = false, usedInForm, seen, usedLineage = new Set(), seenLineage = new Set(), buildTemplates, notes }) {
  // A difficulty the student chose (strict) admits no other; otherwise a mixed
  // module takes whatever difficulties come and the others rank them.
  const only = strict && DIFF_PREF[difficulty] && difficulty !== 'mixed' ? difficulty : null;
  const pref = only ? [only] : (DIFF_PREF[difficulty] || DIFF_PREF.mixed);
  const rank = !only && (difficulty === 'easy' || difficulty === 'hard')
    ? (d) => { const i = pref.indexOf(d); return i < 0 ? pref.length : i; }
    : () => 0;
  const cell = skill ? `${kind}/${skill}` : `${kind}/${domain}`;
  const load = async () => (await candidatesFor(pool, kind, domain, skill)).filter((r) => !only || r.difficulty === only);
  let rows = await load();
  const chosen = [];
  const perSkill = new Map();
  const perTemplate = new Map();

  // A question this student has already been served is never served again.
  // In a self-guided product the student chooses to practise repeatedly, so a
  // "prefer unseen" rule degrades into showing the same items back within a few
  // sessions; this is a hard exclusion instead, and a short form is reported
  // rather than padded with repeats. Among the rest, each pick is the best
  // balance of the wanted difficulty and a skill not yet drawn (random among
  // equals).
  const take = (candidates) => {
    const open = shuffle(candidates.filter((r) => !usedInForm.has(r.id) && !seen.has(r.id)));
    while (chosen.length < n && open.length) {
      let best = -1;
      let bestScore = Infinity;
      open.forEach((r, i) => {
        if (usedLineage.has(lineageOf(r))) return;
        const tpl = r.rationale?.template;
        const score = (perSkill.get(r.skill) || 0) * SKILL_SPREAD + rank(r.difficulty)
          + (tpl ? (perTemplate.get(tpl) || 0) * TEMPLATE_SPREAD + TEMPLATE_BIAS : 0)
          + (exam ? (5 - realismOf(r)) * REALISM_WEIGHT : 0)
          + (seenLineage.has(lineageOf(r)) ? LINEAGE_SEEN[exam ? 'exam' : 'practice'] : 0);
        if (score < bestScore) { best = i; bestScore = score; }
      });
      if (best < 0) break;
      const [r] = open.splice(best, 1);
      chosen.push(r);
      usedInForm.add(r.id);
      usedLineage.add(lineageOf(r));
      perSkill.set(r.skill, (perSkill.get(r.skill) || 0) + 1);
      const tpl = r.rationale?.template;
      if (tpl) perTemplate.set(tpl, (perTemplate.get(tpl) || 0) + 1);
    }
  };

  // Every template this draw could use first gets a few items this student has
  // not seen, so a set mixes a skill's patterns (and a domain draw reaches every
  // skill) instead of repeating whichever pattern the bank holds most of.
  if (buildTemplates && kind === 'math') {
    const open = new Map();
    for (const r of rows) {
      const t = r.rationale?.template;
      if (t && !seen.has(r.id) && !usedInForm.has(r.id)) open.set(t, (open.get(t) || 0) + 1);
    }
    const templates = templatesIn(domain, { skill, difficulty: only });
    // Enough of each for an even share of this draw.
    const each = Math.max(3, Math.ceil(n / Math.max(1, templates.length)));
    const built = [];
    for (const t of templates) {
      const have = open.get(t.id) || 0;
      if (have < each) built.push(...templateRows({ domain, skill: t.skill, difficulty: t.difficulty, templateId: t.id, need: each - have }));
    }
    if (await buildIntoPool(pool, built)) rows = await load();
  }

  take(rows);

  // A genuine gap in math is built from the templates: computed in code, so
  // free, instant and correct by construction. It builds twice what this
  // form needs, since some draws are rejected as duplicates and the rest keep
  // the next form from coming up short. A skill draw builds in the order its
  // difficulty asks for; a domain draw builds some of every difficulty, since
  // each template sits at one and a spread of skills needs a spread of them.
  if (chosen.length < n && buildTemplates && kind === 'math') {
    const want = (n - chosen.length) * 2;
    const share = skill ? want : Math.ceil(want / pref.length);
    const built = [];
    for (const round of skill ? [0] : [0, 1]) {
      for (const d of pref) {
        const need = round ? want - built.length : Math.min(share, want - built.length);
        built.push(...templateRows({ domain, skill, difficulty: d, need, seed: Date.now() + round * 7 }));
        if (built.length >= want) break;
      }
      if (built.length >= want) break;
    }
    const added = await buildIntoPool(pool, built);
    if (added) {
      notes.push(`built ${added} from templates for ${cell}`);
      rows = await load();
      take(rows);
    }
  }

  // Nothing is padded: cycling with `%` would repeat a question inside a
  // single exam, so a form that cannot be filled comes up short and says so.
  if (chosen.length < n) {
    notes.push(rows.length
      ? `short ${n - chosen.length} for ${cell}: every remaining item has already been served to this student`
      : `short ${n - chosen.length} for ${cell}: the pool has no items here`);
  }

  return chosen.slice(0, n).map(instanceFromRow);
}

async function buildModuleQuestions(section, moduleSpec, difficulty, ctx) {
  const out = [];
  const common = {
    pool: ctx.pool,
    kind: section.kind,
    exam: ctx.exam,
    usedInForm: ctx.usedInForm,
    seen: ctx.seen,
    usedLineage: ctx.usedLineage,
    seenLineage: ctx.seenLineage,
    buildTemplates: ctx.buildTemplates,
    notes: ctx.notes,
  };
  for (const [domain, count] of Object.entries(moduleSpec.domains || {})) {
    out.push(...await pickItems({ ...common, domain, n: count, difficulty }));
  }
  // Skill practice asks for items of one skill, each at its own difficulty:
  // { "Transitions": { n: 4, difficulty: "easy" } }.
  for (const [skill, want] of Object.entries(moduleSpec.skills || {})) {
    const domain = domainForSkill(skill);
    if (!domain) { ctx.notes.push(`unknown skill ${skill}`); continue; }
    out.push(...await pickItems({ ...common, domain, skill, n: want.n, difficulty: want.difficulty || difficulty, strict: Boolean(want.strict) }));
  }
  return shuffle(out);
}

/**
 * All bank item ids this student has already been served in prior sessions.
 *
 * An adaptive module holds both of its routes until Module 1 decides which one
 * the student gets. Before that, both are held back; after it, only the route
 * that was served counts, and the other route's questions, never shown, go
 * back to the pool.
 */
export async function loadSeenItemIds(userId) {
  const seen = new Set();
  if (!userId) return seen;
  const { rows } = await query('SELECT form, routing FROM pa_sessions WHERE user_id = $1', [userId]);
  for (const r of rows) {
    for (const s of r.form?.sections || []) {
      const route = r.routing?.[s.kind];
      for (const m of s.modules || []) {
        const qs = m.questions || [];
        const vs = !m.variants ? []
          : route && m.variants[route] ? m.variants[route]
            : [...(m.variants.easy || []), ...(m.variants.hard || [])];
        for (const q of [...qs, ...vs]) if (q.itemId) seen.add(q.itemId);
      }
    }
  }
  return seen;
}

/** The lineages (a source question and its variants) behind items a student has seen. */
export async function lineagesOf(itemIds) {
  const out = new Set();
  if (!itemIds.size) return out;
  const { rows } = await query('SELECT id, variant_of FROM pa_items WHERE id = ANY($1::uuid[])', [[...itemIds]]);
  for (const r of rows) out.add(lineageOf(r));
  return out;
}

/**
 * Materialize a full, unique form from a blueprint spec for a given student,
 * from the pool `institutionId` draws on (lib/pool.js). `buildTemplates: false`
 * (a preview) only samples what the pool already holds.
 */
export async function materializeForm(spec, { userId, institutionId, buildTemplates = true } = {}) {
  const seen = await loadSeenItemIds(userId);
  const ctx = {
    pool: await poolFor(institutionId),
    exam: spec.exam !== false,
    usedInForm: new Set(),
    seen,
    usedLineage: new Set(),
    seenLineage: await lineagesOf(seen),
    buildTemplates,
    notes: [],
  };
  const sections = [];
  for (const section of spec.sections) {
    const modules = [];
    for (const mod of section.modules) {
      const key = `${section.kind}:${mod.ordinal}`;
      if (mod.adaptive) {
        // Materialize both routes up front so runtime can select either.
        const easy = await buildModuleQuestions(section, mod, 'easy', ctx);
        const hard = await buildModuleQuestions(section, mod, 'hard', ctx);
        modules.push({ key, ordinal: mod.ordinal, adaptive: true, variants: { easy, hard } });
      } else {
        const questions = await buildModuleQuestions(section, mod, mod.difficulty || 'mixed', ctx);
        modules.push({ key, ordinal: mod.ordinal, adaptive: false, questions });
      }
    }
    sections.push({ kind: section.kind, name: section.name, timeLimitSec: section.timeLimitSec, modules });
  }
  return {
    sections,
    routing: spec.routing || { thresholdFraction: 0.6 },
    meta: { notes: ctx.notes },
  };
}

/** Strip correct answers + rationale before sending a form to the client. */
export function sanitizeForm(form) {
  const clean = (q) => ({
    qid: q.qid,
    section: q.section,
    domain: q.domain,
    passage: q.passage,
    question: q.question,
    choices: q.choices,
    answerType: q.answerType,
    figure: q.figure,
    assetId: q.assetId,
  });
  return {
    routing: form.routing,
    sections: form.sections.map((s) => ({
      kind: s.kind,
      name: s.name,
      timeLimitSec: s.timeLimitSec,
      modules: s.modules.map((m) =>
        m.adaptive
          ? { key: m.key, ordinal: m.ordinal, adaptive: true,
              variants: { easy: m.variants.easy.map(clean), hard: m.variants.hard.map(clean) } }
          : { key: m.key, ordinal: m.ordinal, adaptive: false, questions: m.questions.map(clean),
              // A timed custom test times each module by its length (lib/examForm.js).
              ...(m.timeLimitSec ? { timeLimitSec: m.timeLimitSec } : {}) }),
    })),
  };
}
