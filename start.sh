#!/usr/bin/env bash
# insat - local launcher.
#
#   ./start.sh            # the Firebase emulators and the web app
#
# Starts two things:
#   1. Firebase emulators (firebase.json): Auth :9109, Firestore :8090,
#      Storage :9209, the `api` function :5011, the Emulator UI :4010. Their
#      data is kept in .logs/emulator-data between runs.
#   2. Web app (web/) on :5180 - Vite, with /api proxied to the function, as
#      Firebase Hosting serves it in production.
#
# Needs Node 22+, Java 21+ (the Firestore emulator) and the Firebase CLI
# (npm i -g firebase-tools). The first run writes the git-ignored local config
# (functions/.env.local, functions/.secret.local, web/.env.development.local);
# web/.env.local, the Firebase web config, comes from web/.env.example.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
LOG_DIR="$ROOT/.logs"
DATA_DIR="$LOG_DIR/emulator-data"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
  echo; echo "==> Shutting down (the emulators save their data to .logs/emulator-data)"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; return 0; } || return 1; }
wait_for_port() {
  local port="$1" name="$2"
  for _ in $(seq 1 120); do
    if port_open "$port"; then echo "==> $name ready on :$port"; return 0; fi
    sleep 1
  done
  echo "!! $name did not come up on :$port - see $LOG_DIR/"; return 1
}

command -v firebase >/dev/null 2>&1 || { echo "!! The Firebase CLI is required: npm i -g firebase-tools" >&2; exit 1; }
[[ -f web/.env.local ]] || { echo "!! web/.env.local is missing: copy web/.env.example and fill in the Firebase web config" >&2; exit 1; }

# The Firestore emulator needs Java 21 or newer; use a Homebrew JDK 21 when the default is older.
java_major() { "$1" -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print (v[1] == "1" ? v[2] : v[1]); exit }'; }
if [[ "$(java_major java 2>/dev/null || echo 0)" -lt 21 ]]; then
  for home in /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21 "$(/usr/libexec/java_home -v 21+ 2>/dev/null || true)"; do
    if [[ -n "$home" && -x "$home/bin/java" ]]; then export JAVA_HOME="$home" PATH="$home/bin:$PATH"; break; fi
  done
fi

# Local config, written once.
[[ -f functions/.env.local ]] || cp functions/.env.example functions/.env.local
[[ -f functions/.secret.local ]] || printf 'ENCRYPTION_KEY=dev-only-insat-enc\n' > functions/.secret.local
[[ -f web/.env.development.local ]] || printf 'VITE_AUTH_EMULATOR_HOST=127.0.0.1:9109\n' > web/.env.development.local
[[ -d functions/node_modules ]] || ( echo "==> Installing API deps"; cd functions && npm install )
[[ -d web/node_modules ]] || ( echo "==> Installing web deps"; cd web && npm install )

# 1. Emulators ----------------------------------------------------------------
echo "==> Starting the Firebase emulators"
IMPORT=()
[[ -d "$DATA_DIR" ]] && IMPORT=(--import "$DATA_DIR")
firebase emulators:start --only auth,firestore,storage,functions --project insat-hyber \
  "${IMPORT[@]}" --export-on-exit "$DATA_DIR" >"$LOG_DIR/emulators.log" 2>&1 &
PIDS+=($!)
wait_for_port 9109 "Auth emulator"
wait_for_port 8090 "Firestore emulator"
wait_for_port 5011 "Functions emulator"

# 2. Web app ------------------------------------------------------------------
echo "==> Starting the web app on :5180"
( cd web && npm run dev ) >"$LOG_DIR/web.log" 2>&1 &
PIDS+=($!)
wait_for_port 5180 "Web app"

cat <<EOF

  insat is up
  ───────────────────
  Web app    → http://localhost:5180          (sign up or sign in here)
  API        → http://localhost:5180/api/health
  Emulators  → http://localhost:4010          (accounts, Firestore, Storage)

  Make an account on the sign-up page. "Continue with Google" offers the Auth
  emulator's test accounts; a Google sign-in with an address in
  SUPERADMIN_EMAILS (functions/.env.local) is the platform owner.
  Reading and Writing questions come from the original-question import
  (README, "Original questions"); math is built from the templates.

  Logs: $LOG_DIR/{emulators,web}.log
  Ctrl+C stops everything.

EOF

tail -n +1 -f "$LOG_DIR/web.log"
