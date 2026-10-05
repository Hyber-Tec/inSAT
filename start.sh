#!/usr/bin/env bash
# insat - full-stack launcher.
#
#   ./start.sh            # bring up Postgres, the API, and the client
#
# Starts three things:
#   1. Postgres (docker compose) on :5434  — the application database
#   2. API      (server/)        on :3002  - insat backend (Node/Express)
#   3. Client   (client/)        on :5174  — the React app (Vite)
#
# Question generation + upload extraction run inside the API. Set ANTHROPIC_API_KEY
# in server/.env for a platform fallback, or have each institution add their own
# key in admin Settings. The API auto-applies the schema and seeds on boot.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
  echo; echo "==> Shutting down (Postgres container keeps running; 'docker compose down' to stop it)"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; return 0; } || return 1; }
wait_for_port() {
  local port="$1" name="$2"
  for _ in $(seq 1 90); do
    if port_open "$port"; then echo "==> $name ready on :$port"; return 0; fi
    sleep 1
  done
  echo "!! $name did not come up on :$port — see $LOG_DIR/"; return 1
}

# 1. Postgres ---------------------------------------------------------------
# Pick whichever Compose is available: V2 plugin ("docker compose") or standalone ("docker-compose").
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "!! Neither 'docker compose' nor 'docker-compose' is available." >&2; exit 1
fi
echo "==> Bringing up Postgres (${DC[*]})"
"${DC[@]}" up -d --wait postgres

# 2. API --------------------------------------------------------------------
[[ -f server/.env ]] || cp server/.env.example server/.env
[[ -d server/node_modules ]] || ( echo "==> Installing API deps"; cd server && npm install )
echo "==> Starting API on :3002"
( cd server && npm run start ) >"$LOG_DIR/server.log" 2>&1 &
PIDS+=($!)
wait_for_port 3002 "API"

# 3. Client -----------------------------------------------------------------
[[ -d client/node_modules ]] || ( echo "==> Installing client deps"; cd client && npm install )
echo "==> Starting client on :5174"
( cd client && npm run dev ) >"$LOG_DIR/client.log" 2>&1 &
PIDS+=($!)
wait_for_port 5174 "Client"

cat <<EOF

  insat is up
  ───────────────────
  Client   → http://localhost:5174        (sign in here)
  API      → http://localhost:3002/api/health
  Adminer  → http://localhost:8081        (db browser, if enabled)

  Admin login → ${ADMIN_EMAIL:-admin@satify.test} / ${ADMIN_PASSWORD:-satify-admin}
  Generation needs an Anthropic key: set ANTHROPIC_API_KEY in server/.env, or add
  one per institution in admin Settings.
  First run? Seed the demo question bank so exams can be assembled:
      cd server && npm run seed:bank      (or use the admin "Question Bank" tab)

  Logs: $LOG_DIR/{server,client}.log
  Ctrl+C stops the API and client. Postgres keeps running.

EOF

tail -n +1 -f "$LOG_DIR/client.log"
