// Central env-derived config, read once per instance. Cloud Functions loads
// functions/.env.<project> (the committed, non-secret values) and binds the
// secrets (ENCRYPTION_KEY); the emulators and scripts also read
// functions/.env.local and .secret.local (both git-ignored).

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const inCloud = Boolean(process.env.K_SERVICE) && process.env.FUNCTIONS_EMULATOR !== 'true';

// Where the app is served. The first origin is the one links point at
// (invites); every one of them may call the API across origins.
const origins = list(process.env.CLIENT_ORIGIN || 'http://localhost:5180');

export const config = {
  clientOrigin: origins[0],
  corsOrigins: origins,
  // The platform owners: an account signed in with one of these verified
  // emails is the superadmin, who provisions institutions and their admins.
  superadminEmails: list(process.env.SUPERADMIN_EMAILS).map((e) => e.toLowerCase()),
  // The academy a new sign-up joins, as a student (insat's own, self-guided).
  signupInstitutionSlug: process.env.SIGNUP_INSTITUTION_SLUG || 'satify',
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
  // its own. Not bound in production (REQUIRE_INSTITUTION_KEY is true there);
  // the offline scripts read it from functions/.env.local.
  platformApiKey: process.env.ANTHROPIC_API_KEY || '',
  // Optional email provider (Resend) for invite links. Empty => links are shown
  // to the admin to share manually instead of emailed.
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'insat <onboarding@resend.dev>',
  // Encryption key for institution LLM API keys at rest: a secret in
  // production, never a default there.
  encryptionKey: process.env.ENCRYPTION_KEY || (inCloud ? '' : 'dev-only-insat-enc'),
  // When true, an institution must set its OWN key to generate/upload
  // (no platform-key fallback).
  requireInstitutionKey: String(process.env.REQUIRE_INSTITUTION_KEY || '').toLowerCase() === 'true',
};

if (!config.encryptionKey) throw new Error('Missing required secret: ENCRYPTION_KEY');
