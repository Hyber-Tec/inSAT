// Auth routes: login (returns a JWT), the current user, and change-password.

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { verifyPassword, hashPassword, signToken, requireAuth } from '../lib/auth.js';
import { verifyInvite } from '../lib/invite.js';
import { asyncHandler, parseBody, unauthorized, badRequest, notFound } from '../lib/http.js';

const router = Router();

// A user with what the client shows of their institution: its name, its
// branding, and whether it is self-guided or managed.
const WITH_INSTITUTION = `SELECT u.*, i.name AS institution_name,
            i.logo_asset_id AS institution_logo_asset_id, i.accent AS institution_accent,
            i.mode AS institution_mode
       FROM pa_users u LEFT JOIN pa_institutions i ON i.id = u.institution_id`;

/** Shape a user row for client consumption (never includes the password hash). */
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

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = parseBody(loginSchema, req.body);
  const { rows } = await query(
    `${WITH_INSTITUTION} WHERE u.email = $1 AND u.active = true`,
    [email.toLowerCase().trim()],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw unauthorized('Invalid email or password');
  }
  await query('UPDATE pa_users SET last_seen_at = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `${WITH_INSTITUTION} WHERE u.id = $1`,
    [req.user.sub],
  );
  if (!rows[0]) throw notFound('user');
  res.json({ user: publicUser(rows[0]) });
}));

const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = parseBody(changePwSchema, req.body);
  const { rows } = await query('SELECT * FROM pa_users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    throw badRequest('Current password is incorrect');
  }
  await query('UPDATE pa_users SET password_hash = $1, must_change_password = false WHERE id = $2', [
    await hashPassword(newPassword),
    user.id,
  ]);
  res.json({ ok: true });
}));

// --- Invites ----------------------------------------------------------------

router.get('/invite/:token', asyncHandler(async (req, res) => {
  try {
    const { userId, email } = verifyInvite(req.params.token);
    const { rows } = await query('SELECT display_name, role FROM pa_users WHERE id = $1 AND email = $2', [userId, email]);
    if (!rows[0]) throw new Error('gone');
    res.json({ valid: true, email, name: rows[0].display_name, role: rows[0].role });
  } catch {
    res.json({ valid: false });
  }
}));

router.post('/accept-invite', asyncHandler(async (req, res) => {
  const { token, password } = parseBody(z.object({ token: z.string().min(10), password: z.string().min(6) }), req.body);
  let payload;
  try { payload = verifyInvite(token); } catch { throw badRequest('This invite link is invalid or has expired.'); }
  const { rows } = await query('SELECT id FROM pa_users WHERE id = $1 AND email = $2', [payload.userId, payload.email]);
  if (!rows[0]) throw badRequest('This invite is no longer valid.');
  await query(
    'UPDATE pa_users SET password_hash = $1, must_change_password = false, active = true WHERE id = $2',
    [await hashPassword(password), payload.userId],
  );
  const fresh = (await query(
    `${WITH_INSTITUTION} WHERE u.id = $1`,
    [payload.userId],
  )).rows[0];
  res.json({ token: signToken(fresh), user: publicUser(fresh) });
}));

export default router;
