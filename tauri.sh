#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

LOG_DIR=".logs"
mkdir -p "$LOG_DIR"

command -v docker >/dev/null 2>&1 || { echo "!! docker is required"; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "!! npm is required";    exit 1; }
command -v cargo  >/dev/null 2>&1 || { echo "!! cargo (Rust) is required for Tauri — install from https://rustup.rs"; exit 1; }

echo "==> Bringing up Postgres + Redis + Adminer"
docker compose up -d --wait

install_deps() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "==> Installing deps in $dir/"
    (cd "$dir" && npm install)
  fi
}

install_deps web

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
    --dev-url "http://localhost:5174" \
    --before-dev-command "" \
    --before-build-command "npm run build")
fi

echo "==> Starting Vite dev server on :5174"
(cd web && npm run dev) >"$LOG_DIR/client.log" 2>&1 &
CLIENT_PID=$!

cleanup() {
  echo
  echo "==> Stopping Vite (pid=$CLIENT_PID)"
  kill "$CLIENT_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local port="$1" name="$2"
  for _ in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3<&-
      echo "==> $name ready on :$port"
      return 0
    fi
    sleep 1
  done
  echo "!! $name did not come up on :$port — see $LOG_DIR/"
  return 1
}

wait_for_port 5174 "Vite"

cat <<EOF

  insat (Tauri desktop) launching
  ──────────────────────────────────────
  Vite dev → http://localhost:5174 (served inside the native window)
  Adminer  → http://localhost:8081
  Logs     → $LOG_DIR/client.log, $LOG_DIR/tauri.log

  First run will compile the Rust shell — subsequent runs are fast.
  Close the desktop window or hit Ctrl+C to stop. Containers keep running
  (use 'docker compose down' to stop them).

EOF

(cd web && npx tauri dev) 2>&1 | tee "$LOG_DIR/tauri.log"
