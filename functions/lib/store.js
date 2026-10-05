// Firestore access shared by the routes and libraries.
//
// One collection per former Postgres table, and each document keeps the
// table's column names (snake_case), so a document reads back as the same row
// the code always worked with: `row.correct_idx`, `s.form`, `e.timing_mode`.
// Ids are UUIDs, as they were (a Firebase Auth uid for a self-made account).
//
// Two kinds of value are stored as JSON text rather than as Firestore maps: a
// question's figure (it can hold nested arrays, which Firestore refuses) and
// the large blobs no query reads into (a session's form and resume state, a
// custom test's form). rowOf() parses them back; docOf() writes them.
// Timestamps read back as Dates, as they did from pg.

import crypto from 'node:crypto';
import { Timestamp, FieldPath } from 'firebase-admin/firestore';
import { db } from './firebase.js';

export const COL = {
  institutions: 'institutions',
  users: 'users',
  groups: 'groups',
  items: 'items',
  itemHashes: 'itemHashes',
  blueprints: 'blueprints',
  exams: 'exams',
  examFolders: 'examFolders',
  assignments: 'assignments',
  sessions: 'sessions',
  invites: 'invites',
};

const JSON_FIELDS = {
  items: ['figure'],
  sessions: ['form', 'state'],
  exams: ['form'],
};

export const newId = () => crypto.randomUUID();
export const now = () => new Date();
export const col = (name) => db.collection(name);

/**
 * Whether a string can name a document. A URL parameter is never trusted to:
 * one with a slash would address a subcollection, and '.', '..' and '__x__'
 * are reserved. An id that cannot exist is simply not found.
 */
export function isDocId(id) {
  if (typeof id !== 'string' || !id || id.length > 512) return false;
  if (id.includes('/') || id === '.' || id === '..') return false;
  return !/^__.*__$/.test(id);
}

/** A document reference, or null for an id that cannot name one. */
export const ref = (name, id) => (isDocId(id) ? col(name).doc(id) : null);

function fromValue(v) {
  if (v instanceof Timestamp) return v.toDate();
  return v;
}

/** A snapshot as the row it stands for (null when it does not exist). */
export function rowOf(snap, name = snap?.ref?.parent?.id) {
  if (!snap || !snap.exists) return null;
  const data = snap.data();
  const row = { id: snap.id };
  for (const [k, v] of Object.entries(data)) row[k] = fromValue(v);
  for (const field of JSON_FIELDS[name] || []) {
    if (typeof row[field] === 'string') {
      try { row[field] = JSON.parse(row[field]); } catch { row[field] = null; }
    }
  }
  return row;
}

/** A row (or the fields of one) as the document data to write. */
export function docOf(name, row) {
  const data = { ...row };
  delete data.id;
  for (const field of JSON_FIELDS[name] || []) {
    if (field in data && data[field] != null && typeof data[field] !== 'string') data[field] = JSON.stringify(data[field]);
  }
  return data;
}

export const rowsOf = (snapshot, name) => snapshot.docs.map((d) => rowOf(d, name));

/** One row by id, or null. */
export async function getRow(name, id) {
  const r = ref(name, id);
  return r ? rowOf(await r.get(), name) : null;
}

/** The rows of a query. */
export const queryRows = async (query) => rowsOf(await query.get());

export const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Rows by id, as a Map (ids that do not exist are left out). `fields` limits
 * what is read back, for a list that does not need the large ones.
 */
export async function getMany(name, ids, fields = null) {
  const out = new Map();
  const refs = [...new Set(ids)].filter(isDocId).map((id) => col(name).doc(id));
  for (const part of chunks(refs, 200)) {
    const snaps = await db.getAll(...part, ...(fields ? [{ fieldMask: fields }] : []));
    for (const s of snaps) if (s.exists) out.set(s.id, rowOf(s, name));
  }
  return out;
}

/**
 * Rows whose `field` is any of `values`. Firestore's `in` takes 30 values at a
 * time; `where` adds further equality filters as [field, op, value] triples.
 */
export async function whereIn(name, field, values, where = [], fields = null) {
  const rows = [];
  for (const part of chunks([...new Set(values)].filter((v) => v != null), 30)) {
    let q = col(name).where(field === 'id' ? FieldPath.documentId() : field, 'in', part);
    for (const [f, op, v] of where) q = q.where(f, op, v);
    if (fields) q = q.select(...fields);
    rows.push(...rowsOf(await q.get(), name));
  }
  return rows;
}

/** Write many documents, 400 to a batch. `ops` are [kind, ref, data?] triples. */
export async function writeAll(ops) {
  for (const part of chunks(ops, 400)) {
    const batch = db.batch();
    for (const [kind, r, data] of part) {
      if (kind === 'delete') batch.delete(r);
      else if (kind === 'update') batch.update(r, data);
      else if (kind === 'create') batch.create(r, data);
      else batch.set(r, data, kind === 'merge' ? { merge: true } : undefined);
    }
    await batch.commit();
  }
}

/** Delete every document a query matches; the count deleted. */
export async function deleteWhere(query) {
  const snap = await query.select().get();
  await writeAll(snap.docs.map((d) => ['delete', d.ref]));
  return snap.size;
}

/** The number of documents a query matches. */
export async function countOf(query) {
  return (await query.count().get()).data().count;
}
