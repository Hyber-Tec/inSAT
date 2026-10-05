# Deploying insat (Render + Neon)

You host **one** instance; academies don't install anything — you onboard each
as an institution and send them a login URL + credentials.

```
Render: satify-client (static, CDN)  ──HTTPS──►  Render: satify-api (Node)
                                                                  │
                                                         Neon Postgres
                                                         (DATABASE_URL)
```

Everything runs on **Render + Neon** — no Cloudflare. One `render.yaml` Blueprint
brings up **both** the API (`satify-api`, Node) and the client
(`satify-client`, static site on Render's CDN). Question generation and
image/PDF extraction run **inside the API** — there is no separate service.

## Prerequisites
- One Git repo Render can read containing `functions/`, `web/`, `db/`, `render.yaml`
  (already pushed to `VantEdge-Corp/satify`).
- A **Neon** account and a **Render** account.
- An **Anthropic API key** for the platform fallback (optional if every
  institution will add their own key in Settings).

---

## 1) Postgres — Neon
1. Create a Neon project → copy the **pooled** connection string.
2. Make sure it ends with `?sslmode=require` (the API enables TLS for it).
   Keep it for step 2 as `DATABASE_URL`.

The question bank lives in Postgres (`pa_items` and its image assets in
`pa_assets`), not in the public Git repo. The local Docker database is only a
development copy; deploying the API against a new Neon database does not move
that local bank automatically. Keep source exports and any private backups in
the ignored `private-data/` directory, never in Git. To populate production,
run the existing import scripts with `DATABASE_URL` set to Neon and the source
dataset path kept private. For the ClassMarker bank, for example:

```bash
cd functions
node --env-file=.env scripts/import-classmarker.js "/private/path/classmarker/questions.jsonl" --institution satify --dry-run
node --env-file=.env scripts/import-classmarker.js "/private/path/classmarker/questions.jsonl" --institution satify
```

The `.env` used for this import must point at the production Neon database.
Keep that connection string and all source exports private. Enable Neon backups
or point-in-time restore for the hosted database; database backups can also
contain user and student records, so treat them as sensitive data.

## 2) Both services — Render Blueprint
1. Render → **New → Blueprint** → connect GitHub (grant access to the
   **VantEdge-Corp** org) → pick **`satify`**. It reads `render.yaml` and
   proposes **two** services: `satify-api` (Node) and
   `satify-client` (static). `JWT_SECRET` and `ENCRYPTION_KEY` auto-generate.
2. Set the `sync:false` env vars when prompted:
   - **API** `DATABASE_URL` → the Neon string from step 1
   - **API** `ANTHROPIC_API_KEY` → platform fallback key for generation/extraction
     *(optional — leave unset to require each institution to bring their own)*
   - **API** `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` → **set strong values**
   - *(optional)* **API** `RESEND_API_KEY` + `MAIL_FROM` → email invite links automatically;
     leave unset to share links manually from the admin UI
   - (`REQUIRE_INSTITUTION_KEY` is already `true`; `ENCRYPTION_KEY` auto-generates — encrypts stored institution keys)
   - The two **circular** URLs (`CLIENT_ORIGIN`, `VITE_API_URL`) you fill in step 3.
3. Deploy. On boot the API applies the schema + migrations and seeds the
   superadmin. Confirm `https://<api>.onrender.com/api/health` → `{ "ok": true }`.

## 3) Wire the two service URLs together
Both services now exist, so connect them (each needed the other's URL):
1. **API** → Environment → set `CLIENT_ORIGIN` to the client URL
   (`https://satify-client.onrender.com`) → save (redeploys). This is the CORS allow-origin.
2. **Client** → Environment → set `VITE_API_URL` to the API URL
   (`https://satify-api.onrender.com`) → trigger a redeploy (it's baked into the bundle at build).

## 4) First login + onboarding
1. Open the client → sign in as the **superadmin** (the creds from step 2).
2. **New institution** + its first admin → the UI shows the admin's temp
   credentials once → email them to the academy.
3. The **academy admin** signs in → **Settings** → pastes *their own* Anthropic
   key → generates questions or uploads source material to extract → creates
   groups → invites students (each student's credentials show once → relay them).
4. **Students** sign in at the same client URL and take assigned exams.

> Optional: to pre-fill the **demo** institution's bank with sample R&W items,
> run `cd functions && npm run seed:bank` locally with `DATABASE_URL` pointed at
> production. New institutions don't need this — generation works from an empty
> bank (zero-shot) and improves as the bank grows.

---

## Custom domains
Add `app.yourdomain.com` to the **client** service and `api.yourdomain.com` to the
**API** service in Render (Settings → Custom Domains), then update `VITE_API_URL`
and `CLIENT_ORIGIN` to match and redeploy.

## Scaling later
If you ever want a dedicated CDN/edge for the frontend, move just the **client** to
Cloudflare Pages or Vercel (same build: `cd web && npm install && npm run build`,
output `web/dist`, env `VITE_API_URL`) and point `CLIENT_ORIGIN` at the new URL.
The API and DB don't change.

## Notes & hardening
- **Generation needs a key.** Either set `ANTHROPIC_API_KEY` (platform fallback)
  or keep `REQUIRE_INSTITUTION_KEY=true` and have each academy add their own in
  Settings. With no key set anywhere, generation/upload return a clear "add a key"
  message and exam assembly falls back to existing bank items.
- AI-generated math questions can include figures — coordinate/function graphs,
  bar/line/scatter charts, and geometry — rendered to SVG in-app (no Python).
  Uploaded questions keep their original images.
- Change all default passwords; let Render generate `JWT_SECRET` / `ENCRYPTION_KEY`.
  Rotating `ENCRYPTION_KEY` invalidates stored institution API keys.
- Keep `REQUIRE_INSTITUTION_KEY=true` so academies' generation never bills you.
- Enforce first-login password change (the `mustChangePassword` flag exists;
  add a client gate) and rate-limit `/api/auth/login` before real customers.
- Neon has point-in-time restore — enable backups.
