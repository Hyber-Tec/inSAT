// Anthropic Message Batches. Generation that nobody is waiting on should not
// run at request time: batching costs half as much per token, and the latency
// (minutes, not seconds) is irrelevant when the output goes into a pool rather
// than onto a student's screen.
//
// Batches are Anthropic-only. Institutions on another provider fall back to the
// synchronous path in generate.js, which still works -- it just costs more.

import { config } from './config.js';
import { DEFAULT_PROVIDER, resolveModel } from './llm.js';

const API = 'https://api.anthropic.com/v1/messages/batches';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headersFor = (key) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

function credentials(creds = {}) {
  const provider = creds.provider || DEFAULT_PROVIDER;
  const key = String(creds.apiKey || '').trim() || config.platformApiKey;
  return { provider: String(creds.apiKey || '').trim() ? provider : DEFAULT_PROVIDER, key };
}

/** Batches only exist on Anthropic; everything else must use the sync path. */
export function batchSupported(creds = {}) {
  const { provider, key } = credentials(creds);
  return provider === DEFAULT_PROVIDER && Boolean(key);
}

async function call(url, { key, method = 'GET', body = null }) {
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method, headers: headersFor(key), body });
    } catch (err) {
      if (attempt >= 4) throw new Error(`Could not reach the Batches API: ${err.message}`);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res;
    const transient = res.status === 429 || res.status === 529 || res.status >= 500;
    if (transient && attempt < 4) { await sleep(1000 * 2 ** (attempt - 1)); continue; }
    throw new Error(`Batches API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
}

/**
 * Submit one batch.
 * @param {Array<{customId:string, system?:string, prompt:string, model?:string, maxTokens?:number}>} items
 * @returns {Promise<string>} batch id
 */
export async function submitBatch(items, { creds = {} } = {}) {
  const { key } = credentials(creds);
  if (!key) throw new Error('No Anthropic API key available for batch generation.');

  const requests = items.map((it) => ({
    custom_id: it.customId,
    params: {
      model: resolveModel(String(creds.model || '').trim() || it.model),
      max_tokens: it.maxTokens ?? 10000,
      // The style guide is identical across every request in the batch, so
      // caching it makes each additional request read it at a fraction of the
      // price instead of paying full input rate N times.
      system: it.system
        ? [{ type: 'text', text: it.system, cache_control: { type: 'ephemeral' } }]
        : undefined,
      // `content` (an array of blocks) carries images; `prompt` is text only.
      messages: [{ role: 'user', content: it.content || it.prompt }],
    },
  }));

  const res = await call(API, { key, method: 'POST', body: JSON.stringify({ requests }) });
  const data = await res.json();
  return data.id;
}

/** Poll until the batch finishes. Resolves to the raw batch record. */
export async function awaitBatch(batchId, { creds = {}, pollMs = 15000, timeoutMs = 60 * 60 * 1000, onTick } = {}) {
  const { key } = credentials(creds);
  const started = Date.now();
  for (;;) {
    const res = await call(`${API}/${batchId}`, { key });
    const data = await res.json();
    if (data.processing_status === 'ended') return data;
    if (Date.now() - started > timeoutMs) throw new Error(`Batch ${batchId} did not finish within the timeout.`);
    onTick?.(data.request_counts || {});
    await sleep(pollMs);
  }
}

/**
 * Fetch a finished batch's results.
 * @returns {Promise<Map<string, {text?:string, error?:string}>>} keyed by custom_id
 *
 * Results come back in arbitrary order, so they are keyed by custom_id and
 * never by position.
 */
export async function batchResults(batch, { creds = {} } = {}) {
  const { key } = credentials(creds);
  const url = batch.results_url || `${API}/${batch.id}/results`;
  const res = await call(url, { key });
  const body = await res.text();

  const out = new Map();
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const result = parsed.result || {};
    if (result.type !== 'succeeded') {
      out.set(parsed.custom_id, { error: result.type || 'unknown', detail: result.error?.message });
      continue;
    }
    const text = (result.message?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    out.set(parsed.custom_id, { text, usage: result.message?.usage || null });
  }
  return out;
}

/** Submit, wait, and return results keyed by custom_id. */
export async function runBatch(items, { creds = {}, pollMs, timeoutMs, onTick } = {}) {
  if (!items.length) return new Map();
  const id = await submitBatch(items, { creds });
  onTick?.({ submitted: items.length, batchId: id });
  const batch = await awaitBatch(id, { creds, pollMs, timeoutMs, onTick });
  return batchResults(batch, { creds });
}
