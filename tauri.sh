#!/usr/bin/env bash
# insat Exam - the desktop (Tauri) shell around the web app, in development.
#
#   ./start.sh     # in one terminal: the emulators and the web app on :5180
#   ./tauri.sh     # in another: the native window, loading that web app
#
# The desktop app signs in with email and password only: its webview cannot
# open Google's sign-in window.
set -euo pipefail

cd "$(dirname "$0")"

LOG_DIR=".logs"
mkdir -p "$LOG_DIR"

command -v npm    >/dev/null 2>&1 || { echo "!! npm is required";    exit 1; }
command -v cargo  >/dev/null 2>&1 || { echo "!! cargo (Rust) is required for Tauri — install from https://rustup.rs"; exit 1; }

if ! (exec 3<>"/dev/tcp/127.0.0.1/5180") 2>/dev/null; then
  echo "!! The web app is not running on :5180 - start it with ./start.sh first"; exit 1
fi
exec 3<&-

if [[ ! -d web/node_modules ]]; then
  echo "==> Installing deps in web/"
  (cd web && npm install)
fi

if ! (cd web && npx --no-install tauri --version) >/dev/null 2>&1; then
  echo "==> Installing @tauri-apps/cli in web/"
  (cd web && npm install --save-dev @tauri-apps/cli@latest @tauri-apps/api@latest)
fi

if [[ ! -d web/src-tauri ]]; then
  echo "==> Initializing Tauri scaffolding in web/src-tauri (first run — may take a minute)"
  (cd web && npx tauri init \
    --ci \
    --app-name "insat Exam" \
    --window-title "insat Exam" \
    --frontend-dist "../dist" \
    --dev-url "http://localhost:5180" \
    --before-dev-command "" \
    --before-build-command "npm run build")
fi

cat <<EOF

  insat (Tauri desktop) launching
  ──────────────────────────────────────
  Web app → http://localhost:5180 (from ./start.sh, served inside the native window)
  Log     → $LOG_DIR/tauri.log

  First run will compile the Rust shell — subsequent runs are fast.
  Close the desktop window or hit Ctrl+C to stop it; ./start.sh keeps running.

EOF

(cd web && npx tauri dev) 2>&1 | tee "$LOG_DIR/tauri.log"
