// One-time copy of the Postgres database (the Render/Neon era) into Firebase:
// every table into Firestore, the figure and logo images into Storage, and the
// accounts into Firebase Auth with their bcrypt password hashes, so everyone
// keeps their password. Ids are kept, so every reference between rows holds.
//
//   DATABASE_URL=postgresql://... npm run migrate:postgres -- --dry-run
//   DATABASE_URL=postgresql://... npm run migrate:postgres
//
// It writes to the emulators when FIRESTORE_EMULATOR_HOST (and the Auth and
// Storage hosts) are set, and to production otherwise (Application Default
// Credentials: gcloud auth application-default login). Re-running it is safe:
// documents are overwritten by id, accounts that exist are left alone, images
// already uploaded are skipped.
//
// The old API's demo accounts (superadmin@satify.test and admin@satify.test,
// seeded with passwords its README published) are not carried over: in
// production they would be logins anyone can use. The platform owner signs in
// with Google instead (SUPERADMIN_EMAILS).

import pg from 'pg';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, bucket, db, target } from '../lib/firebase.js';
import { COL, chunks, col, writeAll } from '../lib/store.js';
import { seenFields } from '../lib/assembly.js';

// A failure says what failed, never the request behind it (headers carry credentials).
process.on('uncaughtException', (err) => {
  console.error(`[migrate] failed: ${err.message}`);
  process.exit(1);
});

const DRY = process.argv.includes('--dry-run');
const DEMO = /@satify\.test$/i;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the Postgres database to copy.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
// The images are read eight at a time.
const images = new pg.Pool({ connectionString: url, max: 8 });
const all = async (sql) => (await client.query(sql)).rows;
const json = (v) => (v == null ? null : JSON.stringify(v));
const log = (...a) => console.log('[migrate]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Try a call again when the service is briefly unavailable; fail with its message only. */
async function retried(what, fn, attempts = 5) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const transient = [429, 500, 502, 503, 504].includes(Number(err.code)) || /ECONNRESET|ETIMEDOUT|socket hang up/.test(err.message);
      if (!transient || i >= attempts) throw new Error(`${what}: ${err.message}`);
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}

log(`${DRY ? 'DRY RUN - nothing is written. ' : ''}Copying ${url.replace(/\/\/[^@]*@/, '//***@')} into ${target()}.`);

// ---- Read everything ---------------------------------------------------------
const institutions = await all('SELECT * FROM pa_institutions');
const users = await all('SELECT * FROM pa_users');
const groups = await all('SELECT * FROM pa_groups');
const members = await all('SELECT * FROM pa_group_members');
const blueprints = await all('SELECT * FROM pa_blueprints');
const exams = await all('SELECT * FROM pa_exams');
const folders = await all('SELECT * FROM pa_exam_folders');
const filed = await all('SELECT * FROM pa_exam_folder_members');
const assignments = await all('SELECT * FROM pa_assignments');
const sessions = await all('SELECT * FROM pa_sessions');
const responses = await all('SELECT * FROM pa_responses ORDER BY module_key, q_instance_id');
const itemCount = Number((await all('SELECT count(*) FROM pa_items'))[0].count);
const assetIds = (await all('SELECT id FROM pa_assets')).map((r) => r.id);

// ---- Accounts ----------------------------------------------------------------
const skipped = users.filter((u) => DEMO.test(u.email));
const kept = users.filter((u) => !DEMO.test(u.email));
for (const u of skipped) log(`not carried over: ${u.email} (${u.role}), a demo account of the old API`);
const skippedIds = new Set(skipped.map((u) => u.id));

const ops = [];
const put = (name, id, data) => ops.push(['set', col(name).doc(id), data]);

for (const i of institutions) {
  put(COL.institutions, i.id, {
    name: i.name, slug: i.slug, active: i.active, created_at: i.created_at, mode: i.mode,
    llm_api_key_enc: i.llm_api_key_enc, llm_key_hint: i.llm_key_hint, llm_provider: i.llm_provider, llm_model: i.llm_model,
    logo_asset_id: i.logo_asset_id, accent: i.accent, pool_institution_id: i.pool_institution_id,
  });
  if (i.llm_api_key_enc) log(`note: ${i.name} has an AI key encrypted with the old ENCRYPTION_KEY; set the same secret, or have the academy re-enter it`);
}

for (const u of kept) {
  put(COL.users, u.id, {
    email: u.email, display_name: u.display_name, role: u.role, must_change_password: u.must_change_password,
    active: u.active, institution_id: u.institution_id, created_at: u.created_at, last_seen_at: u.last_seen_at,
  });
}

const memberIds = new Map();
for (const m of members) {
  if (skippedIds.has(m.user_id)) continue;
  if (!memberIds.has(m.group_id)) memberIds.set(m.group_id, []);
  memberIds.get(m.group_id).push(m.user_id);
}
for (const g of groups) {
  put(COL.groups, g.id, {
    name: g.name, description: g.description, created_at: g.created_at, institution_id: g.institution_id,
    member_ids: memberIds.get(g.id) || [],
  });
}

for (const b of blueprints) {
  put(COL.blueprints, b.id, {
    name: b.name, description: b.description, spec: b.spec, is_default: b.is_default,
    created_at: b.created_at, institution_id: b.institution_id,
  });
}

const folderIds = new Map();
for (const f of filed) {
  if (!folderIds.has(f.exam_id)) folderIds.set(f.exam_id, []);
  folderIds.get(f.exam_id).push(f.folder_id);
}
for (const e of exams) {
  put(COL.exams, e.id, {
    title: e.title, code: e.code, blueprint_id: e.blueprint_id, timing_mode: e.timing_mode, created_at: e.created_at,
    institution_id: e.institution_id, active: e.active, kind: e.kind, form: json(e.form), locked: e.locked,
    unlocks_at: e.unlocks_at, scope: e.scope, folder_ids: folderIds.get(e.id) || [],
  });
}
for (const f of folders) {
  put(COL.examFolders, f.id, { name: f.name, parent_id: f.parent_id, created_at: f.created_at, institution_id: f.institution_id });
}

for (const a of assignments) {
  if (skippedIds.has(a.user_id)) continue;
  put(COL.assignments, a.id, {
    kind: a.kind, exam_id: a.exam_id, practice: a.practice, target_type: a.target_type, user_id: a.user_id,
    group_id: a.group_id, assigned_by: skippedIds.has(a.assigned_by) ? null : a.assigned_by, due_at: a.due_at,
    created_at: a.created_at, institution_id: a.institution_id, hidden: a.hidden,
  });
}

const bySession = new Map();
for (const r of responses) {
  if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
  bySession.get(r.session_id).push({
    q_instance_id: r.q_instance_id, item_id: r.item_id, module_key: r.module_key, selected_idx: r.selected_idx,
    selected_text: r.selected_text, correct: r.correct, is_marked: r.is_marked,
  });
}
for (const s of sessions) {
  if (skippedIds.has(s.user_id)) continue;
  const rs = bySession.get(s.id) || [];
  const doc = {
    assignment_id: s.assignment_id, exam_id: s.exam_id, user_id: s.user_id, institution_id: s.institution_id,
    form: json(s.form), state: json(s.state || {}), routing: s.routing || {}, status: s.status, kind: s.kind,
    title: s.title, timing_mode: s.timing_mode, practice: s.practice, rw_scaled: s.rw_scaled,
    math_scaled: s.math_scaled, total_scaled: s.total_scaled, started_at: s.started_at, completed_at: s.completed_at,
    hidden_at: s.hidden_at, responses: rs, response_count: rs.length, correct_count: rs.filter((r) => r.correct).length,
    ...seenFields(s.form),
  };
  const size = JSON.stringify(doc).length;
  if (size > 950_000) throw new Error(`session ${s.id} would be ${size} bytes, over Firestore's 1 MiB`);
  put(COL.sessions, s.id, doc);
}

log(`documents: ${institutions.length} institutions, ${kept.length} users, ${groups.length} groups, ${blueprints.length} blueprints, `
  + `${exams.length} exams, ${folders.length} folders, ${assignments.length} assignments, ${sessions.length} sessions; `
  + `${itemCount} questions and ${assetIds.length} images next`);

if (!DRY) {
  // ---- What the API made on its own before the copy ----------------------------
  // An API instance that served a request first made insat's institution, the
  // generation pool and the blueprint templates under new ids. Empty, they
  // give way to the ones being copied; with anything in them, stop.
  const clash = [];
  for (const i of institutions) {
    const snap = await col(COL.institutions).where('slug', '==', i.slug).get();
    for (const d of snap.docs.filter((x) => x.id !== i.id)) clash.push(d);
  }
  for (const d of clash) {
    const used = await Promise.all([COL.items, COL.users, COL.sessions].map(async (name) => (
      await col(name).where('institution_id', '==', d.id).limit(1).get()).size));
    if (used.some(Boolean)) throw new Error(`institution ${d.get('slug')} already exists in Firestore with data (${d.id}); not overwriting it`);
    await d.ref.delete();
    log(`removed the empty ${d.get('slug')} institution the API had made (${d.id})`);
  }
  const names = new Set(blueprints.filter((b) => !b.institution_id).map((b) => b.name));
  const ids = new Set(blueprints.map((b) => b.id));
  for (const d of (await col(COL.blueprints).where('institution_id', '==', null).get()).docs) {
    if (ids.has(d.id) || !names.has(d.get('name'))) continue;
    const used = await col(COL.exams).where('blueprint_id', '==', d.id).limit(1).get();
    if (used.empty) { await d.ref.delete(); log(`removed the ${d.get('name')} blueprint the API had made (${d.id})`); }
  }

  // ---- Firebase Auth: the accounts, with their bcrypt hashes -----------------
  const existing = new Set();
  for (const part of chunks(kept.map((u) => ({ uid: u.id })), 100)) {
    for (const r of (await auth.getUsers(part)).users) existing.add(r.uid);
  }
  const fresh = kept.filter((u) => !existing.has(u.id));
  for (const part of chunks(fresh, 1000)) {
    const result = await auth.importUsers(part.map((u) => ({
      uid: u.id,
      email: u.email,
      displayName: u.display_name,
      disabled: !u.active,
      passwordHash: Buffer.from(u.password_hash),
    })), { hash: { algorithm: 'BCRYPT' } });
    for (const e of result.errors) throw new Error(`could not import ${part[e.index].email}: ${e.error.message}`);
  }
  log(`accounts: ${fresh.length} imported, ${existing.size} already there`);

  await writeAll(ops);
  log(`wrote ${ops.length} documents`);

  // ---- Questions, 500 at a time ----------------------------------------------
  const cursor = { last: '00000000-0000-0000-0000-000000000000' };
  let done = 0;
  for (;;) {
    const batch = (await client.query('SELECT * FROM pa_items WHERE id > $1 ORDER BY id LIMIT 500', [cursor.last])).rows;
    if (!batch.length) break;
    const itemOps = [];
    for (const it of batch) {
      itemOps.push(['set', col(COL.itemHashes).doc(`${it.institution_id}_${it.content_hash}`), { item_id: it.id }]);
      itemOps.push(['set', col(COL.items).doc(it.id), {
        institution_id: it.institution_id, content_hash: it.content_hash, section: it.section, domain: it.domain,
        skill: it.skill, difficulty: it.difficulty, passage: it.passage, question: it.question, choices: it.choices,
        correct_idx: it.correct_idx, answer_type: it.answer_type, rationale: it.rationale || {}, figure: json(it.figure),
        asset_id: it.asset_id, source: it.source, verified: it.verified, created_at: it.created_at,
        retired_at: it.retired_at, answer_text: it.answer_text, simhash: it.simhash, accepted: it.accepted,
        realism: it.realism, variant_of: it.variant_of, updated_at: FieldValue.serverTimestamp(),
      }]);
    }
    await writeAll(itemOps);
    done += batch.length;
    cursor.last = batch[batch.length - 1].id;
    if (done % 2500 < 500) log(`questions: ${done}/${itemCount}`);
  }
  log(`questions: ${done} written`);

  // ---- Images into Storage ---------------------------------------------------
  const [files] = await bucket().getFiles({ prefix: 'assets/' });
  const have = new Set(files.map((f) => f.name.slice('assets/'.length)));
  const missing = assetIds.filter((id) => !have.has(id));
  let uploaded = 0;
  for (const part of chunks(missing, 8)) {
    await Promise.all(part.map(async (id) => {
      const { rows: [a] } = await images.query('SELECT mime, bytes FROM pa_assets WHERE id = $1', [id]);
      await retried(`image ${id}`, () => bucket().file(`assets/${id}`).save(a.bytes, {
        resumable: false, contentType: a.mime, metadata: { cacheControl: 'public, max-age=86400' },
      }));
    }));
    uploaded += part.length;
    if (uploaded % 200 < 8) log(`images: ${uploaded}/${missing.length}`);
  }
  log(`images: ${uploaded} uploaded, ${assetIds.length - missing.length} already there`);

  // ---- Check: every collection holds what Postgres held ------------------------
  const expect = {
    [COL.institutions]: institutions.length,
    [COL.users]: kept.length,
    [COL.groups]: groups.length,
    [COL.blueprints]: blueprints.length,
    [COL.exams]: exams.length,
    [COL.examFolders]: folders.length,
    [COL.assignments]: assignments.filter((a) => !skippedIds.has(a.user_id)).length,
    [COL.sessions]: sessions.filter((s) => !skippedIds.has(s.user_id)).length,
    [COL.items]: itemCount,
  };
  let ok = true;
  for (const [name, n] of Object.entries(expect)) {
    const got = (await db.collection(name).count().get()).data().count;
    const fine = got >= n;
    ok &&= fine;
    log(`${fine ? 'ok ' : 'MISSING'} ${name}: ${got} (Postgres ${n})`);
  }
  const [after] = await bucket().getFiles({ prefix: 'assets/' });
  const stored = new Set(after.map((f) => f.name.slice('assets/'.length)));
  const lost = assetIds.filter((id) => !stored.has(id)).length;
  log(`${lost ? 'MISSING' : 'ok '} images: ${assetIds.length - lost} of ${assetIds.length}`);
  if (!ok || lost) process.exitCode = 1;
}

await images.end();
await client.end();
