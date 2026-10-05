// Accounts an admin or the platform owner makes and manages: a Firebase Auth
// user (the sign-in) and its profile in `users` (role, institution, active),
// kept in step. Deleting an account removes what the database cascaded before:
// its sessions, the assignments given to it, its group memberships and invites.

import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { auth } from './firebase.js';
import { COL, col, deleteWhere, newId, now, writeAll } from './store.js';
import { conflict } from './http.js';

const randomPassword = () => crypto.randomBytes(24).toString('base64url');
const gone = (err) => err?.code === 'auth/user-not-found';

/** The profile with this email, if any (emails are stored lowercased). */
export async function profileByEmail(email) {
  const snap = await col(COL.users).where('email', '==', String(email).toLowerCase().trim()).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * A new account with its profile. Without a password it gets a random one,
 * and an invite link lets its owner choose their own.
 */
export async function createAccount({ email, displayName, password, role, institutionId }) {
  const addr = email.toLowerCase().trim();
  if (await profileByEmail(addr)) throw conflict('A user with that email already exists');
  const uid = newId();
  try {
    await auth.createUser({ uid, email: addr, password: password || randomPassword(), displayName });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') throw conflict('A user with that email already exists');
    throw err;
  }
  const row = {
    email: addr,
    display_name: displayName,
    role,
    must_change_password: true,
    active: true,
    institution_id: institutionId,
    created_at: now(),
    last_seen_at: null,
  };
  try {
    await col(COL.users).doc(uid).set(row);
  } catch (err) {
    await auth.deleteUser(uid).catch(() => {});
    throw err;
  }
  return { id: uid, ...row };
}

/** Let an account sign in again, or stop it (its sessions end with it). */
export async function setActive(uid, active) {
  await col(COL.users).doc(uid).update({ active });
  await auth.updateUser(uid, { disabled: !active }).catch((err) => { if (!gone(err)) throw err; });
  if (!active) await auth.revokeRefreshTokens(uid).catch((err) => { if (!gone(err)) throw err; });
}

/**
 * A new password. Set by an admin it is a starting password the student must
 * change; chosen by the account's owner (an invite) it is theirs.
 */
export async function setPassword(uid, password, { mustChange }) {
  await auth.updateUser(uid, { password, disabled: false });
  await col(COL.users).doc(uid).update({ must_change_password: mustChange, ...(mustChange ? {} : { active: true }) });
}

/** Delete an account and everything that was its alone. */
export async function deleteAccount(uid) {
  await deleteWhere(col(COL.sessions).where('user_id', '==', uid));
  await deleteWhere(col(COL.assignments).where('user_id', '==', uid));
  await deleteWhere(col(COL.invites).where('user_id', '==', uid));
  const given = await col(COL.assignments).where('assigned_by', '==', uid).select().get();
  const groups = await col(COL.groups).where('member_ids', 'array-contains', uid).select().get();
  await writeAll([
    ...given.docs.map((d) => ['update', d.ref, { assigned_by: null }]),
    ...groups.docs.map((d) => ['update', d.ref, { member_ids: FieldValue.arrayRemove(uid) }]),
    ['delete', col(COL.users).doc(uid)],
  ]);
  await auth.deleteUser(uid).catch((err) => { if (!gone(err)) throw err; });
}
