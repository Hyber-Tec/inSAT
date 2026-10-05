// Per-institution LLM credentials. The API key is encrypted at rest and never
// returned to the client - only a status (provider + configured + a "…last4"
// hint). The provider and optional model override are stored in the clear.

import { COL, col, getRow } from './store.js';
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
  await col(COL.institutions).doc(institutionId).update({
    llm_api_key_enc: encrypt(key), llm_key_hint: hint, llm_provider: prov, llm_model: mdl,
  });
  return { hint, provider: prov, model: mdl };
}

export async function clearInstitutionKey(institutionId) {
  await col(COL.institutions).doc(institutionId).update({
    llm_api_key_enc: null, llm_key_hint: null, llm_provider: null, llm_model: null,
  });
}

export async function keyStatus(institutionId) {
  const r = (await getRow(COL.institutions, institutionId)) || {};
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
  const ownKey = Boolean((await getRow(COL.institutions, institutionId))?.llm_api_key_enc);
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
  const r = (await getRow(COL.institutions, institutionId)) || {};
  return {
    provider: normProvider(r.llm_provider),
    apiKey: r.llm_api_key_enc ? decrypt(r.llm_api_key_enc) : '',
    model: r.llm_model || '',
  };
}
