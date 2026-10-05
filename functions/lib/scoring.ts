/**
 * Final scoring for a completed test session.
 *
 * The adaptive module already gives us a per-section scaled score
 * (`finalScaledScore` in ./adaptive). This module orchestrates:
 *
 *   1. Loading both sections' module pairs for a session.
 *   2. Calling finalScaledScore() per section with the routing that
 *      was actually used.
 *   3. Writing the scaled scores back onto test_sessions and marking
 *      the session completed.
 *
 * Scoring is async - students see "results pending" until this runs.
 * In a real deployment it's a worker reading from a Kafka topic
 * (session_completed events), not an inline call.
 */

import { db } from './db';
import { finalScaledScore, ModuleRouting } from './adaptive';

interface ModuleStats {
  moduleId: string;
  correct: number;
  total: number;
  difficulty: 'mixed' | 'easy' | 'hard';
}

async function loadModuleStats(sessionId: string, moduleId: string): Promise<ModuleStats> {
  const row = (await db.query(
    `SELECT
       m.id           AS module_id,
       m.difficulty   AS difficulty,
       COUNT(r.*)::int AS total,
       COUNT(*) FILTER (WHERE r.selected_idx = i.correct_idx)::int AS correct
     FROM test_modules m
       LEFT JOIN responses r ON r.module_id = m.id AND r.test_session_id = $1
       LEFT JOIN items i ON i.id = r.item_id
     WHERE m.id = $2
     GROUP BY m.id, m.difficulty`,
    [sessionId, moduleId]
  )).rows[0];

  return {
    moduleId: row.module_id,
    correct: row.correct,
    total: row.total,
    difficulty: row.difficulty,
  };
}

interface SectionScoreInput {
  module1Id: string;
  module2Id: string;
}

async function scoreSection(sessionId: string, input: SectionScoreInput): Promise<number> {
  const [m1, m2] = await Promise.all([
    loadModuleStats(sessionId, input.module1Id),
    loadModuleStats(sessionId, input.module2Id),
  ]);
  // Module 2's difficulty tells us which routing the student took.
  const routing: ModuleRouting = m2.difficulty === 'hard' ? 'hard' : 'easy';
  return finalScaledScore(m1.correct, m1.total, m2.correct, m2.total, routing);
}

/**
 * Score a session and persist the result. Idempotent - safe to retry.
 *
 * Returns the scaled scores. Throws if any required module pointer
 * on the session is null (i.e. the session hasn't actually completed
 * all four modules yet).
 */
export async function scoreSession(sessionId: string): Promise<{ rw: number; math: number; total: number }> {
  const session = (await db.query(
    `SELECT rw_module_1_id, rw_module_2_id, math_module_1_id, math_module_2_id, completed_at
       FROM test_sessions WHERE id = $1`,
    [sessionId]
  )).rows[0];

  if (!session) throw new Error(`session_not_found: ${sessionId}`);
  if (!session.rw_module_1_id || !session.rw_module_2_id ||
      !session.math_module_1_id || !session.math_module_2_id) {
    throw new Error(`session_incomplete: ${sessionId}`);
  }

  const [rwScaled, mathScaled] = await Promise.all([
    scoreSection(sessionId, { module1Id: session.rw_module_1_id, module2Id: session.rw_module_2_id }),
    scoreSection(sessionId, { module1Id: session.math_module_1_id, module2Id: session.math_module_2_id }),
  ]);
  const total = rwScaled + mathScaled;

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE test_sessions
          SET rw_scaled = $2,
              math_scaled = $3,
              total_scaled = $4,
              completed_at = COALESCE(completed_at, now())
        WHERE id = $1`,
      [sessionId, rwScaled, mathScaled, total]
    );
    await tx.query(
      `INSERT INTO test_events
         (test_session_id, client_event_id, occurred_at, event_type, payload)
       VALUES ($1, gen_random_uuid(), now(), 'session_completed', $2)`,
      [sessionId, { rwScaled, mathScaled, total }]
    );
  });

  return { rw: rwScaled, math: mathScaled, total };
}
