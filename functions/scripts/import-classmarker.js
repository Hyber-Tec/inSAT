// Imports an academy's own ClassMarker question pool into its bank, checked.
//
// Input is the decoded pool (tools/sat-extract/classmarker.py turns the
// ClassMarker export into one JSON record per question, with flags, and with
// --fetch-images downloads the images the questions show into images/ beside
// it). Questions that are repeats, College Board text or copied from CrackSAT
// are left out, and only well-formed ones are considered: multiple choice with
// four distinct choices and a key, or a numeric free response.
//
// Up to three passes through the Batches API, on the institution's own key:
//   0. Transcribe, for a question that shows images. A model reads the images
//      and writes the question as the bank holds it: an image of math, text
//      or a table becomes that text, and at most one real figure (a graph, a
//      diagram) stays a picture. Code then checks that the words around the
//      images survived and that the result is not College Board text; a
//      question that needs two figures, or a graph as a choice, stays out.
//   1. Blind. A model solves each question as the student will see it (its
//      figure attached) without its key, says whether it has exactly one
//      defensible answer, how closely it reads like a real SAT question (1-5),
//      and which section, domain, skill and difficulty it belongs to. A
//      question is kept only when the blind answer matches the academy's key,
//      it has one answer, and it rates 3 or more (drills, definitions and
//      grammar lessons rate lower and stay out). For a transcribed question
//      this is also the check on the transcription.
//   2. Keyed, for each kept question. The model writes explanations in the
//      bank's shape (why the answer is right, why each other choice is wrong,
//      never naming a letter, since choices are shuffled per student) from the
//      academy's own explanation when there is one, and lays the question out
//      (passage apart from the question, notes as bullets, math in LaTeX). A
//      check in code rejects any result whose words, numbers or choices differ
//      from what the blind pass solved.
// Kept questions go into the bank as source 'original' with their realism
// rating (a full practice test draws the most exam-like first; see
// assembly.js), their figure, and their ClassMarker record id. Progress is
// saved beside the input (stage0/1/2.jsonl), so a rerun continues where the
// last one stopped and never pays twice for a question.
//
// Run from functions/:
//   node --env-file=.env scripts/import-classmarker.js <questions.jsonl> --institution satify --dry-run
//   node --env-file=.env scripts/import-classmarker.js <questions.jsonl> --institution satify --limit 200
//   node --env-file=.env scripts/import-classmarker.js <questions.jsonl> --institution satify
//
// Flags:
//   --limit N        send at most N new questions through each pass this run
//   --per-request N  questions per model request (default 10; at most 8 images)
//   --no-images      leave out every question that shows an image
//   --skip-categories 166,222  leave out the academy's categories listed
//   --jobs           do the passes here instead of on an API key: write job
//                    files (jobs/<pass>-NNN.json, --job-size questions each,
//                    default 20) that Claude Code agents work through, each
//                    writing its results to stage<N>.d/<pass>-NNN.jsonl; rerun
//                    to take their results in, import what is finished and
//                    cut the next round
//   --passes blind,keyed  run (or cut jobs for) only these passes
//   --dry-run        count what the next run would send, spending nothing
//
// Questions already part way through go first: a transcribed question is
// checked blind before a new one is.
//
// A batch can take hours. If the run stops while waiting, run it again: it
// picks up the same batches (their ids are in <pass>.pending.json). A job
// without its results file is still out; delete it to have it cut again.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, pool } from '../lib/db.js';
import { config } from '../lib/config.js';
import { DOMAINS, SKILLS, DOMAIN_LABEL, canonicalSkill, sectionForDomain } from '../lib/taxonomy.js';
import { contentHash, importRows } from '../lib/items.js';
import { repairItemText } from '../lib/textRepair.js';
import { gridMatch } from '../lib/session.js';
import { parseJson } from '../lib/llm.js';
import { batchSupported, submitBatch, awaitBatch, batchResults } from '../lib/batch.js';
import { getInstitutionCredentials } from '../lib/institutions.js';

const args = process.argv.slice(2);
const VALUED = ['--institution', '--limit', '--per-request', '--job-size', '--skip-categories', '--passes'];
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const file = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const slug = arg('institution');
const limit = Number(arg('limit', 0)) || Infinity;
const perRequest = Math.max(1, Number(arg('per-request', 10)));
const withImages = !args.includes('--no-images');
const skipCategories = new Set(String(arg('skip-categories', '')).split(',').map((c) => c.trim()).filter(Boolean));
const jobsMode = args.includes('--jobs');
const jobSize = Math.max(1, Number(arg('job-size', 20)));
const passes = new Set(String(arg('passes', 'transcribe,blind,keyed')).split(','));
const dryRun = args.includes('--dry-run');

const LETTERS = ['A', 'B', 'C', 'D'];
const LEAVE_OUT = /^(college-board-text|mentions-cracksat|duplicate-of:)/;
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(\/\d+)?$/;
// "choice A", "answer is (B)", and "..., which gives C.": choices are shuffled per student.
const LETTER_REF = /\b(?:[Cc]hoices?|[Oo]ptions?|[Aa]nswer(?: is)?)\s*\(?[A-D]\)?(?![A-Za-z])|\bgives\s+\(?[A-D]\)?(?=[.,;]|$)/;
const PLACEHOLDER = /\[image ([^\]]+)\]/g;
const MIN_REALISM = 3;
const IMAGES_PER_REQUEST = 8;
const BATCH_BYTES = 150e6; // the Batches API takes up to 256 MB a batch

// The academy's Reading and Writing categories and the skills each holds, to
// check the sorting against. Its math categories are broader than one skill.
const ACADEMY_SKILLS = {};
for (const [ids, skills] of [
  [[211, 226], ['Words in Context']],
  [[212, 229], ['Text Structure and Purpose', 'Central Ideas and Details']],
  [[238, 228], ['Central Ideas and Details', 'Text Structure and Purpose']],
  [[231, 225], ['Inferences']],
  [[215, 237, 230], ['Command of Evidence']],
  [[219, 234, 135], ['Rhetorical Synthesis']],
  [[233, 218], ['Transitions']],
  [[232, 217], ['Boundaries', 'Form, Structure, and Sense']],
]) for (const id of ids) ACADEMY_SKILLS[id] = skills;

// The decode turns ClassMarker's markup into the bank's conventions; a question
// with markup that has no plain equivalent (struck-through text) stays out.
const UNTIDY = /\[\/?(?:s|img|url|table|tr|td|ul|ol|li|sqr|b|i|center)\]/;

/** The images a record shows, in order: the question's, then each choice's. */
const imagesOf = (r) => [...new Set([r.question, ...r.choices].flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1])))];

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

function wellFormed(r) {
  if (!r.question || [r.question, ...r.choices].some((t) => UNTIDY.test(t))) return false;
  if (r.type === 'multiplechoice') {
    const c = (r.choices || []).map((x) => String(x).trim());
    return c.length === 4 && c.every(Boolean) && new Set(c).size === 4 && /^[A-D]$/.test(r.answer || '');
  }
  if (r.type === 'freetext') {
    return (r.accepted || []).length > 0 && r.accepted.every((a) => NUMERIC.test(String(a).replace(/,/g, '').trim()));
  }
  return false;
}

// What a text says, without its layout: letters, digits, minus signs and
// decimal points, with LaTeX command names and underline tags dropped, so
// "\(\frac{5}{9}\)" reads as "5/9" does and "\(-3\)" does not read as "3".
const sig = (t) => String(t || '').normalize('NFKC').replace(/[\u2212\u2013]/g, '-')
  .replace(/<\/?u>/g, '').replace(/\\[a-zA-Z]+/g, ' ').toLowerCase().replace(/[^a-z0-9.-]/g, '');

/** 1 for the same sequence, falling with each character added, dropped or changed. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** A short text must say exactly the same; a long one may differ by a typo fixed. */
const sameText = (a, b, tolerance) => {
  const x = sig(a), y = sig(b);
  return Math.max(x.length, y.length) < 12 ? x === y : similarity(x, y) >= 1 - tolerance;
};

// Words as the decode's College Board check reads them.
const words = (t) => String(t || '').replace(/\[[^\]]*\]/g, ' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

/** Whether the words around a question's images all survived its transcription. */
function keepsWords(original, transcribed) {
  const have = new Set(words(transcribed));
  const want = words(original).filter((w) => w.length > 2 && /[a-z]/.test(w));
  return want.filter((w) => have.has(w)).length >= 0.95 * want.length;
}

/**
 * Whether a question is College Board text, by two tests against the College
 * Board bank and the DSAT tests:
 *  - three or more 10-word runs in common, as the decode checks (a run that
 *    five or more of those questions share is boilerplate, "Which choice
 *    completes the text...", not a copy), which finds a copied passage;
 *  - the same question with the same choices, which finds a short math
 *    question the runs cannot: three of four choices identical and the stems
 *    nearly so, or for a free response a stem of some length found whole.
 * The decode ran the first test on each question's own text; this runs both
 * on every question, and again on what a transcription reveals.
 */
function collegeBoardCheck(datasetDir) {
  const count = new Map();
  const refs = [];
  const byChoice = new Map();
  for (const name of ['cb.jsonl', 'dsat.jsonl']) {
    const p = path.join(datasetDir, name);
    if (!fs.existsSync(p)) continue;
    for (const r of readJsonl(p)) {
      for (const sh of runsOf(`${r.passage || ''} ${r.question || ''}`)) count.set(sh, (count.get(sh) || 0) + 1);
      const ref = { stem: sig(`${r.passage || ''} ${r.question || ''}`), choices: new Set((r.choices || []).map(sig).filter(Boolean)) };
      refs.push(ref);
      for (const c of ref.choices) { if (!byChoice.has(c)) byChoice.set(c, []); byChoice.get(c).push(ref); }
    }
  }
  if (!refs.length) {
    console.log(`(no College Board dataset in ${datasetDir}; questions are checked only by the decode's flags)`);
    return () => false;
  }
  const noChoiceRefs = refs.filter((r) => !r.choices.size && r.stem.length >= 40);
  return (text, choices = []) => {
    if ([...runsOf(text)].filter((sh) => (count.get(sh) || 0) >= 1 && count.get(sh) < 5).length >= 3) return true;
    const stem = sig(text);
    const mine = [...new Set(choices.map(sig).filter(Boolean))];
    if (mine.length === 4) {
      const hits = new Map();
      for (const c of mine) for (const ref of byChoice.get(c) || []) hits.set(ref, (hits.get(ref) || 0) + 1);
      for (const [ref, n] of hits) if (n >= 3 && similarity(stem, ref.stem.slice(-stem.length - 20)) >= 0.8) return true;
      return false;
    }
    return stem.length >= 40 && noChoiceRefs.some((ref) => ref.stem.includes(stem) || stem.includes(ref.stem));
  };
}
function runsOf(text) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + 10 <= w.length; i += 1) out.add(w.slice(i, i + 10).join(' '));
  return out;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line an agent wrote badly: that question goes again */ }
  }
  return out;
}
const append = (p, rows) => { if (rows.length) fs.appendFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

const taxonomy = ['rw', 'math'].map((section) => `${section === 'rw' ? 'Reading and Writing' : 'Math'}:\n${DOMAINS[section]
  .map((d) => `  domain "${d}" (${DOMAIN_LABEL[d]}): ${SKILLS[d].map((s) => `"${s}"`).join(', ')}`).join('\n')}`).join('\n');

const TRANSCRIBE_SYSTEM = `You turn SAT practice questions that contain images into text for a question bank. Each question comes with its text and its choices; each image is marked [image N] where it appears, and the images follow, each labeled with the question's id and N.

Return a JSON array with one object per question, in the order given:
{"id": "<id>", "usable": <true or false>, "question": "<the question with each image replaced, see below>", "choices": ["<A>", "<B>", "<C>", "<D>"], "figure": <the N of the one image kept as a picture, or null>, "why_not": "<when usable is false, a few words>"}

Rules:
- An image that shows only math, text or a table becomes exactly what it shows: math in LaTeX inside \\( \\) (for example \\(28x^{4} + 22x^{3}\\) or \\(\\frac{5}{9}\\)), a table as one line per row with cells separated by " | ", its title on the line above.
- An image that shows a graph, a diagram, a geometric figure, a number line, a chart or a picture stays a picture: give its N as "figure" and delete its marker from the text. The student sees the figure above the question. Keep at most one.
- choices are the four choices in order, each image in them replaced the same way; [] for a question where the student enters a number.
- usable is false when the question needs more than one picture, when a choice is itself a graph or a diagram, when an image cannot be read, or when something the question relies on is missing.
- Copy every other word, number and mark exactly. Do not solve the question or add to it.
Return only the JSON array.`;

const BLIND_SYSTEM = `You check SAT practice questions an academy wrote. For each question you get its text and its choices (or a note that the student enters a number), but not its key. A question marked "figure: attached" has its figure after the list, labeled with its id. Solve each one yourself, carefully.

Return a JSON array with one object per question, in the order given:
{"id": "<id>", "work": "<your working, at most three short lines>", "answer": "<the letter A-D, or the number for a student-produced response>", "single_correct": <true if exactly one choice (or one value) is defensible; false if none is or several are>, "realism": <1-5, see below>, "section": "rw" | "math", "domain": "<domain id>", "skill": "<skill name, exactly as listed>", "difficulty": "easy" | "medium" | "hard"}

realism is how closely the question matches one on the real digital SAT:
5 could appear unchanged on the test: the SAT's format, length and register, a question stem the SAT uses, and choices built the SAT's way (each wrong choice a plausible error).
4 SAT-style with small departures: a slightly unusual stem, length or context.
3 tests an SAT skill in an SAT-like way but reads as practice material: off format, a dated or informal register, choices that are easy to eliminate, or more mechanical than the SAT.
2 a basic drill: convert, simplify, round, bare arithmetic, a definition or vocabulary list, grammar-lesson instructions.
1 not an SAT question.

Difficulty follows the College Board's calibration: easy is direct and one step; hard needs a second inference, a subtle distinction or several steps.

The domains and skills:
${taxonomy}

Return only the JSON array.`;

const KEYED_SYSTEM = `You prepare checked SAT practice questions for a question bank. For each question you get its text, its choices in order (or a note that the student enters a number), its correct answer, and the academy's own explanation when there is one. A question marked "figure: attached" has its figure after the list, labeled with its id; the student sees it above the question.

Return a JSON array with one object per question, in the order given:
{"id": "<id>", "passage": "<Reading and Writing: everything above the question sentence; null for math>", "question": "<the question sentence; for math, everything the student reads before the choices>", "choices": ["<A>", "<B>", "<C>", "<D>"], "solutions": ["<for a student-produced response: each value that answers it, one entry unless it has several solutions; otherwise []>"], "rationale": {"correct": "<why the correct answer is correct>", "<letter of a wrong choice>": "<why it is wrong>", ...}}

Rules:
- Never change what the question says: the same words, numbers and punctuation, em dashes included. Only lay it out. Put the passage apart from the question sentence. Put an introductory line such as "The following text is adapted from ..." on its own line. Put "Text 1" and "Text 2" on their own lines. Put a student's notes one per line, each starting with "\u2022 ". Keep <u>...</u> underlines. Keep a table as given: one line per row, cells separated by " | ", its title (if any) on the line above. Separate the parts of a passage with one line break and no blank lines, except one blank line after a table. In math, put each displayed equation on its own line and a blank line before the question sentence. Write all math in LaTeX inside \\( \\), for example \\(4x^{3} + 2x^{2}\\) or \\(\\frac{5}{9}\\).
- choices are the same four choices in the same order, laid out the same way; [] for a student-produced response.
- rationale has "correct" and one entry for each wrong choice, keyed by its letter; for a student-produced response only "correct", working the solution through to the value.
- Explanations are clear and in the College Board's register, built from the academy's explanation when there is one (corrected if it is wrong). Never refer to a choice by its letter or position ("choice B", "the second option", "Answer is A"); choices are shuffled for each student, so say what the choice claims instead. Write no em dashes in explanations; to discuss a dash in the question, name it in words.
Return only the JSON array.`;

const response = (r) => (r.type === 'freetext' ? { response: 'student enters a number' } : { choices: r.choices });
const figureNote = (r) => (r.figure ? { figure: 'attached' } : {});
const blindItem = (r) => ({ id: r.id, text: r.question, ...response(r), ...figureNote(r) });
const keyedItem = (r) => ({
  id: r.id,
  text: r.question,
  ...(r.type === 'freetext'
    ? { response: 'student enters a number', correct_answer: r.accepted[0], also_accepted: r.accepted.slice(1) }
    : { choices: r.choices, correct: r.answer }),
  ...figureNote(r),
  academy_explanation: r.explanation ? r.explanation.replace(PLACEHOLDER, '[image]') : null,
});

/** A question for the transcriber: its images numbered where they appear, and the images. */
function transcribeItem(r) {
  const refs = imagesOf(r);
  const number = (t) => t.replace(PLACEHOLDER, (_, ref) => `[image ${refs.indexOf(ref) + 1}]`);
  return {
    item: { id: r.id, text: number(r.question), ...(r.type === 'freetext' ? { response: 'student enters a number' } : { choices: r.choices.map(number) }) },
    images: refs.map((ref, i) => ({ label: `${r.id} image ${i + 1}:`, file: r.imageFiles.get(ref) })),
  };
}
const imageBlock = (file) => {
  const bytes = fs.readFileSync(file);
  return { type: 'image', source: { type: 'base64', media_type: mimeOf(bytes), data: bytes.toString('base64') } };
};

/**
 * Model requests for a pass: up to perRequest questions each, and at most
 * IMAGES_PER_REQUEST images, which follow the list, each after its label.
 */
function requestsFor(name, records, shape, system, maxTokens) {
  const requests = [];
  let chunk = [];
  let images = 0;
  const flush = () => {
    if (!chunk.length) return;
    const text = JSON.stringify(chunk.map((c) => c.item));
    const attached = chunk.flatMap((c) => c.images);
    requests.push({
      customId: `${name}_${requests.length}`,
      system,
      ...(attached.length
        ? { content: [{ type: 'text', text }, ...attached.flatMap((a) => [{ type: 'text', text: a.label }, imageBlock(a.file)])] }
        : { prompt: text }),
      model: config.genModel,
      maxTokens,
    });
    chunk = [];
    images = 0;
  };
  for (const r of records) {
    const shaped = shape(r);
    if (chunk.length >= perRequest || (chunk.length && images + shaped.images.length > IMAGES_PER_REQUEST)) flush();
    chunk.push(shaped);
    images += shaped.images.length;
  }
  flush();
  return requests;
}
const withFigure = (toItem) => (r) => ({ item: toItem(r), images: r.figure ? [{ label: `Figure for ${r.id}:`, file: r.figure }] : [] });

/**
 * Send one pass as batches (a pass with images can be larger than one batch
 * may be) and parse what comes back. Each batch id is saved as soon as it is
 * submitted, so a run that stops while batches are processing (they can take
 * hours) picks them up next time instead of paying for them again. Call done()
 * once the results are saved.
 */
async function runPass(name, dir, requests, creds) {
  const pendingFile = path.join(dir, `${name}.pending.json`);
  let batchIds = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')).batchIds : null;
  if (batchIds) {
    console.log(`${name}: picking up ${batchIds.length === 1 ? `batch ${batchIds[0]}` : `${batchIds.length} batches`} from the last run`);
  } else {
    const list = requests();
    batchIds = [];
    let group = [];
    let bytes = 0;
    const submit = async () => {
      if (!group.length) return;
      batchIds.push(await submitBatch(group, { creds }));
      fs.writeFileSync(pendingFile, JSON.stringify({ batchIds }));
      console.log(`${name}: batch ${batchIds.at(-1)} submitted, ${group.length} requests`);
      group = [];
      bytes = 0;
    };
    for (const req of list) {
      const size = JSON.stringify(req.content || req.prompt).length;
      if (group.length && bytes + size > BATCH_BYTES) await submit();
      group.push(req);
      bytes += size;
    }
    await submit();
  }
  const out = [];
  const usage = { input: 0, cached: 0, output: 0 };
  let failed = 0;
  for (const batchId of batchIds) {
    let shown = 0;
    const batch = await awaitBatch(batchId, {
      creds,
      pollMs: 60000,
      timeoutMs: 24 * 60 * 60 * 1000,
      onTick: (c) => {
        if (Date.now() - shown < 10 * 60 * 1000) return;
        shown = Date.now();
        console.log(`  ${new Date().toLocaleTimeString()}  ${batchId}: ${c.succeeded || 0} done, ${c.processing || 0} processing, ${c.errored || 0} errored`);
      },
    });
    for (const [, res] of await batchResults(batch, { creds })) {
      const u = res.usage || {};
      usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage.cached += u.cache_read_input_tokens || 0;
      usage.output += u.output_tokens || 0;
      if (res.error || !res.text) { failed += 1; continue; }
      try {
        const arr = parseJson(res.text);
        for (const x of (Array.isArray(arr) ? arr : [])) if (x && x.id) out.push(x);
      } catch { failed += 1; }
    }
  }
  console.log(`  tokens: ${usage.input} input, ${usage.cached} cached input, ${usage.output} output`);
  if (failed) console.log(`  ${failed} requests returned nothing usable; their questions go again next run`);
  return { out, done: () => fs.rmSync(pendingFile, { force: true }) };
}

const HOW = `This is a job file. Do what "instructions" says for every entry in "questions".
Before answering, look at every image listed under "images" with the Read tool (each follows its label).
Where the instructions say to return a JSON array, write its objects to the file named in "out" instead: one JSON object per line, one line per question, in the order given, and nothing else. Create that file with the Write tool.
Work only from this file and its images. Do not open any other file.`;

/**
 * Job files for a pass, for Claude Code agents to work through: the same
 * questions, images and instructions a batch request would carry. Returns the
 * paths written.
 */
function cutJobs(name, n, records, shape, system, dir) {
  const jobsDir = path.join(dir, 'jobs');
  const outDir = path.join(dir, `stage${n}.d`);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const taken = new Set(fs.readdirSync(jobsDir).filter((f) => f.startsWith(`${name}-`)).map((f) => Number(f.slice(name.length + 1, -5))));
  let next = taken.size ? Math.max(...taken) + 1 : 1;
  const written = [];
  let chunk = [];
  let images = 0;
  const flush = () => {
    if (!chunk.length) return;
    const job = `${name}-${String(next).padStart(3, '0')}`;
    next += 1;
    const file = path.join(jobsDir, `${job}.json`);
    fs.writeFileSync(file, JSON.stringify({
      job,
      how: HOW,
      instructions: system,
      out: path.join(outDir, `${job}.jsonl`),
      questions: chunk.map((c) => c.item),
      images: chunk.flatMap((c) => c.images.map((a) => ({ label: a.label, file: a.file }))),
    }, null, 1));
    written.push(file);
    chunk = [];
    images = 0;
  };
  for (const r of records) {
    const shaped = shape(r);
    if (chunk.length >= jobSize || (chunk.length && images + shaped.images.length > 2 * IMAGES_PER_REQUEST)) flush();
    chunk.push(shaped);
    images += shaped.images.length;
  }
  flush();
  return written;
}

/** Ids in jobs that are still out (a job file whose results file is missing). */
function outstanding(name, n, dir) {
  const jobsDir = path.join(dir, 'jobs');
  if (!fs.existsSync(jobsDir)) return new Set();
  const ids = new Set();
  for (const f of fs.readdirSync(jobsDir).filter((x) => x.startsWith(`${name}-`) && x.endsWith('.json'))) {
    if (fs.existsSync(path.join(dir, `stage${n}.d`, f.replace(/\.json$/, '.jsonl')))) continue;
    for (const q of JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')).questions) ids.add(q.id);
  }
  return ids;
}

/**
 * A question that shows images, as its transcription has it, or why it
 * cannot be served. Its figure, if it keeps one, is the image file.
 */
function applyTranscription(r, t, isCollegeBoard) {
  if (t.usable !== true) return { skip: 'images cannot become text and one figure' };
  const free = r.type === 'freetext';
  const question = String(t.question || '').trim();
  const choices = free ? [] : (Array.isArray(t.choices) ? t.choices : []).map((c) => String(c).trim());
  const refs = imagesOf(r);
  const figure = t.figure == null ? null : refs[Number(t.figure) - 1];
  if (!question || [question, ...choices].some((x) => x.includes('[image'))) return { skip: 'transcription incomplete' };
  if (t.figure != null && !figure) return { skip: 'transcription incomplete' };
  if (!free && (choices.length !== 4 || !choices.every(Boolean) || new Set(choices).size !== 4)) return { skip: 'transcription incomplete' };
  // Text the academy typed must come through as typed; only its images change.
  const typedChoices = free ? true : r.choices.every((c, i) => c.includes('[image') || sameText(c, choices[i], 0.05));
  if (!typedChoices || !keepsWords(r.question, question)) return { skip: 'transcription changed the text' };
  if (isCollegeBoard(question, choices)) return { skip: 'College Board text' };
  return { record: { ...r, question, choices, figure: figure ? r.imageFiles.get(figure) : null } };
}

/** Why a blind verdict drops a question, or null when its key survives. */
function dropReason(r, v) {
  if (v.single_correct !== true) return 'no single defensible answer';
  if (!(Number(v.realism) >= MIN_REALISM)) return 'a drill or not SAT-like';
  if (!canonicalSkill(v.domain, v.skill) || sectionForDomain(v.domain) !== v.section || !['easy', 'medium', 'hard'].includes(v.difficulty)) {
    return 'no skill in the SAT taxonomy';
  }
  if (r.type === 'freetext') {
    if (v.section !== 'math') return 'no skill in the SAT taxonomy';
    return r.accepted.some((a) => gridMatch(String(v.answer ?? ''), a)) ? null : 'blind answer differs from the key';
  }
  const letter = /^\(?([A-D])\b/.exec(String(v.answer || '').trim().toUpperCase())?.[1];
  return letter === r.answer ? null : 'blind answer differs from the key';
}

/** The bank's passage layout: parts one line apart, a blank line only to end a table. */
function layout(t) {
  const out = [];
  for (const line of String(t).split('\n')) {
    if (!line.trim() && !(out.length && out[out.length - 1].includes(' | '))) continue;
    out.push(line.trim() ? line : '');
  }
  return out.join('\n').trim();
}

/** A finished question as a bank row, or why it cannot be one. */
function toRow(r, v, k) {
  const free = r.type === 'freetext';
  const choices = free ? [] : (k.choices || []).map((c) => String(c).trim());
  if (!free && (choices.length !== 4 || choices.some((c, i) => !c || !sameText(c, r.choices[i], 0.05)))) return { skip: 'choices changed' };
  const passage = v.section === 'rw' ? (layout(k.passage || '') || null) : null;
  const question = String(k.question || '').trim();
  if (!question || !sameText(`${passage || ''}\n${question}`, r.question, 0.03)) return { skip: 'question text changed' };

  // A free response keeps the academy's value; a list of accepted entries only
  // when the question has several solutions (scoring otherwise allows the
  // SAT's roundings of one value).
  let answerText = null;
  let accepted = null;
  if (free) {
    const sols = (Array.isArray(k.solutions) ? k.solutions : []).map((s) => String(s).replace(/,/g, '').trim()).filter((s) => NUMERIC.test(s));
    if (!sols.length || !sols.every((s) => r.accepted.some((a) => gridMatch(s, a))) || !sols.some((s) => gridMatch(s, r.accepted[0]))) {
      return { skip: 'solutions differ from the key' };
    }
    answerText = sols.find((s) => gridMatch(s, r.accepted[0]));
    if (sols.length > 1) accepted = sols;
  }

  const rat = k.rationale || {};
  const correct = String(rat.correct || '').trim();
  const wrong = free ? [] : LETTERS.filter((L) => L !== r.answer);
  if (!correct || wrong.some((L) => !String(rat[L] || '').trim())) return { skip: 'explanation missing' };
  if ([correct, ...wrong.map((L) => rat[L])].some((t) => LETTER_REF.test(t) || String(t).includes('\u2014'))) {
    return { skip: 'explanation names a letter or uses an em dash' };
  }
  let image = null;
  if (r.figure) {
    const bytes = fs.readFileSync(r.figure);
    image = { mime: mimeOf(bytes), bytes };
  }
  return {
    row: {
      // The figure is part of the question: two questions with the same words
      // and different figures are different questions.
      content_hash: contentHash({ section: v.section, question: image ? `${question}|${path.basename(r.figure)}` : question, choices, passage }),
      section: v.section,
      domain: v.domain,
      skill: canonicalSkill(v.domain, v.skill),
      difficulty: v.difficulty,
      passage,
      question,
      choices,
      correct_idx: free ? 0 : LETTERS.indexOf(r.answer),
      answer_type: free ? 'grid-in' : 'multiple-choice',
      answer_text: answerText,
      accepted,
      rationale: {
        correct,
        ...Object.fromEntries(wrong.map((L) => [L, String(rat[L]).trim()])),
        classmarker: { id: r.id, category: r.category, ...(image ? { figure: path.basename(r.figure) } : {}) },
      },
      figure: null,
      image,
      source: 'original',
      verified: true, // the academy's key, confirmed by a blind solve
      realism: Math.min(5, Math.round(Number(v.realism))),
    },
  };
}

const tally = (m, key) => m.set(key, (m.get(key) || 0) + 1);
const show = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`).join('\n');

async function main() {
  if (!file || !slug) {
    console.error('Usage: import-classmarker.js <questions.jsonl> --institution <slug> [--limit N] [--no-images] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const dir = path.dirname(path.resolve(file));
  const imagesDir = path.join(dir, 'images');
  const stage = (n) => path.join(dir, `stage${n}.jsonl`);

  // Every record worth considering: not left out by a flag, well formed, and
  // when it shows images, with each image on disk in a format the model reads.
  // A question that shows images is a repeat when its words and its images'
  // contents are (ClassMarker keeps a file per upload, so one figure can sit
  // under two names).
  const missing = new Set();
  const records = [];
  const pictures = new Set();
  let repeats = 0;
  let official = 0;
  const isCollegeBoard = collegeBoardCheck(path.join(dir, '..', 'dataset'));
  for (const r of readJsonl(file)) {
    if ((r.flags || []).some((f) => LEAVE_OUT.test(f)) || !wellFormed(r) || skipCategories.has(String(r.category))) continue;
    const refs = imagesOf(r);
    if (refs.length && !withImages) continue;
    if (isCollegeBoard(r.question, r.choices)) { official += 1; continue; }
    const files = new Map(refs.map((ref) => [ref, path.join(imagesDir, path.basename(ref))]));
    const absent = [...files.values()].filter((f) => !fs.existsSync(f) || !mimeOf(fs.readFileSync(f)));
    if (absent.length) { absent.forEach((f) => missing.add(f)); continue; }
    if (refs.length) {
      const h = crypto.createHash('sha1').update([r.question, ...r.choices].map((t) => sig(t.replace(PLACEHOLDER, '#'))).join('|'));
      for (const f of files.values()) h.update(fs.readFileSync(f));
      const key = h.digest('hex');
      if (pictures.has(key)) { repeats += 1; continue; }
      pictures.add(key);
    }
    records.push({ ...r, imageFiles: files });
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  // A stage is its batch results (stageN.jsonl) and its agents' (stageN.d/*.jsonl),
  // with what a student reads repaired where a writer damaged it (lib/textRepair.js).
  const load = (n) => {
    const d = path.join(dir, `stage${n}.d`);
    const parts = [stage(n), ...(fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(d, f)) : [])];
    return new Map(parts.flatMap(readJsonl).filter((x) => x && byId.has(x.id)).map((x) => [x.id, repairItemText(x)]));
  };
  const transcribed = load(0);
  const blind = load(1);
  const keyed = load(2);
  const pictured = records.filter((r) => r.imageFiles.size);

  // Each record as the student would see it: a question with images needs its transcription first.
  const setAside = new Map();
  const ready = () => {
    setAside.clear();
    const out = [];
    for (const r of records) {
      if (!r.imageFiles.size) { out.push(r); continue; }
      const t = transcribed.get(r.id);
      if (!t) continue;
      const { record, skip } = applyTranscription(r, t, isCollegeBoard);
      if (skip) tally(setAside, skip);
      else out.push(record);
    }
    return out;
  };
  const kept = (list) => list.filter((r) => blind.has(r.id) && !dropReason(r, blind.get(r.id)));
  // Questions already part way through (transcribed) before new ones.
  const blindTodo = (skip = new Set()) => {
    const todo = ready().filter((r) => !blind.has(r.id) && !skip.has(r.id));
    return [...todo.filter((r) => r.imageFiles.size), ...todo.filter((r) => !r.imageFiles.size)].slice(0, limit);
  };

  const free = records.filter((r) => r.type === 'freetext').length;
  console.log(`${records.length} usable questions (${records.length - free} multiple choice, ${free} free response; `
    + `${pictured.length} show images, ${transcribed.size} of them transcribed); `
    + `${blind.size} solved blind so far, ${keyed.size} explained`);
  if (repeats) console.log(`${repeats} questions with images repeat another's words and images, left out`);
  if (official) console.log(`${official} questions match the College Board bank or a DSAT test, left out`);
  if (missing.size) console.log(`${missing.size} images are not in ${imagesDir}; their questions wait (tools/sat-extract/classmarker.py --fetch-images)`);

  const todoTranscribe = pictured.filter((r) => !transcribed.has(r.id)).slice(0, limit);
  if (dryRun) {
    const todoBlind = ready().filter((r) => !blind.has(r.id));
    const chars = todoBlind.reduce((s, r) => s + JSON.stringify(blindItem(r)).length, 0);
    console.log(`--dry-run: the next run transcribes ${todoTranscribe.length} questions with images, then solves ${Math.min(limit, todoBlind.length)} questions blind `
      + `(about ${Math.round(chars / 4 / 1000)}k tokens of questions, ${Math.round(BLIND_SYSTEM.length / 4)} tokens of instructions a request, `
      + `and roughly 0.25k output tokens each; a transcription is about 0.5k input and 0.2k output), then explains those it keeps `
      + `(about 0.5k input and 1k output tokens each). Nothing sent.`);
    return;
  }

  const { rows: inst } = await query('SELECT id FROM pa_institutions WHERE slug = $1', [slug]);
  if (!inst[0]) throw new Error(`No institution with slug "${slug}"`);
  const cut = [];
  if (jobsMode) {
    const open = (name, n) => outstanding(name, n, dir);
    const t = open('transcribe', 0), b = open('blind', 1), k = open('keyed', 2);
    if (passes.has('transcribe')) cut.push(...cutJobs('transcribe', 0, pictured.filter((r) => !transcribed.has(r.id) && !t.has(r.id)).slice(0, limit), transcribeItem, TRANSCRIBE_SYSTEM, dir));
    if (passes.has('blind')) cut.push(...cutJobs('blind', 1, blindTodo(b), withFigure(blindItem), BLIND_SYSTEM, dir));
    if (passes.has('keyed')) cut.push(...cutJobs('keyed', 2, kept(ready()).filter((r) => !keyed.has(r.id) && !k.has(r.id)).slice(0, limit), withFigure(keyedItem), KEYED_SYSTEM, dir));
    console.log(`jobs out: ${t.size + b.size + k.size} questions in earlier jobs still without results`);
  }
  let creds = null;
  const ensureKey = async () => {
    creds ??= await getInstitutionCredentials(inst[0].id);
    if (!batchSupported(creds)) throw new Error('No Anthropic API key: add one in admin Settings (or ANTHROPIC_API_KEY in functions/.env).');
    return creds;
  };
  const pending = (name) => fs.existsSync(path.join(dir, `${name}.pending.json`));
  const pass = async (name, n, todo, shape, system, maxTokens, into) => {
    if (!todo.length && !pending(name)) return;
    const result = await runPass(name, dir, () => requestsFor(name, todo, shape, system, maxTokens), await ensureKey());
    const got = result.out.filter((x) => byId.has(x.id)).map(repairItemText);
    append(stage(n), got);
    for (const x of got) into.set(x.id, x);
    result.done();
  };

  if (!jobsMode) {
    if (passes.has('transcribe')) await pass('transcribe', 0, todoTranscribe, transcribeItem, TRANSCRIBE_SYSTEM, 8000, transcribed);
    if (passes.has('blind')) await pass('blind', 1, blindTodo(), withFigure(blindItem), BLIND_SYSTEM, 6000, blind);
    const todoKeyed = kept(ready()).filter((r) => !keyed.has(r.id)).slice(0, limit);
    if (passes.has('keyed')) await pass('keyed', 2, todoKeyed, withFigure(keyedItem), KEYED_SYSTEM, 16000, keyed);
  }

  // What the passes decided, and how the sorting agrees with the academy's own categories.
  const current = ready();
  const dropped = new Map();
  const realism = new Map();
  let compared = 0;
  let agreed = 0;
  for (const r of current) {
    const v = blind.get(r.id);
    if (!v) continue;
    const why = dropReason(r, v);
    if (why) { tally(dropped, why); continue; }
    tally(realism, `realism ${Math.round(Number(v.realism))}`);
    const expect = ACADEMY_SKILLS[Number(r.category)];
    if (expect) { compared += 1; if (expect.includes(canonicalSkill(v.domain, v.skill))) agreed += 1; }
  }
  const keptNow = kept(current);
  if (transcribed.size) {
    const usableNow = current.filter((r) => r.imageFiles.size).length;
    console.log(`\ntranscribe: ${transcribed.size} done, ${usableNow} usable, ${current.filter((r) => r.figure).length} of those keep a figure`);
    if (setAside.size) console.log(`set aside:\n${show(setAside)}`);
  }
  console.log(`\nblind: ${blind.size} solved, ${keptNow.length} kept`);
  if (dropped.size) console.log(`dropped:\n${show(dropped)}`);
  if (realism.size) console.log(`kept, by how closely they read like the SAT:\n${show(realism)}`);
  if (compared) console.log(`sorting: ${agreed} of ${compared} kept Reading and Writing questions land in a skill their ClassMarker category holds`);

  const rows = [];
  const skipped = new Map();
  for (const r of keptNow) {
    const k = keyed.get(r.id);
    if (!k) continue;
    const { row, skip } = toRow(r, blind.get(r.id), k);
    if (skip) tally(skipped, skip);
    else rows.push(row);
  }
  // The near-duplicate gate compares words, so a question with a figure skips
  // it: "What is the value of x?" over two different triangles is two questions.
  const a = await importRows(rows.filter((r) => !r.image), inst[0].id);
  const b = await importRows(rows.filter((r) => r.image), inst[0].id, { nearDuplicates: 'allow' });
  console.log(`\nready ${rows.length} (${rows.filter((r) => r.image).length} with a figure): +${a.added + b.added} added, `
    + `${a.duplicates + b.duplicates} already in the bank, ${a.nearDuplicates} near-duplicates`);
  if (skipped.size) console.log(`not imported:\n${show(skipped)}`);

  const bySkill = new Map();
  for (const r of rows) {
    const key = `${r.section === 'rw' ? 'R&W ' : 'Math'}  ${r.skill}`;
    const c = bySkill.get(key) || { easy: 0, medium: 0, hard: 0 };
    c[r.difficulty] += 1;
    bySkill.set(key, c);
  }
  if (bySkill.size) {
    console.log('\nby skill (easy / medium / hard):');
    for (const [key, c] of [...bySkill].sort()) console.log(`  ${key.padEnd(60).slice(0, 60)} ${c.easy} / ${c.medium} / ${c.hard}`);
  }
  if (cut.length) console.log(`\njobs cut for agents (${cut.length}):\n${cut.map((f) => `  ${f}`).join('\n')}`);
  const left = pictured.length - transcribed.size + current.filter((r) => !blind.has(r.id)).length + keptNow.filter((r) => !keyed.has(r.id)).length;
  if (left) console.log(`\n${left} questions still to go through a pass. Run again to continue.`);
}

main()
  .catch((err) => { console.error(`\nFailed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end?.());
