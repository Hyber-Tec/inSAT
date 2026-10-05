// What the browser checks make and ask for, in the Firebase emulators the
// local app runs on (./start.sh): accounts and institutions written straight
// into Auth and Firestore with the app's own code (functions/lib), an ID token
// to ask the API as an account, a stored session, and the removal of all of it
// afterwards. The checks only ever run against the emulators: the hosts below
// are set before the Admin SDK starts, whatever the environment says.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8090';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9109';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9209';
process.env.METADATA_SERVER_DETECTION ||= 'none';

// The Admin SDK is the API's (functions/node_modules).
const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { deleteApp, getApps } = await import(pathToFileURL(fromFunctions.resolve('firebase-admin/app')).href);
const { auth } = await import('../../functions/lib/firebase.js');
const {
  COL, col, deleteWhere, getMany, getRow, newId, now, queryRows, writeAll,
} = await import('../../functions/lib/store.js');
const { createAccount, deleteAccount } = await import('../../functions/lib/accounts.js');
const { createInvite } = await import('../../functions/lib/invite.js');
export const { importRows } = await import('../../functions/lib/items.js');
export const { importTemplateRows } = await import('../../functions/lib/templateItems.js');
export const { GLOBAL_POOL_SLUG, POOL_SLUG } = await import('../../functions/lib/pool.js');
export { COL, getMany, getRow };

/** The id of the institution with this slug (insat's own is 'satify'), or null. */
export async function institutionBySlug(slug) {
  const snap = await col(COL.institutions).where('slug', '==', slug).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

/** The ids of the institutions with this name. */
export async function institutionsNamed(name) {
  return (await col(COL.institutions).where('name', '==', name).select().get()).docs.map((d) => d.id);
}

/**
 * A throwaway institution. `ownBank` points its tests and practice at its own
 * bank instead of insat's pool (nothing in the app does that), so a check
 * knows every question it can be served.
 */
export async function makeInstitution({ name, slug = `qa-${newId()}`, mode = 'self_guided', ownBank = false }) {
  const id = newId();
  await col(COL.institutions).doc(id).set({
    name, slug, mode, active: true, created_at: now(),
    llm_api_key_enc: null, llm_key_hint: null, llm_provider: null, llm_model: null,
    logo_asset_id: null, accent: null, pool_institution_id: ownBank ? id : null,
  });
  return id;
}

/**
 * An account as an admin (or the platform owner) would make it, with a
 * password its owner has already chosen: nothing to reset on signing in.
 */
export async function makeAccount({ email, password, role, institutionId = null, name }) {
  const user = await createAccount({ email, displayName: name, password, role, institutionId });
  await col(COL.users).doc(user.id).update({ must_change_password: false });
  return { id: user.id, email: user.email, password, name };
}

/** An invite token for an account (the link is `${origin}/?invite=<token>`). */
export const inviteToken = (account) => createInvite({ userId: account.id, email: account.email });

/** An ID token for an account, from the Auth emulator, to ask the API as it. */
export async function idToken({ email, password }) {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await r.json();
  if (!data.idToken) throw new Error(`could not sign in ${email}: ${data.error?.message || r.status}`);
  return data.idToken;
}

/** Ask the API (at `base`, the app's origin) as an account: { status, body }. */
export async function ask(base, account, method, endpoint, body) {
  const r = await fetch(`${base}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${await idToken(account)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: data };
}

/** The same, for a call that must succeed: its JSON. */
export async function call(base, account, method, endpoint, body) {
  const r = await ask(base, account, method, endpoint, body);
  if (r.status >= 400) throw new Error(`${r.status} ${method} ${endpoint}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

/** A stored session (its form and state parsed), or null. */
export const stored = (id) => getRow(COL.sessions, id);

/** A student's sessions, newest first. */
export async function sessionsOf(userId) {
  return (await queryRows(col(COL.sessions).where('user_id', '==', userId))).sort((a, b) => b.started_at - a.started_at);
}

/** Every item of an institution's bank. */
export const bankOf = (institutionId) => queryRows(col(COL.items).where('institution_id', '==', institutionId));

/** Remove an account and everything that was its alone. */
export async function removeAccount(id) {
  await deleteAccount(id).catch((err) => { if (err.code !== 5) throw err; });
}

/** Remove an institution and everything in it, as the platform console does. */
export async function removeInstitution(id) {
  const members = await col(COL.users).where('institution_id', '==', id).select().get();
  for (const m of members.docs) await removeAccount(m.id);
  const items = await col(COL.items).where('institution_id', '==', id).select('content_hash').get();
  await writeAll(items.docs.filter((d) => d.get('content_hash')).map((d) => ['delete', col(COL.itemHashes).doc(`${id}_${d.get('content_hash')}`)]));
  for (const name of [COL.items, COL.sessions, COL.assignments, COL.groups, COL.exams, COL.examFolders, COL.blueprints]) {
    await deleteWhere(col(name).where('institution_id', '==', id));
  }
  await col(COL.institutions).doc(id).delete();
}

/** Let the process end: close the Admin SDK's connections. */
export const close = () => Promise.all(getApps().map((app) => deleteApp(app)));

/** No Firebase Auth account left over for an email (a check that made one through the UI). */
export async function removeAccountByEmail(email) {
  const user = await auth.getUserByEmail(email).catch(() => null);
  if (user) await removeAccount(user.uid);
}
