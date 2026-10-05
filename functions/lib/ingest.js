// Extract SAT questions from uploaded images / PDFs using the vision model,
// inside this API (no external service). Returns rows in pa_items shape plus
// per-file notes. Extracted items are marked unverified so an admin can review
// the inferred answer. Figures are not auto-attached (text questions only).

import { PDFDocument } from 'pdf-lib';
import { complete, parseJson } from './llm.js';
import { contentHash } from './items.js';
import { DOMAIN_LABEL, DOMAINS, canonicalSkill, sectionForDomain } from './taxonomy.js';
import { config } from './config.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const DOMAIN_HINT = Object.entries(DOMAIN_LABEL).map(([id, label]) => `"${id}" (${label})`).join(', ');
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

// A whole practice-test PDF has far more questions than one model call can
// return under the output-token cap, so split it into small page groups and
// extract each separately, in parallel. Page size, parallelism, and model are
// env-tunable (EXTRACT_CHUNK_PAGES / EXTRACT_CONCURRENCY / EXTRACT_MODEL).

function extractPrompt(sectionHint) {
  const sec = sectionHint === 'Math'
    ? 'These are Math questions.'
    : sectionHint === 'English'
      ? 'These are Reading & Writing questions.'
      : 'Detect the section ("rw" or "math") for each question.';
  return `Extract EVERY complete SAT question visible in this file. ${sec}

The file may be in any layout - one or many questions per page, with or without shared passages, multiple-choice or student-produced (grid-in), and it may also contain an answer key or full answer explanations. When an answer key or explanation is present, USE IT to set the correct answer and rationale for the matching question. If you only see an answer key entry (no question text), skip it.

For each question, classify its domain (one of: ${DOMAIN_HINT}), determine the single correct answer, and write a brief rationale. Include whatever passage or stimulus the question needs. Write any math - variables, expressions, equations - in LaTeX wrapped in \\( ... \\) delimiters (e.g. \\(x^2 - 4\\), \\(\\frac{3}{4}\\)).

A digital SAT section (Reading & Writing, and Math) is split into two modules, separated by a page that reads "Module 2". For each question's "module": everything before that break in a section is module 1, and every question from the "Module 2" page onward in the same section is module 2. If this file shows no Module 2 break, use 1 for all.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "section": "rw" | "math",
  "module": 1 | 2,
  "domain": "<one of the ids above>",
  "difficulty": "easy" | "medium" | "hard",
  "passage": string or null,
  "question": string,
  "answer_type": "multiple-choice" | "grid-in",
  "choices": [string, string, string, string],
  "answer": "A" | "B" | "C" | "D" | "<numeric for grid-in>",
  "skill": short string,
  "rationale": short string
}
Skip anything that is not a complete, answerable question. If a question depends on a figure or diagram you cannot fully read, skip it.`;
}

function rowFromExtracted(g) {
  const kind = g.section === 'math' ? 'math' : g.section === 'rw' ? 'rw' : sectionForDomain(g.domain);
  const domain = (DOMAINS[kind] || []).includes(g.domain) ? g.domain : '';
  const answerType = g.answer_type === 'grid-in' ? 'grid-in' : 'multiple-choice';
  const question = String(g.question || '').trim();
  const passage = kind === 'rw' && g.passage ? String(g.passage).trim() : null;
  let choices = [];
  let correctIdx = 0;
  let answerText = null;
  if (answerType === 'grid-in') {
    answerText = String(g.answer ?? '').trim();
  } else {
    choices = (g.choices || []).map((c) => String(c ?? '').trim()).slice(0, 4);
    correctIdx = LETTERS.indexOf(String(g.answer || 'A').trim().toUpperCase());
    if (correctIdx < 0) correctIdx = 0;
  }
  // Module 1 or 2 within the section (digital SAT has two modules per section).
  const module = Number(g.module) === 2 ? 2 : 1;
  return {
    content_hash: contentHash({ section: kind, question, choices, passage }),
    section: kind,
    module,
    domain,
    skill: canonicalSkill(domain, g.skill) || String(g.skill || '').slice(0, 80),
    difficulty: ['easy', 'medium', 'hard'].includes(g.difficulty) ? g.difficulty : 'medium',
    passage,
    question,
    choices,
    correct_idx: correctIdx,
    answer_type: answerType,
    answer_text: answerText,
    rationale: g.rationale ? { correct: String(g.rationale) } : {},
    figure: null,
    image_ref: null,
    source: 'extracted-from-upload',
    verified: false,
  };
}

// Walk a section's questions in page order and carry the module number forward
// (it only ever increases within a section), so questions on pages without a
// visible "Module 2" header still land in the right module. Clamped to 1-2.
function assignModules(rows) {
  for (const kind of ['rw', 'math']) {
    let current = 1;
    for (const r of rows) {
      if (r.section !== kind) continue;
      current = Math.max(current, Number(r.module) === 2 ? 2 : 1);
      r.module = current;
    }
  }
  return rows;
}

// Force every row into a chosen section + module (when the admin picks a target
// like "Math · Module 2" instead of auto-detect). Recomputes the content hash
// since it includes the section.
function applyTarget(row, target) {
  row.section = target.kind;
  row.module = target.module;
  if (!(DOMAINS[target.kind] || []).includes(row.domain)) row.domain = '';
  if (target.kind === 'math') row.passage = null;
  row.content_hash = contentHash({ section: row.section, question: row.question, choices: row.choices, passage: row.passage });
  return row;
}

// Parse a model response into validated, normalized rows (no dedup here).
function rowsFromText(text) {
  let parsed;
  try { parsed = parseJson(text); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : (parsed.questions || parsed.items || []);
  const out = [];
  for (const g of arr) {
    const row = rowFromExtracted(g);
    const ok = row.question && (row.answer_type === 'grid-in'
      ? row.answer_text
      : row.choices.length === 4 && row.choices.every(Boolean));
    if (ok) out.push(row);
  }
  return out;
}

// Split a PDF into base64-encoded page groups for separate extraction calls.
// Consecutive groups overlap by one page so a question whose passage and stem
// straddle a page boundary is still captured whole in at least one group; the
// duplicate from the overlap is collapsed later by content hash.
async function pdfPageChunks(buffer, pagesPerChunk = config.extractChunkPages) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const overlap = total > pagesPerChunk ? 1 : 0;
  const step = Math.max(1, pagesPerChunk - overlap);
  const chunks = [];
  for (let start = 0; start < total; start += step) {
    const end = Math.min(start + pagesPerChunk, total);
    const sub = await PDFDocument.create();
    const idxs = [];
    for (let p = start; p < end; p += 1) idxs.push(p);
    const copied = await sub.copyPages(src, idxs);
    copied.forEach((pg) => sub.addPage(pg));
    const bytes = await sub.save();
    chunks.push(Buffer.from(bytes).toString('base64'));
    if (end >= total) break;
  }
  return chunks;
}

// Run async fn over items with a small concurrency cap; preserves order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next; next += 1;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function extractFile(f, { creds, section, notes }) {
  // Multi-page PDFs are split into page groups; images go in a single call.
  let payloads;
  let split = false;
  if (f.mimetype === 'application/pdf') {
    try {
      payloads = await pdfPageChunks(f.buffer);
      split = payloads.length > 1;
    } catch (err) {
      notes.push(`${f.originalname}: could not split pages (${err.message}); trying whole file`);
      payloads = [f.buffer.toString('base64')];
    }
  } else {
    payloads = [f.buffer.toString('base64')];
  }
  const media = f.mimetype;

  const parts = await mapLimit(payloads, config.extractConcurrency, async (data, ci) => {
    try {
      const text = await complete({
        creds,
        model: config.extractModel,
        prompt: extractPrompt(section),
        image: { media, data },
        // Thinking shares the max_tokens cap on Claude 4.7+ models, so leave
        // headroom above the largest expected JSON payload. Extraction is
        // transcription, not problem solving - medium effort keeps parity with
        // the old default while cutting thinking spend on this high-volume path.
        maxTokens: 20000,
        effort: 'medium',
      });
      return rowsFromText(text);
    } catch (err) {
      notes.push(`failed ${f.originalname} part ${ci + 1}/${payloads.length}: ${err.message}`);
      return [];
    }
  });
  const found = parts.flat();
  notes.push(`${f.originalname}: ${found.length} question${found.length === 1 ? '' : 's'}${split ? ` from ${payloads.length} page groups` : ''}`);
  return found;
}

/**
 * Extract questions from a batch of uploaded files (lib/upload.js). Whole PDFs are chunked by page
 * so a full practice test is captured rather than truncated at the token cap.
 * Duplicates (the same question repeated, e.g. in an answer-key section) are
 * collapsed by content hash across the whole upload.
 * @returns {Promise<{rows: object[], notes: string[]}>}
 */
export async function extractFromUploads(files, { creds = {}, section = '', target = null } = {}) {
  const notes = [];
  // Keyed by content hash, preserving first-seen order. When the same question
  // appears more than once (e.g. in the test section AND the answer-explanation
  // section), keep whichever carries the real answer rationale.
  const byHash = new Map();
  const rationaleLen = (r) => String((r.rationale && r.rationale.correct) || '').length;
  for (const f of files) {
    if (!SUPPORTED.has(f.mimetype)) {
      notes.push(`skipped ${f.originalname} (unsupported type ${f.mimetype})`);
      continue;
    }
    let found = await extractFile(f, { creds, section, notes });
    if (target) found = found.map((r) => applyTarget(r, target));
    for (const row of found) {
      const existing = byHash.get(row.content_hash);
      if (!existing) byHash.set(row.content_hash, row);
      else if (rationaleLen(row) > rationaleLen(existing)) {
        // Keep the answer/rationale from the richer copy, but the module from
        // where the question first appeared (the test, not the answer key).
        if (!target) row.module = existing.module;
        byHash.set(row.content_hash, row);
      }
    }
  }
  // Auto-detected uploads get module numbers smoothed across pages; a forced
  // target already pinned every row's module.
  const rows = target ? [...byHash.values()] : assignModules([...byHash.values()]);
  return { rows, notes };
}
