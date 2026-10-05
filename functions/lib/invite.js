// Invite links. An invite is a random token stored with the invited account's
// id and email; opening the link lets the account's owner choose a password
// and sign in. A token is good for 14 days and once.

import crypto from 'node:crypto';
import { config } from './config.js';
import { COL, col, isDocId, now, rowOf } from './store.js';

const LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export async function createInvite({ userId, email }) {
  const token = crypto.randomBytes(24).toString('base64url');
  await col(COL.invites).doc(token).set({
    user_id: userId, email, created_at: now(), expires_at: new Date(Date.now() + LIFETIME_MS),
  });
  return token;
}

/** The invite a token names, while it is good: { userId, email }, or null. */
export async function readInvite(token) {
  if (!isDocId(token)) return null;
  const invite = rowOf(await col(COL.invites).doc(token).get(), COL.invites);
  if (!invite || invite.expires_at < new Date()) return null;
  return { userId: invite.user_id, email: invite.email };
}

export const spendInvite = (token) => col(COL.invites).doc(token).delete();

export function inviteLink(token) {
  return `${config.clientOrigin.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`;
}
