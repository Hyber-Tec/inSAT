// A platform owner can also use insat as one of its students. While their
// student view is on, every request says so and the API takes them for a
// student of insat's own academy (functions/lib/auth.js). Which view they were
// in is remembered in this browser, a convenience that falls back to the
// console wherever storage is unavailable.

const KEY = 'insat.ownerView';
let current = 'platform';
try {
  if (localStorage.getItem(KEY) === 'student') current = 'student';
} catch { /* storage blocked: the console */ }

/** 'student' while a platform owner uses insat as a student, else 'platform'. */
export const ownerView = () => current;

export function setOwnerView(view) {
  current = view === 'student' ? 'student' : 'platform';
  try {
    localStorage.setItem(KEY, current);
  } catch { /* the choice lasts this visit */ }
}

/** The header the API reads (VIEW_HEADER in functions/lib/auth.js); none outside the student view. */
export const viewHeaders = () => (current === 'student' ? { 'X-Insat-View': 'student' } : {});
