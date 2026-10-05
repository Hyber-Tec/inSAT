// Institution settings (admin) - currently the institution's own LLM API key.
// The key is encrypted at rest and never returned; only its status + a hint.

import { Router } from 'express';
import { z } from 'zod';
import { COL, col, getRow } from '../lib/store.js';
import { asyncHandler, parseBody, badRequest } from '../lib/http.js';
import { keyStatus, setInstitutionKey, clearInstitutionKey } from '../lib/institutions.js';
import { saveAsset } from '../lib/assets.js';
import { multipart } from '../lib/upload.js';

const router = Router();
const inst = (req) => req.user.inst;
const logoUpload = multipart({ field: 'logo', single: true, fileSize: 2 * 1024 * 1024 });
const institution = (req) => col(COL.institutions).doc(inst(req));

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
  const r = (await getRow(COL.institutions, inst(req))) || {};
  res.json({ logoAssetId: r.logo_asset_id || null, accent: r.accent || null });
}));

router.put('/branding', asyncHandler(async (req, res) => {
  const { accent } = parseBody(
    z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }),
    req.body,
  );
  await institution(req).update({ accent: accent || null });
  res.json({ accent: accent || null });
}));

router.post('/branding/logo', logoUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded');
  const id = await saveAsset({ mime: req.file.mimetype || 'image/png', bytes: req.file.buffer });
  await institution(req).update({ logo_asset_id: id });
  res.json({ logoAssetId: id });
}));

router.delete('/branding/logo', asyncHandler(async (req, res) => {
  await institution(req).update({ logo_asset_id: null });
  res.json({ logoAssetId: null });
}));

export default router;
