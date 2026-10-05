// Auth routes. Signing in happens in the browser with Firebase Auth (email and
// password, or Google); the API knows the account by its ID token. Here: the
// current user (made on first sign-in), a password change's "must reset"
// clearing, and invite links.

import { Router } from 'express';
import { z } from 'zod';
import { COL, col, getRow } from '../lib/store.js';
import { ensureProfile, requireAuth, verifyRequest } from '../lib/auth.js';
import { setPassword } from '../lib/accounts.js';
import { readInvite, spendInvite } from '../lib/invite.js';
import { asyncHandler, parseBody, badRequest, forbidden } from '../lib/http.js';

const router = Router();

/** A user row with what the client shows of their institution: its name, its
 *  branding, and whether it is self-guided or managed. */
export async function withInstitution(u) {
  const i = u?.institution_id ? await getRow(COL.institutions, u.institution_id) : null;
  return {
    ...u,
    institution_name: i?.name ?? null,
    institution_logo_asset_id: i?.logo_asset_id ?? null,
    institution_accent: i?.accent ?? null,
    institution_mode: i?.mode ?? null,
  };
}

/** Shape a user row for client consumption. */
export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    mustChangePassword: u.must_change_password,
    active: u.active,
    institutionId: u.institution_id || null,
    institutionName: u.institution_name || null,
    institutionMode: u.institution_mode || null,
    branding: {
      logoAssetId: u.institution_logo_asset_id || null,
      accent: u.institution_accent || null,
    },
  };
}

// The signed-in account. Its first call makes the profile: a new sign-up is a
// student of insat's own academy.
router.get('/me', asyncHandler(async (req, res) => {
  const claims = await verifyRequest(req);
  const profile = await ensureProfile(claims);
  if (profile.active === false) throw forbidden('This account is deactivated. Contact your administrator.');
  res.json({ user: publicUser(await withInstitution(profile)) });
}));

// The browser changed the password (Firebase Auth); the admin's "must reset"
// is now done.
router.post('/password-changed', requireAuth, asyncHandler(async (req, res) => {
  await col(COL.users).doc(req.user.sub).update({ must_change_password: false });
  res.json({ ok: true });
}));

// --- Invites ----------------------------------------------------------------

router.get('/invite/:token', asyncHandler(async (req, res) => {
  const invite = await readInvite(req.params.token);
  const user = invite ? await getRow(COL.users, invite.userId) : null;
  if (!user || user.email !== invite.email) return res.json({ valid: false });
  res.json({ valid: true, email: invite.email, name: user.display_name, role: user.role });
}));

// Choose a password from an invite; the browser then signs in with it.
router.post('/accept-invite', asyncHandler(async (req, res) => {
  const { token, password } = parseBody(z.object({ token: z.string().min(10), password: z.string().min(6) }), req.body);
  const invite = await readInvite(token);
  if (!invite) throw badRequest('This invite link is invalid or has expired.');
  const user = await getRow(COL.users, invite.userId);
  if (!user || user.email !== invite.email) throw badRequest('This invite is no longer valid.');
  await setPassword(user.id, password, { mustChange: false });
  await spendInvite(token);
  res.json({ ok: true, email: user.email });
}));

export default router;
