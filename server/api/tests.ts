/**
 * Test delivery API.
 *
 *   GET /api/tests/:code             — manifest (sections/modules, no items)
 *   GET /api/tests/:code/module/:id  — module's items (encrypted bundle)
 *
 * For offline-first delivery: the client pre-fetches every module bundle
 * at session start, stores them in IndexedDB encrypted, and only requests
 * the decryption key from the server at the moment the module begins.
 * That way a network hiccup mid-test never blocks a student.
 *
 * Encryption: AES-256-GCM with a per-module key derived from the session
 * token + a server-held secret. Skipped here for brevity — production
 * uses libsodium / WebCrypto on both ends.
 */

import type { NextRequest } from 'next/server';
import { db } from '../lib/db';
import { requireAuth } from './auth';

/** GET /api/tests/:code */
export async function getTestManifest(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireAuth(req);
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const test = (await db.query(
    `SELECT id, code, title, version FROM tests
      WHERE code = $1 AND retired_at IS NULL AND published_at IS NOT NULL`,
    [params.code]
  )).rows[0];

  if (!test) return Response.json({ error: 'not_found' }, { status: 404 });

  // Sections + modules, but NOT items — items come in per-module bundles below.
  const sections = (await db.query(
    `SELECT s.id, s.ordinal, s.kind, s.name, s.time_limit_sec,
            COALESCE(json_agg(json_build_object(
              'id', m.id,
              'ordinal', m.ordinal,
              'difficulty', m.difficulty
            ) ORDER BY m.ordinal, m.difficulty) FILTER (WHERE m.id IS NOT NULL), '[]') AS modules
       FROM test_sections s
       LEFT JOIN test_modules m ON m.section_id = s.id
      WHERE s.test_id = $1
      GROUP BY s.id
      ORDER BY s.ordinal`,
    [test.id]
  )).rows;

  return Response.json({
    id: test.id,
    code: test.code,
    title: test.title,
    version: test.version,
    sections,
  });
}

/** GET /api/tests/:code/module/:moduleId */
export async function getModuleBundle(
  req: NextRequest,
  { params }: { params: { code: string; moduleId: string } }
) {
  const auth = await requireAuth(req);
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // In production: gate access by checking that this user's session
  // includes this moduleId (either as a base module or as the routed
  // module 2 for their section). Skipped here for brevity.

  const items = (await db.query(
    `SELECT i.id, i.kind, i.passage, i.question, i.choices, mi.ordinal
       FROM module_items mi
       JOIN items i ON i.id = mi.item_id
      WHERE mi.module_id = $1 AND i.retired_at IS NULL
      ORDER BY mi.ordinal`,
    [params.moduleId]
  )).rows;

  if (items.length === 0) {
    return Response.json({ error: 'module_not_found' }, { status: 404 });
  }

  // NOTE: correct_idx is deliberately NOT returned to the client.
  // Scoring happens server-side after submission.
  return Response.json({
    moduleId: params.moduleId,
    items: items.map((it) => ({
      id: it.id,
      kind: it.kind,
      passage: it.passage,
      question: it.question,
      choices: it.choices,
      ordinal: it.ordinal,
    })),
  });
}
