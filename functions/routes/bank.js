// Question bank routes (admin, institution-managed academies only; see
// routes/admin.js) - institution-scoped. Each academy's bank is private:
// list/generate/upload/manual/delete all read and write only the caller's
// institution (req.user.inst), and nothing here reaches insat's pool or the
// generation pool (lib/pool.js). Generation and upload extraction run inside
// this API (lib/generate.js, lib/ingest.js) and the verified results are
// imported into this bank.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { asyncHandler, parseBody, badRequest, notFound } from '../lib/http.js';
import { DOMAINS, DOMAIN_LABEL, isValidDomain } from '../lib/taxonomy.js';
import { config } from '../lib/config.js';
import { generateQuestions } from '../lib/generate.js';
import { extractFromUploads } from '../lib/ingest.js';
import { importRows, insertManualItem, rowToBankItem, updateBankItem } from '../lib/items.js';
import { aiStatus, getInstitutionCredentials } from '../lib/institutions.js';
import { POOL_SOURCES } from '../lib/pool.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const inst = (req) => req.user.inst;
// An academy's own questions. insat's own institution also holds the pool,
// which is never listed, edited or retired here (lib/pool.js).
const OWN = 'NOT (source = ANY($2::text[]))';

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
  const { rows } = await query(
    `SELECT section, domain, difficulty, COUNT(*)::int AS n
       FROM pa_items WHERE institution_id = $1 AND retired_at IS NULL AND ${OWN}
      GROUP BY section, domain, difficulty`,
    [inst(req), POOL_SOURCES],
  );
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
  const where = ['institution_id = $1', OWN, 'retired_at IS NULL'];
  const params = [inst(req), POOL_SOURCES];
  let i = 3;
  if (section) { where.push(`section = $${i++}`); params.push(section); }
  if (domain) { where.push(`domain = $${i++}`); params.push(domain); }
  if (difficulty) { where.push(`difficulty = $${i++}`); params.push(difficulty); }
  if (search) { where.push(`question ILIKE $${i++}`); params.push(`%${search}%`); }
  const { rows } = await query(
    `SELECT * FROM pa_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`,
    params,
  );
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
router.post('/ingest', upload.array('files'), asyncHandler(async (req, res) => {
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
  const own = await query(`SELECT 1 FROM pa_items WHERE institution_id = $1 AND ${OWN} AND id = $3`, [inst(req), POOL_SOURCES, req.params.id]);
  if (!own.rows.length) throw notFound('item');
  const item = await updateBankItem(req.params.id, inst(req), d);
  if (!item) throw notFound('item');
  res.json({ item });
}));

router.delete('/items/:id', asyncHandler(async (req, res) => {
  await query(`UPDATE pa_items SET retired_at = now() WHERE institution_id = $1 AND ${OWN} AND id = $3`, [inst(req), POOL_SOURCES, req.params.id]);
  res.json({ ok: true });
}));

export default router;
