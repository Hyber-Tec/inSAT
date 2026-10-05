/**
 * POST /api/responses
 *
 * The hot write path. Every answer change, mark toggle, and cross-out
 * from the client lands here. This endpoint must be:
 *
 *   • Idempotent — clients retry freely on network errors.
 *   • Low-latency — students cannot tolerate >100ms here.
 *   • Event-sourced — the immutable test_events row is the source of truth;
 *     the responses row is a materialized projection of the latest state.
 *   • Authenticated — JWT in Authorization header, validated upstream by
 *     the BFF layer, with user_id and test_session_id passed in headers.
 *
 * In production this would be a Go service behind the BFF, not a Next.js
 * route. The route handler below shows the intended logic.
 */

import type { NextRequest } from 'next/server';
import { db } from '../lib/db';
import { z } from 'zod';

const ResponseEventSchema = z.object({
  // Idempotency key generated client-side. Reissued requests with the
  // same key are no-ops.
  clientEventId: z.string().uuid(),
  testSessionId: z.string().uuid(),
  itemId: z.string().uuid(),
  moduleId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  eventType: z.enum([
    'answer_selected',
    'answer_cleared',
    'mark_toggled',
    'crossout_toggled',
  ]),
  // Payload shape varies by event type:
  payload: z.object({
    selectedIdx: z.number().int().min(0).max(3).optional(),
    isMarked: z.boolean().optional(),
    crossedOut: z.array(z.number().int().min(0).max(3)).optional(),
    timeSpentMs: z.number().int().min(0).optional(),
  }),
});

export async function POST(req: NextRequest) {
  // Auth: BFF guarantees these headers are set after JWT validation.
  const userId = req.headers.get('x-user-id');
  const sessionId = req.headers.get('x-session-id');
  if (!userId || !sessionId) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = ResponseEventSchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: 'invalid_payload', detail: String(err) }, { status: 400 });
  }

  if (body.testSessionId !== sessionId) {
    return Response.json({ error: 'session_mismatch' }, { status: 403 });
  }

  // Single transaction: insert the event and update the response projection.
  // The UNIQUE (test_session_id, client_event_id) constraint on test_events
  // gives us idempotency for free — duplicate inserts raise a 23505 we swallow.
  try {
    await db.transaction(async (tx) => {
      // 1. Event row — immutable, append-only.
      try {
        await tx.query(
          `INSERT INTO test_events
             (test_session_id, client_event_id, occurred_at,
              event_type, item_id, module_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            body.testSessionId,
            body.clientEventId,
            body.occurredAt,
            body.eventType,
            body.itemId,
            body.moduleId,
            body.payload,
          ]
        );
      } catch (e: any) {
        if (e.code === '23505') {
          // Duplicate client_event_id — this is a retry, nothing more to do.
          return;
        }
        throw e;
      }

      // 2. Projection update — last-write-wins on each field that this
      //    event type touches.
      switch (body.eventType) {
        case 'answer_selected':
          await tx.query(
            `INSERT INTO responses
               (test_session_id, item_id, module_id, selected_idx, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (test_session_id, item_id) DO UPDATE
               SET selected_idx = EXCLUDED.selected_idx,
                   updated_at   = now()`,
            [body.testSessionId, body.itemId, body.moduleId, body.payload.selectedIdx]
          );
          break;

        case 'answer_cleared':
          await tx.query(
            `UPDATE responses
                SET selected_idx = NULL, updated_at = now()
              WHERE test_session_id = $1 AND item_id = $2`,
            [body.testSessionId, body.itemId]
          );
          break;

        case 'mark_toggled':
          await tx.query(
            `INSERT INTO responses
               (test_session_id, item_id, module_id, is_marked, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (test_session_id, item_id) DO UPDATE
               SET is_marked  = EXCLUDED.is_marked,
                   updated_at = now()`,
            [body.testSessionId, body.itemId, body.moduleId, body.payload.isMarked]
          );
          break;

        case 'crossout_toggled':
          await tx.query(
            `INSERT INTO responses
               (test_session_id, item_id, module_id, crossed_out, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (test_session_id, item_id) DO UPDATE
               SET crossed_out = EXCLUDED.crossed_out,
                   updated_at  = now()`,
            [body.testSessionId, body.itemId, body.moduleId, body.payload.crossedOut]
          );
          break;
      }
    });

    return Response.json({ ok: true });
  } catch (err) {
    // Don't leak internals. Log to observability stack instead.
    console.error('response_ingest_error', { sessionId, err });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * POST /api/sessions/:id/submit-module
 *
 * Called when a student submits a module (or the timer runs out).
 * Finalizes the responses for that module, runs adaptive routing for the
 * NEXT module if this was Module 1, and returns the routing decision.
 */
export async function submitModule(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionId = params.id;
  const { moduleId } = await req.json();

  const result = await db.transaction(async (tx) => {
    // Mark responses as submitted (immutable from here on).
    await tx.query(
      `UPDATE responses
          SET submitted_at = now()
        WHERE test_session_id = $1 AND module_id = $2 AND submitted_at IS NULL`,
      [sessionId, moduleId]
    );

    // If this was module 1, compute provisional theta and select module 2.
    const moduleRow = (await tx.query(
      `SELECT ordinal, section_id FROM test_modules WHERE id = $1`,
      [moduleId]
    )).rows[0];

    if (moduleRow.ordinal === 1) {
      // Lazy-load the adaptive module; it's CPU-heavy so we keep it out
      // of the hot path until we actually need it.
      const { provisionalTheta, selectModule2 } = await import('../lib/adaptive');
      const responses = (await tx.query(
        `SELECT i.irt_difficulty, i.irt_discrim, i.irt_guess,
                r.selected_idx = i.correct_idx AS correct
           FROM responses r JOIN items i ON i.id = r.item_id
          WHERE r.test_session_id = $1 AND r.module_id = $2`,
        [sessionId, moduleId]
      )).rows;

      const theta = provisionalTheta(
        responses.map((r: any) => ({
          item: {
            discrimination: r.irt_discrim ?? 1.0,
            difficulty: r.irt_difficulty ?? 0.0,
            guessing: r.irt_guess ?? 0.25,
          },
          correct: r.correct,
        }))
      );
      const routing = selectModule2(theta);

      // Pick the actual next module: same section, ordinal=2, matching difficulty
      const next = (await tx.query(
        `SELECT id FROM test_modules
          WHERE section_id = $1 AND ordinal = 2 AND difficulty = $2`,
        [moduleRow.section_id, routing]
      )).rows[0];

      return { nextModuleId: next.id, theta, routing };
    }

    return { nextModuleId: null };
  });

  return Response.json(result);
}
