// Central env-derived config. Read once at boot; fail fast on anything missing
// that the app cannot run without.

const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'dev-only-change-me-satify'),
  port: Number(process.env.PORT || 3002),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  admin: {
    email: (process.env.ADMIN_EMAIL || 'admin@satify.test').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'satify-admin',
    name: process.env.ADMIN_NAME || 'insat Admin',
  },
  // Platform owner - provisions institutions and their first admin.
  super: {
    email: (process.env.SUPERADMIN_EMAIL || 'superadmin@satify.test').toLowerCase(),
    password: process.env.SUPERADMIN_PASSWORD || 'satify-super',
    name: process.env.SUPERADMIN_NAME || 'insat Superadmin',
  },
  // Generation models - drafting is cheap, verification is strong.
  genModel: process.env.GEN_MODEL || 'sonnet',
  verifyModel: process.env.VERIFY_MODEL || 'opus',
  // Upload question extraction. EXTRACT_MODEL can be set to 'haiku' for faster,
  // cheaper extraction (at some accuracy cost). Concurrency/chunk size tune how
  // aggressively a multi-page PDF is parallelized across model calls.
  extractModel: process.env.EXTRACT_MODEL || process.env.GEN_MODEL || 'sonnet',
  extractConcurrency: Math.max(1, Number(process.env.EXTRACT_CONCURRENCY) || 6),
  extractChunkPages: Math.max(1, Number(process.env.EXTRACT_CHUNK_PAGES) || 4),
  // Platform-wide Anthropic key - the fallback when an institution hasn't set
  // its own. Generation + extraction run inside this API now (no external
  // service), so this is the only key the app needs to generate questions.
  platformApiKey: process.env.ANTHROPIC_API_KEY || '',
  // Optional email provider (Resend) for invite links. Empty => links are shown
  // to the admin to share manually instead of emailed.
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'insat <onboarding@resend.dev>',
  // Encryption key for institution LLM API keys at rest.
  encryptionKey: process.env.ENCRYPTION_KEY || `${process.env.JWT_SECRET || 'dev-only-change-me-satify'}-enc`,
  // When true, an institution must set its OWN key to generate/upload
  // (no platform-key fallback).
  requireInstitutionKey: String(process.env.REQUIRE_INSTITUTION_KEY || '').toLowerCase() === 'true',
};
