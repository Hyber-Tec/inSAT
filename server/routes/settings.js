// Institution settings (admin) - currently the institution's own LLM API key.
// The key is encrypted at rest and never returned; only its status + a hint.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { asyncHandler, parseBody, badRequest } from '../lib/http.js';
import { keyStatus, setInstitutionKey, clearInstitutionKey } from '../lib/institutions.js';

const router = Router();
const inst = (req) => req.user.inst;
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.get('/llm-key', asyncHandler(async (req, res) => {
  res.json(await keyStatus(inst(req)));
}));

router.put('/llm-key', asyncHandler(async (req, res) => {
  const { apiKey, provider, model } = parseBody(
    z.object({
      apiKey: z.string().min(8),
      provider: z.string().optional(),
      model: z.string().max(120).optional(),
    }),
    req.body,
  );
  const saved = await setInstitutionKey(inst(req), { apiKey, provider, model });
  res.json({ configured: true, ...saved });
}));

router.delete('/llm-key', asyncHandler(async (req, res) => {
  await clearInstitutionKey(inst(req));
  res.json({ configured: false, hint: null });
}));

// --- Branding (logo + accent) ----------------------------------------------

router.get('/branding', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT logo_asset_id, accent FROM pa_institutions WHERE id = $1', [inst(req)]);
  const r = rows[0] || {};
  res.json({ logoAssetId: r.logo_asset_id || null, accent: r.accent || null });
}));

router.put('/branding', asyncHandler(async (req, res) => {
  const { accent } = parseBody(
    z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }),
    req.body,
  );
  await query('UPDATE pa_institutions SET accent = $1 WHERE id = $2', [accent || null, inst(req)]);
  res.json({ accent: accent || null });
}));

router.post('/branding/logo', logoUpload.single('logo'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded');
  const a = await query('INSERT INTO pa_assets (mime, bytes) VALUES ($1, $2) RETURNING id', [req.file.mimetype || 'image/png', req.file.buffer]);
  await query('UPDATE pa_institutions SET logo_asset_id = $1 WHERE id = $2', [a.rows[0].id, inst(req)]);
  res.json({ logoAssetId: a.rows[0].id });
}));

router.delete('/branding/logo', asyncHandler(async (req, res) => {
  await query('UPDATE pa_institutions SET logo_asset_id = NULL WHERE id = $1', [inst(req)]);
  res.json({ logoAssetId: null });
}));

export default router;
