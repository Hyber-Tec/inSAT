// Authentication: Firebase Auth ID tokens (the browser signs in with email and
// password or Google and sends its ID token as a Bearer token), the profile
// every account has in `users`, and Express middleware for requiring a session
// and a role. Role, institution and whether the account is active are read
// from the profile on every request, so a change applies at once.

import { auth } from './firebase.js';
import { COL, col, getRow, now, rowOf } from './store.js';
import { config } from './config.js';
import { unauthorized, forbidden } from './http.js';
import { defaultInstitutionId } from './pool.js';

/** The verified claims of the request's ID token, or a 401. */
export async function verifyRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  try {
    return await auth.verifyIdToken(token);
  } catch {
    throw unauthorized('Invalid or expired session');
  }
}

/** What a route knows of the caller (the shape the JWT used to carry). */
const callerOf = (uid, p) => ({
  sub: uid, role: p.role, email: p.email, name: p.display_name, inst: p.institution_id || null,
});

/** Whether a token belongs to a platform owner (a verified email on the list). */
const isOwner = (claims) => Boolean(
  claims.email && claims.email_verified && config.superadminEmails.includes(String(claims.email).toLowerCase()),
);

/**
 * The profile of the account signing in, made on its first sign-in. A new
 * account is a student of insat's own self-guided academy; an account an admin
 * created already has its profile (and its uid). A platform owner's account
 * is the superadmin, whatever it was before.
 */
export async function ensureProfile(claims) {
  const docRef = col(COL.users).doc(claims.uid);
  const email = String(claims.email || '').toLowerCase();
  const owner = isOwner(claims);
  const existing = rowOf(await docRef.get(), COL.users);
  if (existing) {
    const changes = { last_seen_at: now() };
    if (owner && (existing.role !== 'superadmin' || existing.institution_id)) Object.assign(changes, { role: 'superadmin', institution_id: null });
    if (email && existing.email !== email) changes.email = email;
    await docRef.update(changes);
    return { ...existing, ...changes };
  }
  const row = {
    email,
    display_name: String(claims.name || '').trim() || email.split('@')[0] || 'Student',
    role: owner ? 'superadmin' : 'student',
    must_change_password: false,
    active: true,
    institution_id: owner ? null : await defaultInstitutionId(),
    created_at: now(),
    last_seen_at: now(),
  };
  try {
    await docRef.create(row);
  } catch (err) {
    // Two first requests at once: the other one made it.
    if (err.code !== 6) throw err;
    return rowOf(await docRef.get(), COL.users);
  }
  return { id: claims.uid, ...row };
}

/** Populate req.user from the Bearer token and the account's profile, or 401. */
export function requireAuth(req, _res, next) {
  (async () => {
    const claims = await verifyRequest(req);
    const profile = await getRow(COL.users, claims.uid);
    if (!profile) throw unauthorized('Finish signing in first.');
    if (profile.active === false) throw unauthorized('This account is deactivated.');
    req.user = callerOf(claims.uid, profile);
    req.claims = claims;
  })().then(() => next(), next);
}

/** Require a specific role (use after requireAuth). */
export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== role) return next(forbidden(`Requires ${role} role`));
  next();
};
