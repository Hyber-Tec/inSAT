// Question bank routes (admin, institution-managed academies only; see
// routes/admin.js) - institution-scoped. Each academy's bank is private:
// list/generate/upload/manual/delete all read and write only the caller's
// institution (req.user.inst), and nothing here reaches insat's pool or the
// generation pool (lib/pool.js). Generation and upload extraction run inside
// this API (lib/generate.js, lib/ingest.js) and the verified results are
// imported into this bank.

import { Router } from 'express';
import { z } from 'zod';
import { COL, col, getRow, queryRows } from '../lib/store.js';
import { asyncHandler, parseBody, badRequest, notFound } from '../lib/http.js';
import { DOMAINS, DOMAIN_LABEL, isValidDomain } from '../lib/taxonomy.js';
import { config } from '../lib/config.js';
import { generateQuestions } from '../lib/generate.js';
import { extractFromUploads } from '../lib/ingest.js';
import { importRows, insertManualItem, rowToBankItem, updateBankItem } from '../lib/items.js';
import { aiStatus, getInstitutionCredentials } from '../lib/institutions.js';
import { POOL_SOURCES, touched } from '../lib/pool.js';
import { multipart } from '../lib/upload.js';

const router = Router();
const upload = multipart({ field: 'files', files: 10, fileSize: 25 * 1024 * 1024 });
const inst = (req) => req.user.inst;
// An academy's own questions. insat's own institution also holds the pool,
// which is never listed, edited or retired here (lib/pool.js).
const own = (r) => !POOL_SOURCES.includes(r.source);

/** This institution's own live questions. */
const ownItems = async (institutionId) => (await queryRows(
  col(COL.items).where('institution_id', '==', institutionId).where('retired_at', '==', null),
)).filter(own);

/** One of this institution's own questions, or null. */
async function ownItem(id, institutionId) {
  const r = await getRow(COL.items, id);
  return r && r.institution_id === institutionId && own(r) ? r : null;
}

// The institution's own LLM credentials (provider + key + optional model) so
// generation bills to them, not the platform. Enforces REQUIRE_INSTITUTION_KEY;
// otherwise an empty apiKey => platform key fallback (Anthropic) inside complete().
async function resolveCreds(req) {
  const creds = await getInstitutionCredentials(inst(req));
  if (!creds.apiKey && config.requireInstitutionKey) {
    throw badRequest("Add your institution's LLM API key in Settings to generate or upload questions.");
  }
  return creds;
}

// Bank meta: counts by section/domain/difficulty for THIS institution.
router.get('/meta', asyncHandler(async (req, res) => {
  const groups = new Map();
  for (const r of await ownItems(inst(req))) {
    const key = `${r.section}|${r.domain}|${r.difficulty}`;
    if (!groups.has(key)) groups.set(key, { section: r.section, domain: r.domain, difficulty: r.difficulty, n: 0 });
    groups.get(key).n += 1;
  }
  const rows = [...groups.values()];
  res.json({
    total: rows.reduce((a, b) => a + b.n, 0),
    counts: rows,
    domains: DOMAINS,
    domainLabels: DOMAIN_LABEL,
    generation: await aiStatus(inst(req)),
  });
}));

// List items (this institution), with optional filters.
router.get('/items', asyncHandler(async (req, res) => {
  const { section, domain, difficulty, search } = req.query;
  const needle = search ? String(search).toLowerCase() : null;
  const rows = (await ownItems(inst(req)))
    .filter((r) => (!section || r.section === section) && (!domain || r.domain === domain)
      && (!difficulty || r.difficulty === difficulty) && (!needle || String(r.question).toLowerCase().includes(needle)))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 500);
  res.json({ items: rows.map(rowToBankItem) });
}));

// Generate questions and import the verified ones into this bank.
const genSchema = z.object({
  section: z.enum(['rw', 'math']),
  domain: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  n: z.number().int().min(1).max(20).default(5),
  topic: z.string().optional().default(''),
});

router.post('/generate', asyncHandler(async (req, res) => {
  const d = parseBody(genSchema, req.body);
  if (!isValidDomain(d.section, d.domain)) throw badRequest('Invalid domain for that section');
  const creds = await resolveCreds(req);

  const results = await generateQuestions({
    section: d.section, domain: d.domain,
    difficulty: d.difficulty, n: d.n, topic: d.topic, creds,
  });
  const verifiedRows = results.filter((r) => r.status === 'verified').map((r) => r.row);
  const flagged = results.filter((r) => r.status !== 'verified').length;
  const imported = await importRows(verifiedRows, inst(req));
  res.json({ requested: d.n, verified: verifiedRows.length, flagged, ...imported });
}));

// Upload images / PDFs; the vision model extracts each question, we import them.
router.post('/ingest', upload, asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw badRequest('No files uploaded');
  const creds = await resolveCreds(req);
  const section = req.body.section || ''; // '' | 'Math' | 'English'
  const { rows, notes } = await extractFromUploads(files, { creds, section });
  const imported = await importRows(rows, inst(req));
  res.json({ extracted: rows.length, ...imported, notes });
}));

// Manual add from the admin editor.
const manualSchema = z.object({
  section: z.enum(['rw', 'math']),
  domain: z.string().default(''),
  skill: z.string().optional().default(''),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  passage: z.string().optional().nullable(),
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).length(4),
  correctIdx: z.number().int().min(0).max(3),
  rationale: z.any().optional(),
});

router.post('/manual', asyncHandler(async (req, res) => {
  const d = parseBody(manualSchema, req.body);
  const status = await insertManualItem(d, inst(req));
  res.json({ status });
}));

// Edit an existing item - updates the stored JSON for that question.
const editSchema = z.object({
  question: z.string().min(1),
  passage: z.string().optional().nullable(),
  answerType: z.enum(['multiple-choice', 'grid-in']).optional(),
  choices: z.array(z.string()).optional(),
  correctIdx: z.number().int().min(0).max(3).optional(),
  answerText: z.string().optional().nullable(),
  rationale: z.any().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
});

router.patch('/items/:id', asyncHandler(async (req, res) => {
  const d = parseBody(editSchema, req.body);
  if (!(await ownItem(req.params.id, inst(req)))) throw notFound('item');
  const item = await updateBankItem(req.params.id, inst(req), d);
  if (!item) throw notFound('item');
  res.json({ item });
}));

router.delete('/items/:id', asyncHandler(async (req, res) => {
  const item = await ownItem(req.params.id, inst(req));
  if (item && !item.retired_at) await col(COL.items).doc(item.id).update({ retired_at: new Date(), ...touched() });
  res.json({ ok: true });
}));

export default router;
