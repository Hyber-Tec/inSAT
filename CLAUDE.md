# CLAUDE.md

Rules for everyone who works in this repository, people and AI agents alike.
They are strict.

## Rules

- **main is reached through a pull request:** CI green, the code owner's
  approval where a shared file changed. A session works on a branch, opens the
  pull request, and says so. It never pushes to main and never merges unless
  the owner asked for exactly that.
- **AI naming (permanent rule):** the app never names the AI model or provider
  in labels, settings, messages or errors; it is always "AI". The one
  exception is the admin AI settings (admin Settings), where an academy
  manages its AI provider, key and model.
- **UI:** shadcn/ui components in `web/src/components/ui`, icons from
  react-icons.
- **Secrets:** never commit API keys, service-account files, tokens, passwords
  or PINs. The Firebase web config lives in `web/.env.local` (git-ignored).
- **Commits carry no attribution trailers.** No `Co-Authored-By:` line, no
  session line, no "generated with" footer — in commit messages or pull
  request bodies. Every commit is authored solely as the git user configured;
  for the owner, `goochoi913 <goochoi913@gmail.com>`.
- **Conventional Commits v1.0.0:** `<type>[(scope)][!]: <imperative description>`,
  blank line, body, blank line, footers. Types: feat fix docs refactor test
  chore perf build ci style.
- **Commit far less often:** one commit per meaningful, self-contained piece of
  work — a feature, a fix, a refactor, a runbook. Small things join the commit
  they belong to. Never one commit per file, per review round or per step of a
  session. A day's work is a handful of commits split by type and scope, not by
  when the edits were made.

## The project

A multi-tenant digital SAT practice platform (README.md), all on Firebase,
project `insat-hyber`:

- `web/` — React + Vite, served by Firebase Hosting at https://insatprep.web.app.
  Sign-in is Firebase Auth (email and password, Google); a new sign-up is a
  student of insat's own academy.
- `functions/` — the API (Express) as the `api` Cloud Function behind
  `/api/**`. It alone reads and writes Firestore and Storage: the rules refuse
  every browser request. Every query is scoped to the caller's institution.
- Firestore keeps the former Postgres tables' ids and snake_case field names
  (`functions/lib/store.js`); every write to an item sets `updated_at`
  (`touched()`), or the API's bank cache will not see it.

Run it locally with `./start.sh` (Firebase emulators + the web app); deploy
with DEPLOY.md. Before a pull request: `npm run build` in `web/`, and the
`npm run check:*` scripts in `functions/` (and the browser checks in `web/`
for what they cover).
