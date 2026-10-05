// How an institution runs. Self-guided: its students practise on their own
// (diagnostic, skill map, practice sets). Managed: its admins assign tests and
// practice topics and follow each student's results, and its students do
// assigned work only. The mode is read fresh on every guarded request, so a
// superadmin's change applies at once (a token would carry it for 12 hours).

import { query } from './db.js';
import { forbidden } from './http.js';

export const MODES = ['self_guided', 'managed'];

export async function institutionMode(institutionId) {
  if (!institutionId) return null;
  const { rows } = await query('SELECT mode FROM pa_institutions WHERE id = $1', [institutionId]);
  return rows[0]?.mode || null;
}

/** Express guard (after requireAuth): only for an institution in `mode`. */
export const requireMode = (mode, message) => async (req, _res, next) => {
  try {
    if ((await institutionMode(req.user?.inst)) === mode) return next();
    next(forbidden(message));
  } catch (err) {
    next(err);
  }
};
