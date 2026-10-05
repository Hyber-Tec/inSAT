// How an institution runs. Self-guided: its students practise on their own
// (diagnostic, skill map, practice sets). Managed: its admins assign tests and
// practice topics and follow each student's results, and its students do
// assigned work only. The mode is read fresh on every guarded request, so a
// superadmin's change applies at once (a session would otherwise carry it until it ended).

import { COL, getRow } from './store.js';
import { forbidden } from './http.js';

export const MODES = ['self_guided', 'managed'];

export async function institutionMode(institutionId) {
  if (!institutionId) return null;
  return (await getRow(COL.institutions, institutionId))?.mode || null;
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
