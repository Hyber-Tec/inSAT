// Detects whether the client is running inside the insat Exam desktop
// (Tauri) wrapper. Exams may only be STARTED inside that locked-down app; the
// browser build refuses to start an attempt and points students to the app.
// (Tauri v2 injects __TAURI_INTERNALS__; __TAURI__ exists when withGlobalTauri.)
export const isExamApp =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

// Exam-app enforcement is OPT-IN: by default, exams can be taken in any browser
// (handy for testing without building the desktop app). Set
// VITE_REQUIRE_EXAM_APP=true on the client to require the locked-down desktop
// app in production. Local Vite dev and the Tauri app are always allowed.
const REQUIRE_EXAM_APP = import.meta.env.VITE_REQUIRE_EXAM_APP === 'true';
export const needsExamApp = REQUIRE_EXAM_APP && !isExamApp && !import.meta.env.DEV;

// Download URLs for the insat Exam desktop app, by OS. Fill these in
// with the installers produced by `npx tauri build` (or a releases page). Empty
// entries render as "coming soon".
export const EXAM_APP_DOWNLOADS = {
  windows: '', // e.g. https://downloads.yourdomain.com/insat-Exam_x64-setup.exe
  mac: '',     // e.g. https://downloads.yourdomain.com/insat-Exam.dmg
  linux: '',   // e.g. https://downloads.yourdomain.com/insat-Exam.AppImage
};

/** Best-guess the visitor's OS so we can highlight the right download button. */
export function detectOS() {
  if (typeof navigator === 'undefined') return 'windows';
  const p = `${navigator.userAgent} ${navigator.platform || ''}`.toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'windows';
}
