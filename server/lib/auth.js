// Authentication: password hashing (bcrypt), JWT issuance/verification, and
// Express middleware for requiring a session and a role.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { unauthorized, forbidden } from './http.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export const signToken = (user) =>
  jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      name: user.display_name,
      inst: user.institution_id || null,
    },
    config.jwtSecret,
    { expiresIn: '12h' },
  );

/** Populate req.user from a Bearer token, or 401. */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    next(unauthorized('Invalid or expired session'));
  }
}

/** Require a specific role (use after requireAuth). */
export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== role) return next(forbidden(`Requires ${role} role`));
  next();
};
