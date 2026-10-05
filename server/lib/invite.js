// Signed invite tokens + link building. A token carries the invited user's id
// and email; accepting it lets the user set their own password and sign in.

import jwt from 'jsonwebtoken';
import { config } from './config.js';

export function signInvite({ userId, email }) {
  return jwt.sign({ sub: userId, email, purpose: 'invite' }, config.jwtSecret, { expiresIn: '14d' });
}

export function verifyInvite(token) {
  const d = jwt.verify(token, config.jwtSecret);
  if (d.purpose !== 'invite') throw new Error('not an invite token');
  return { userId: d.sub, email: d.email };
}

export function inviteLink(token) {
  return `${config.clientOrigin.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`;
}
