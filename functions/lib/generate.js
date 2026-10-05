// Native SAT question generation, for a managed academy's own tests. Drafts
// items with a fast model, using real SAT questions from the generation pool
// as few-shot style references (zero-shot when it has none), then
// independently verifies each draft with a strong model. Returns rows already
// in pa_items shape, ready to import. This replaces the old external satGen
// service - generation now lives inside the testing app.

import { COL, col, queryRows } from './store.js';
import { complete, parseJson } from './llm.js';
import { contentHash } from './items.js';
import { gridMatch } from './session.js';
import { renderFigure, describeFigure } from './figures.js';
import { globalPoolId } from './pool.js';
import { DOMAINS, DOMAIN_LABEL, SKILLS, canonicalSkill, sectionForDomain, isValidDomain } from './taxonomy.js';
import { config } from './config.js';

const LETTERS = ['A', 'B', 'C', 'D'];

/** Shared by the synchronous and batch paths; identical bytes keep the cache warm. */
export const GEN_SYSTEM =
  'You are an expert College Board SAT item writer. You write original, exam-accurate questions and output strict JSON only.';
const SECTION_LABEL = { rw: 'Reading and Writing', math: 'Math' };

// Up to k exemplars for this section+domain from the generation pool (the
// reference questions and a copy of insat's pool, lib/pool.js), as style
// references. An empty result is fine - generation falls back to zero-shot.
//
// Reference items (the imported College Board bank and practice tests) are
// preferred: they are real, difficulty-calibrated questions and are the best
// style anchor there is. They are never served on an exam (see
// candidatesFor() in assembly.js), so shaping generation is exactly and only
// what they are for. Among them, the same skill and then the same difficulty
// come first, so a request for a hard Boundaries item is shown hard Boundaries
// items. Items with a figure are left out (the prompt carries text only, so
// "the graph shown" would point at nothing), as are items whose answer key was
// flagged during transcription.
export async function exemplars(kind, domain, k = 3, { difficulty = null, skill = null } = {}) {
  const pool = await globalPoolId();
  const rows = (await queryRows(col(COL.items)
    .where('institution_id', '==', pool).where('section', '==', kind).where('domain', '==', domain)
    .where('retired_at', '==', null)
    .select('passage', 'question', 'choices', 'correct_idx', 'answer_type', 'answer_text', 'skill', 'difficulty', 'rationale', 'source', 'asset_id')))
    .filter((r) => !r.asset_id && !(r.rationale?.flags || []).some((f) => String(f).startsWith('key-')));
  // Reference first, then the same skill, then the same difficulty; random among equals.
  const rank = (r) => [r.source === 'reference' ? 0 : 1, r.skill === (skill || '') ? 0 : 1, r.difficulty === (difficulty || '') ? 0 : 1, Math.random()];
  const keyed = rows.map((r) => [rank(r), r]);
  keyed.sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  return keyed.slice(0, k).map(([, r]) => r);
}

// How much of an example's explanation to show: enough for its depth and tone.
const EXPLANATION_CHARS = 900;

function exemplarText(rows) {
  if (!rows.length) return '';
  const blocks = rows.map((r, i) => {
    const lines = [`Example ${i + 1}:`];
    if (r.skill) lines.push(`Skill: ${r.skill}`);
    if (r.passage) lines.push(`Passage: ${r.passage}`);
    lines.push(`Question: ${r.question}`);
    if (r.answer_type === 'grid-in') {
      lines.push(`(student-produced response) Answer: ${r.answer_text}`);
    } else {
      (r.choices || []).forEach((c, j) => lines.push(`${LETTERS[j]}. ${c}`));
      lines.push(`Answer: ${LETTERS[r.correct_idx] || 'A'}`);
    }
    const why = String(r.rationale?.correct || '').trim();
    if (why) lines.push(`Explanation: ${why.length > EXPLANATION_CHARS ? `${why.slice(0, EXPLANATION_CHARS)}...` : why}`);
    return lines.join('\n');
  });
  return `\n\nHere are real SAT questions of this kind, with how they are explained. Match their style, difficulty and depth of explanation, but write entirely NEW questions (never copy them):\n\n${blocks.join('\n\n')}`;
}

const FIGURE_GUIDE = `
If a math question needs a graph or chart, include a "figure" object (otherwise set "figure": null). Only use a figure when the question genuinely needs one, and never reference a figure you did not include. Always add a "description" summarizing it. Supported specs:
- Function graph: {"type":"function-graph","xRange":[-10,10],"yRange":[-10,10],"functions":[{"kind":"linear","m":2,"b":-1},{"kind":"quadratic","a":1,"b":0,"c":-4}],"points":[{"x":2,"y":0,"label":"A"}],"description":"..."}
- Bar chart: {"type":"bar","categories":["A","B","C"],"values":[4,7,2],"xLabel":"...","yLabel":"...","description":"..."}
- Line graph: {"type":"line","points":[{"x":0,"y":1},{"x":1,"y":3}],"xLabel":"...","yLabel":"...","description":"..."}
- Scatter: {"type":"scatter","points":[{"x":1,"y":2},{"x":3,"y":5}],"xLabel":"...","yLabel":"...","description":"..."}
- Geometry / other: {"type":"svg","svg":"<svg viewBox='0 0 200 200'>...</svg>","caption":"...","description":"..."} (use only plain shapes/lines/text; no scripts, no external images)`;

export function genPrompt({ kind, domain, difficulty, n, topic, exRows }) {
  const dl = DOMAIN_LABEL[domain] || domain;
  const sl = SECTION_LABEL[kind] || kind;
  const isMath = kind === 'math';
  const sectionNote = isMath
    ? ' Each question is either multiple-choice (exactly 4 options) or "grid-in" (a student-produced numeric response with NO choices). Prefer multiple-choice; use grid-in only when it fits naturally.'
    : ' Each question is multiple-choice with exactly 4 options. Put any reading passage or sentence stimulus the question needs in "passage".';
  // A topic that names one of the domain's skills targets that skill exactly
  // (practice aimed at a weakness); anything else is a looser focus.
  const skill = canonicalSkill(domain, topic);
  const topicNote = skill ? ` Every question must test this skill: ${skill}.` : topic ? ` Focus on this topic: ${topic}.` : '';
  const skillList = (SKILLS[domain] || []).map((x) => `"${x}"`).join(' | ');
  const figureField = isMath ? '\n  "figure": <figure spec object or null>,' : '';
  const noFigureRule = isMath
    ? ''
    : ' Do not reference a diagram or image - Reading & Writing questions have no figures.';
  return `Write ${n} original, high-quality College Board digital SAT ${sl} questions.
Domain: ${dl}. Difficulty: ${difficulty}.${topicNote}${sectionNote}

Every question must be self-contained, unambiguous, and have exactly ONE correct answer. Write ALL math - variables, expressions, and equations - in LaTeX wrapped in \\( ... \\) delimiters, e.g. \\(f(x) = x^2 - 4\\), \\(\\frac{3}{4}\\), \\(\\sqrt{5}\\). Never put bare LaTeX commands outside \\( \\).${noFigureRule}

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "passage": string or null,
  "question": string,
  "answer_type": "multiple-choice" | "grid-in",
  "choices": [string, string, string, string],
  "answer": "A" | "B" | "C" | "D" | "<numeric string for grid-in>",${figureField}
  "skill": ${skillList || 'short string naming the skill'},
  "rationale": {
    "correct": "a complete explanation of why the correct answer is right, worked step by step the way the College Board explains it",
    "A": "why this choice is right or wrong", "B": "...", "C": "...", "D": "..."
  }
}
For a grid-in question, "rationale" has only "correct". Explanations must never refer to a choice by its letter: the choices are shuffled when shown, so name a choice by its content instead.${isMath ? `\n${FIGURE_GUIDE}` : ''}${exemplarText(exRows)}`;
}

function rationaleFrom(r) {
  if (r && typeof r === 'object') {
    return Object.fromEntries(['correct', ...LETTERS].filter((k) => r[k]).map((k) => [k, String(r[k]).trim()]));
  }
  return r ? { correct: String(r).trim() } : {};
}

export function rowFromGenerated(g, { kind, domain, difficulty, topic = '' }) {
  g = g && typeof g === 'object' ? g : {};
  const answerType = g.answer_type;
  const question = String(g.question || '').trim();
  const passage = kind === 'rw' && g.passage ? String(g.passage).trim() : null;
  let choices = [];
  let correctIdx = 0;
  let answerText = null;
  if (answerType === 'grid-in') {
    answerText = String(g.answer ?? '').trim();
  } else {
    choices = Array.isArray(g.choices) ? g.choices.map((c) => String(c ?? '').trim()) : [];
    correctIdx = LETTERS.indexOf(String(g.answer || '').trim().toUpperCase());
  }
  // Render the optional figure spec to SVG now; if it doesn't render, drop it.
  let figure = null;
  let svg = null;
  let figureDesc = '';
  if (kind === 'math' && g.figure && typeof g.figure === 'object') {
    const rendered = renderFigure(g.figure);
    if (rendered) { figure = g.figure; svg = rendered.svg; figureDesc = rendered.description; }
  }

  return {
    content_hash: contentHash({ section: kind, question, choices, passage }),
    section: kind,
    domain,
    skill: canonicalSkill(domain, g.skill),
    requestedSkill: canonicalSkill(domain, topic), // transient: enforce targeted practice
    difficulty: ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium',
    passage,
    question,
    choices,
    correct_idx: correctIdx,
    answer_type: answerType,
    answer_text: answerText,
    rationale: rationaleFrom(g.rationale),
    figure,
    svg,           // transient - items.insertItem stores it as an SVG asset
    figureDesc,    // transient - passed to the verifier for context
    image_ref: null,
    source: 'ai-generated',
    verified: false,
  };
}

export function usable(row) {
  if (!row.question || !isValidDomain(row.section, row.domain)
      || !canonicalSkill(row.domain, row.skill) || !row.rationale?.correct) return false;
  if (row.requestedSkill && row.skill !== row.requestedSkill) return false;
  if (row.answer_type === 'grid-in') return row.section === 'math' && Boolean(row.answer_text);
  return row.answer_type === 'multiple-choice'
    && Number.isInteger(row.correct_idx) && row.correct_idx >= 0 && row.correct_idx < 4
    && row.choices.length === 4 && row.choices.every(Boolean)
    && new Set(row.choices.map((c) => c.toLowerCase())).size === 4
    && LETTERS.every((letter) => row.rationale[letter]);
}

// Independently solve each drafted item with the strong model; returns an array
// aligned to `rows` of { answer, single_correct, domain, skill } | null.
export async function verifyBatch(rows, { creds }) {
  const body = rows.map((r, i) => {
    const lines = [`#${i}`];
    if (r.passage) lines.push(`Passage: ${r.passage}`);
    if (r.figureDesc) lines.push(`Figure: ${r.figureDesc}`);
    lines.push(`Question: ${r.question}`);
    if (r.answer_type === 'grid-in') lines.push('(student-produced response - give the numeric answer)');
    else r.choices.forEach((c, j) => lines.push(`${LETTERS[j]}. ${c}`));
    return lines.join('\n');
  }).join('\n\n');

  const taxonomy = Object.values(DOMAINS).flat().map((domain) => ({ domain, skills: SKILLS[domain] }));
  const prompt = `Solve each SAT question below yourself, independently. For each, give your answer and whether exactly one option/value is correct and the question is unambiguous. Independently identify the SAT domain and the specific skill actually tested. If the question is not suitable for the SAT or cannot be classified, return null for domain and skill.

Use exactly these domain IDs and skill labels: ${JSON.stringify(taxonomy)}.

Return ONLY a JSON array, one element per question: {"i": <index number>, "answer": "A"|"B"|"C"|"D"|"<numeric>", "single_correct": true|false, "domain": "<domain ID>", "skill": "<skill label>"}.

${body}`;

  try {
    // Verification is where wrong answer keys get caught: the model actually
    // solves each question, and on Claude 4.7+ that solving happens in thinking
    // tokens, which share the max_tokens cap - so the cap must fit the work,
    // not just the small JSON verdict.
    const arr = parseJson(await complete({ creds, model: config.verifyModel, prompt, maxTokens: 8000 }));
    const byIdx = new Map();
    for (const v of Array.isArray(arr) ? arr : []) {
      if (!v || !Number.isInteger(v.i) || v.i < 0 || v.i >= rows.length) continue;
      // Duplicate indices make the verdict ambiguous; never pick the last one.
      byIdx.set(v.i, byIdx.has(v.i) ? null : v);
    }
    return rows.map((_, i) => byIdx.get(i) || null);
  } catch {
    // Verification unavailable - leave everything to be flagged, not trusted.
    return rows.map(() => null);
  }
}

export function answerMatches(row, verdict) {
  if (!verdict || verdict.single_correct !== true) return false;
  if (row.answer_type === 'grid-in') return gridMatch(String(verdict.answer ?? ''), row.answer_text);
  return LETTERS.includes(String(verdict.answer || '').trim().toUpperCase())
    && String(verdict.answer || '').trim().toUpperCase() === LETTERS[row.correct_idx];
}

/** Both the answer and the skill must survive independent verification. */
export function verifiedGenerated(row, verdict) {
  return usable(row) && answerMatches(row, verdict)
    && verdict.domain === row.domain
    && canonicalSkill(verdict.domain, verdict.skill) === row.skill;
}

/**
 * Draft + verify N questions. Returns [{ status:'verified'|'flagged', row, verdict }].
 * The caller imports the rows it wants (typically only the verified ones).
 */
export async function generateQuestions({ section, domain, difficulty = 'medium', n = 5, topic = '', creds = {} }) {
  const kind = section || sectionForDomain(domain);
  const exRows = await exemplars(kind, domain, 3, { difficulty, skill: topic });

  const draftText = await complete({
    creds,
    model: config.genModel,
    system: GEN_SYSTEM,
    prompt: genPrompt({ kind, domain, difficulty, n, topic, exRows }),
    // Thinking shares this cap on Claude 4.7+ - room for it plus N questions of
    // JSON, each now carrying a full explanation per choice.
    maxTokens: 16000,
  });

  let drafted = [];
  try {
    const parsed = parseJson(draftText);
    drafted = Array.isArray(parsed) ? parsed : (parsed.questions || parsed.items || []);
  } catch {
    drafted = [];
  }

  const rows = (Array.isArray(drafted) ? drafted : [])
    .map((g) => rowFromGenerated(g, { kind, domain, difficulty, topic }))
    .filter(usable)
    .slice(0, n);
  if (!rows.length) return [];

  const verdicts = await verifyBatch(rows, { creds });
  return rows.map((row, i) => {
    const ok = verifiedGenerated(row, verdicts[i]);
    return { status: ok ? 'verified' : 'flagged', row: { ...row, verified: ok }, verdict: verdicts[i] };
  });
}
