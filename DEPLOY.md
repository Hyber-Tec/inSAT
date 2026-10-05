# Deploying insat (Firebase)

One Firebase project, `insat-hyber`, runs everything. Academies install
nothing: you onboard each as an institution and send its admin the sign-in.

```
https://insatprep.web.app ── Firebase Hosting (web/dist, site "insatprep")
        │  /api/**  (rewrite, 60-second limit)
        ▼
   Cloud Function `api` (functions/, us-central1) ── Firestore (default, nam5)
        ▲                                         ── Cloud Storage (figures, logos)
        │  AI uploads and writing, straight         ── Firebase Auth (email, Google)
   https://us-central1-insat-hyber.cloudfunctions.net/api
```

## The project (set up once, already done for insat-hyber)

- Blaze plan (Cloud Functions and Secret Manager need billing).
- Authentication: Email/Password and Google enabled; `insatprep.web.app` in
  Authentication > Settings > Authorized domains (Google sign-in fails on a
  domain that is not listed).
- Firestore `(default)`, Standard edition, `nam5`.
- Storage: the default bucket `insat-hyber.firebasestorage.app`.
- Hosting: site `insatprep`, linked to the web app "inSAT"; `.firebaserc` maps
  the hosting target `app` to it.
- Secret: `ENCRYPTION_KEY`, which encrypts academies' AI keys at rest. Set it
  once and never rotate it casually (rotating it makes the stored keys
  unreadable):

  ```bash
  openssl rand -base64 32 | firebase functions:secrets:set ENCRYPTION_KEY --data-file=-
  ```

Non-secret runtime config is `functions/.env.insat-hyber` (committed):
`CLIENT_ORIGIN`, `SUPERADMIN_EMAILS` (the platform owners: a verified sign-in
with one of them is the superadmin), `REQUIRE_INSTITUTION_KEY=true` (academies
bring their own AI key), `MAIL_FROM`.

## Deploy

From the repo root, with `web/.env.local` holding the Firebase web config
(see `web/.env.example`):

```bash
(cd web && npm ci && npm run build)
(cd functions && npm ci)
firebase deploy --only firestore,storage,functions,hosting
```

`firestore` deploys the rules and indexes (an index can take a few minutes to
build after its first deploy), `storage` the bucket's rules, `functions` the
`api` and `syncPool` functions, `hosting` the web build. Deploy one part with
e.g. `firebase deploy --only hosting`. Check it:

```bash
curl https://insatprep.web.app/api/health          # {"ok":true,"service":"insat-api"}
curl https://us-central1-insat-hyber.cloudfunctions.net/api/api/health
```

Logs: `firebase functions:log` or the Cloud console (Cloud Run > api > Logs).

## First sign-in and onboarding

1. Open https://insatprep.web.app and continue with Google as a platform owner
   (`SUPERADMIN_EMAILS`): you land in the platform console.
2. **New institution** + its first admin: a temporary password (shown once)
   or an invite link to send them.
3. The **academy admin** signs in, adds students (a starting password, or an
   invite link) and, for a managed academy, pastes its own AI key in
   **Settings** to make tests from uploads or with AI.
4. **Students** sign in at the same URL. Anyone else can sign up and practise
   as a student of insat's own academy.

## Admin scripts against production

The scripts in `functions/scripts/` (imports, pool top-ups, repairs) write to
production when no emulator variables are set, with Application Default
Credentials:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project insat-hyber
cd functions
node --env-file-if-exists=.env.local scripts/import-dataset.js "/private/path/dataset" original --institution satify --dry-run
```

Each says where it writes before it does. Keep source datasets and exports in
the git-ignored `private-data/`, never in Git. After adding to insat's pool,
`npm run pool:sync` copies the new questions into the generation pool at once
(the `syncPool` function does it daily anyway).

## The move from Postgres (2026-10-05)

The platform ran on Render + Neon until 2026-10-05. Its database was copied
once into Firebase from the backup `db-backups/satify-20261005-140521.dump`
(kept privately, with its fingerprint):

```bash
createdb satify && pg_restore -d satify --no-owner --no-privileges satify-20261005-140521.dump
psql -d satify -X -q -At -f fingerprint.sql | diff - satify-20261005-140521.fingerprint.txt
cd functions
DATABASE_URL=postgresql://localhost/satify npm run migrate:postgres -- --dry-run
DATABASE_URL=postgresql://localhost/satify npm run migrate:postgres
```

It copies every table into Firestore (same ids), every image into Storage, and
every account into Firebase Auth with its bcrypt hash, so passwords keep
working; it checks every count when it is done and is safe to run again. The
old API's two demo accounts (`@satify.test`, on passwords its README
published) are left out. Run it before the first deploy: an API instance that serves a request
first makes an empty insat institution, which the script then replaces (and
refuses to replace once it holds anything).

## Notes & hardening

- **AI keys.** With `REQUIRE_INSTITUTION_KEY=true` no request ever bills the
  platform. To give academies a platform fallback instead, add
  `ANTHROPIC_API_KEY` to the `api` function's `secrets` in
  `functions/index.js`, set it with `firebase functions:secrets:set`, and set
  `REQUIRE_INSTITUTION_KEY=false`.
- **Invite email.** Without `RESEND_API_KEY` the admin shares invite links by
  hand. To email them, bind `RESEND_API_KEY` the same way.
- **Backups.** Turn on Firestore point-in-time recovery or a daily backup
  schedule (`gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=7d`);
  backups hold student records, so treat them as sensitive.
- **Cold starts.** The API scales to zero; the first request after a quiet
  spell takes a few seconds. `minInstances: 1` on `api` removes that for a
  monthly cost.
- **Custom domain.** Hosting > Add custom domain, then add it to
  `CLIENT_ORIGIN` and the Authentication authorized domains.
- **The desktop exam app** (`web/src-tauri`) bundles the web build; build it
  with `VITE_API_URL=https://insatprep.web.app` so it reaches the API. It signs
  in with email and password only.
