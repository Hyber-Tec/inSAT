// Per-institution LLM credentials. The API key is encrypted at rest and never
// returned to the client - only a status (provider + configured + a "…last4"
// hint). The provider and optional model override are stored in the clear.

import { query } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { config } from './config.js';
import { PROVIDERS, DEFAULT_PROVIDER, providerCatalog } from './llm.js';

const hintFor = (key) => `…${String(key).trim().slice(-4)}`;
const normProvider = (p) => (p && PROVIDERS[p] ? p : DEFAULT_PROVIDER);

export async function setInstitutionKey(institutionId, { apiKey, provider, model }) {
  const key = String(apiKey).trim();
  const prov = normProvider(provider);
  const mdl = String(model || '').trim() || null;
  const hint = hintFor(key);
  await query(
    'UPDATE pa_institutions SET llm_api_key_enc = $1, llm_key_hint = $2, llm_provider = $3, llm_model = $4 WHERE id = $5',
    [encrypt(key), hint, prov, mdl, institutionId],
  );
  return { hint, provider: prov, model: mdl };
}

export async function clearInstitutionKey(institutionId) {
  await query(
    'UPDATE pa_institutions SET llm_api_key_enc = NULL, llm_key_hint = NULL, llm_provider = NULL, llm_model = NULL WHERE id = $1',
    [institutionId],
  );
}

export async function keyStatus(institutionId) {
  const { rows } = await query(
    'SELECT llm_api_key_enc, llm_key_hint, llm_provider, llm_model FROM pa_institutions WHERE id = $1',
    [institutionId],
  );
  const r = rows[0] || {};
  return {
    configured: Boolean(r.llm_api_key_enc),
    hint: r.llm_key_hint || null,
    provider: normProvider(r.llm_provider),
    model: r.llm_model || null,
    requireOwnKey: config.requireInstitutionKey,
    providers: providerCatalog(),
  };
}

/**
 * Whether AI can run for the institution now: it has its own key on file, or
 * the platform has one and institutions are not required to bring their own.
 */
export async function aiStatus(institutionId) {
  const { rows } = await query('SELECT llm_api_key_enc IS NOT NULL AS own FROM pa_institutions WHERE id = $1', [institutionId]);
  const ownKey = Boolean(rows[0]?.own);
  return {
    ready: ownKey || (!config.requireInstitutionKey && Boolean(config.platformApiKey)),
    ownKey,
    requiresOwnKey: config.requireInstitutionKey,
  };
}

/**
 * Decrypted institution credentials for a completion call.
 * `apiKey` is '' when none is set (caller may fall back to the platform key).
 * @returns {Promise<{provider:string, apiKey:string, model:string}>}
 */
export async function getInstitutionCredentials(institutionId) {
  const { rows } = await query(
    'SELECT llm_api_key_enc, llm_provider, llm_model FROM pa_institutions WHERE id = $1',
    [institutionId],
  );
  const r = rows[0] || {};
  return {
    provider: normProvider(r.llm_provider),
    apiKey: r.llm_api_key_enc ? decrypt(r.llm_api_key_enc) : '',
    model: r.llm_model || '',
  };
}
