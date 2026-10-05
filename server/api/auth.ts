/**
 * Auth endpoints. Stub implementation — replace with Auth.js / Clerk /
 * your IdP of choice. The shape of the issued JWT is what matters for
 * the rest of the stack.
 *
 * Expected JWT claims:
 *   sub:  user UUID
 *   role: 'student' | 'proctor' | 'admin'
 *   iat:  issued-at
 *   exp:  expiry (15 min for students during a session)
 *
 * Sessions are bound to a single test_session_id by a short-lived "test
 * token" issued at the start of a test. Test tokens can't be re-used
 * across sessions.
 */

import type { NextRequest } from 'next/server';
import { db } from '../lib/db';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-me');
const ISSUER = 'satify';
const SESSION_TTL = '15m';

/**
 * POST /api/auth/login
 * Body: { email, password }
 *
 * Production: never roll your own password handling. Hand this off to
 * Auth.js (NextAuth), Clerk, WorkOS, or your enterprise SSO. This stub
 * exists only so the schema is wired end-to-end.
 */
export async function login(req: NextRequest) {
  const Body = z.object({ email: z.string().email(), password: z.string().min(8) });
  const body = Body.parse(await req.json());

  // Stub: real impl verifies argon2id password hash against a hashed_password column.
  const user = (await db.query(
    `SELECT id, email, display_name, role FROM users WHERE email = $1`,
    [body.email]
  )).rows[0];

  if (!user) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const jwt = await new SignJWT({ sub: user.id, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(SESSION_TTL)
    .sign(secret);

  return Response.json({
    token: jwt,
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
  });
}

/**
 * POST /api/auth/test-session
 * Body: { testCode }
 *
 * Issues a "test token" — a short-lived JWT bound to a specific
 * test_session_id. The client uses this token (not the login token)
 * for all in-test API calls.
 */
export async function startTestSession(req: NextRequest, userId: string) {
  const Body = z.object({ testCode: z.string() });
  const { testCode } = Body.parse(await req.json());

  // Find test, create session row.
  const test = (await db.query(`SELECT id FROM tests WHERE code = $1 AND retired_at IS NULL`, [testCode])).rows[0];
  if (!test) return Response.json({ error: 'test_not_found' }, { status: 404 });

  const session = (await db.query(
    `INSERT INTO test_sessions (user_id, test_id) VALUES ($1, $2) RETURNING id, started_at`,
    [userId, test.id]
  )).rows[0];

  // Record the session_started event explicitly — gives us a clean
  // anchor in the audit log.
  await db.query(
    `INSERT INTO test_events (test_session_id, client_event_id, occurred_at, event_type, payload)
     VALUES ($1, gen_random_uuid(), now(), 'session_started', '{}')`,
    [session.id]
  );

  const testToken = await new SignJWT({ sub: userId, sid: session.id, kind: 'test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime('4h')   // long enough for a 2h45m test + buffer
    .sign(secret);

  return Response.json({ sessionId: session.id, testToken, startedAt: session.started_at });
}

/** Middleware helper: verify and extract user from request. */
export async function requireAuth(req: NextRequest) {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), secret, { issuer: ISSUER });
    return payload as { sub: string; role?: string; sid?: string };
  } catch {
    return null;
  }
}
