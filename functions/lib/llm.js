// Multi-provider LLM client. Question generation, verification, image/PDF
// extraction and the AI assistant's chat all run through here, billed to the
// institution's own key (any supported provider) or the platform Anthropic key
// as a fallback. Uses Node's built-in fetch.
//
// Providers: Anthropic (native Messages API) plus any OpenAI-compatible Chat
// Completions API - OpenAI, Google Gemini (via its OpenAI-compat endpoint), xAI
// (Grok), and DeepSeek. Text works on all of them, and images on all but
// DeepSeek; PDFs are native on Anthropic and best-effort (base64 `file` part)
// on the OpenAI-compatible ones. A chat reply streams (streamChat); everything
// else is one completion (complete).

import { config } from './config.js';

// Anthropic friendly aliases -> current model ids. A raw `claude-…` id passes
// through. Non-Anthropic providers ignore these and use their own model id.
const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

export function resolveModel(alias) {
  if (MODELS[alias]) return MODELS[alias];
  if (String(alias || '').startsWith('claude-')) return alias;
  return MODELS.sonnet;
}

export const DEFAULT_PROVIDER = 'anthropic';

// Provider catalog. `baseUrl` + `openaiCompatible` drive the shared Chat
// Completions adapter; Anthropic uses its own native adapter. `defaultModel` is
// used when the institution hasn't entered a model of its own.
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyPlaceholder: 'sk-ant-…',
    console: 'console.anthropic.com',
    defaultModel: '', // per-tier aliases (sonnet/opus/haiku) are used instead
  },
  openai: {
    label: 'OpenAI (GPT)',
    keyPlaceholder: 'sk-…',
    console: 'platform.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    tokenParam: 'max_completion_tokens', // newer OpenAI models reject max_tokens
    openaiCompatible: true,
  },
  gemini: {
    label: 'Google Gemini',
    keyPlaceholder: 'AIza…',
    console: 'aistudio.google.com',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    openaiCompatible: true,
  },
  xai: {
    label: 'xAI (Grok)',
    keyPlaceholder: 'xai-…',
    console: 'console.x.ai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    openaiCompatible: true,
  },
  deepseek: {
    label: 'DeepSeek',
    keyPlaceholder: 'sk-…',
    console: 'platform.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    openaiCompatible: true,
    vision: false, // its chat models read text only
  },
};

// Safe, non-secret provider list for the admin UI.
export function providerCatalog() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    placeholder: p.keyPlaceholder,
    console: p.console,
    defaultModel: p.defaultModel || '',
  }));
}

// An AI error carries a statusCode for the API's error handler, and a `kind`
// for callers that put it in their own words: 'no_key', 'bad_key' (the
// provider refused the key), or 'service' (unreachable, overloaded, refused).
const apiError = (message, statusCode, kind = 'service') => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.kind = kind;
  return err;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST with backoff on transient (429 / 529 / 5xx / network) failures so
// parallel extraction calls don't silently drop questions when throttled.
// Resolves to the successful response; `signal` gives up at once.
async function postWithRetry(url, { headers, body, signal }) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= MAX_ATTEMPTS) throw apiError(`Could not reach the AI service: ${err.message}`, 502);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) return res;

    const transient = res.status === 429 || res.status === 529 || res.status >= 500;
    if (transient && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1));
      continue;
    }

    const errBody = await res.text().catch(() => '');
    // 401/403 are almost always a bad/absent key - surface as a 400 to the admin.
    const badKey = res.status === 401 || res.status === 403;
    throw apiError(
      badKey ? 'The AI service rejected the API key - check the key in Settings.' : `The AI service answered ${res.status}: ${errBody.slice(0, 200)}`,
      badKey ? 400 : 502,
      badKey ? 'bad_key' : 'service',
    );
  }
}

const postJson = async (url, options) => (await postWithRetry(url, options)).json();

/**
 * The events of a server-sent event stream (a fetch response body), as
 * { event, data } once each is complete. Both providers' streams are SSE. A
 * stream that stops without its last blank line still gives its last event.
 */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];
  // One line: a field of the event being read, or the blank line ending it.
  function* line(text) {
    if (!text) {
      if (data.length) yield { event, data: data.join('\n') };
      event = 'message';
      data = [];
    } else if (!text.startsWith(':')) {
      const colon = text.indexOf(':');
      const field = colon < 0 ? text : text.slice(0, colon);
      const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      yield* line(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield* line(buffer.replace(/\r$/, ''));
  yield* line('');
}

/** The provider and key a call runs on: the institution's, else the platform's (Anthropic). */
function resolveKey(creds = {}) {
  let provider = creds.provider || DEFAULT_PROVIDER;
  let key = String(creds.apiKey || '').trim();
  // No institution key -> fall back to the platform key, which is Anthropic's.
  if (!key) {
    key = config.platformApiKey;
    provider = DEFAULT_PROVIDER;
  }
  if (!key) {
    throw apiError('No LLM API key configured. Add one in Settings to generate or upload questions.', 400, 'no_key');
  }
  return { provider, key, p: PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER] };
}

// --- Anthropic (native Messages API) ---------------------------------------
async function completeAnthropic({ key, model, system, prompt, maxTokens, image, effort }) {
  const userContent = image
    ? [
        image.media === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image.data } }
          : { type: 'image', source: { type: 'base64', media_type: image.media, data: image.data } },
        { type: 'text', text: prompt },
      ]
    : prompt;

  const data = await postJson('https://api.anthropic.com/v1/messages', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Effort trades thinking depth for cost/latency on Claude 4.7+ models
      // (low/medium/high; default high when omitted). Extraction runs at
      // medium; generation and verification keep the high default.
      ...(effort ? { output_config: { effort } } : {}),
      system: system || 'You are a precise, careful assistant.',
      messages: [{ role: 'user', content: userContent }],
    }),
    label: 'Anthropic',
  });
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// --- OpenAI-compatible Chat Completions (OpenAI / Gemini / xAI / DeepSeek) ---
function openaiUserContent(prompt, image) {
  if (!image) return prompt;
  const dataUrl = `data:${image.media};base64,${image.data}`;
  if (image.media === 'application/pdf') {
    // OpenAI accepts a base64 PDF as a `file` part; other compatible providers
    // vary. Non-PDF images use the universal `image_url` part.
    return [
      { type: 'file', file: { filename: 'upload.pdf', file_data: dataUrl } },
      { type: 'text', text: prompt },
    ];
  }
  return [
    { type: 'image_url', image_url: { url: dataUrl } },
    { type: 'text', text: prompt },
  ];
}

async function completeOpenAICompatible(p, { key, model, system, prompt, maxTokens, image }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: openaiUserContent(prompt, image) });

  const payload = { model, messages };
  payload[p.tokenParam || 'max_tokens'] = maxTokens;

  const data = await postJson(`${p.baseUrl}/chat/completions`, {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    label: p.label,
  });
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
  return '';
}

/**
 * One-shot completion. Returns the concatenated text content.
 * @param {object} o
 * @param {{provider?:string, apiKey?:string, model?:string}} [o.creds]  institution credentials
 * @param {string} [o.model]    per-call tier hint (Anthropic alias); an institution model override wins
 * @param {string} [o.system]   system prompt
 * @param {string} o.prompt     user text
 * @param {number} [o.maxTokens]
 * @param {{media:string,data:string}} [o.image]  base64 image/PDF for vision
 * @param {'low'|'medium'|'high'} [o.effort]  thinking-depth/cost dial (Anthropic only; default high)
 */
export async function complete({ creds = {}, model, system, prompt, maxTokens = 4000, image = null, effort = null }) {
  const { key, p } = resolveKey(creds);
  if (p.openaiCompatible) {
    const effModel = String(creds.model || '').trim() || p.defaultModel;
    return completeOpenAICompatible(p, { key, model: effModel, system, prompt, maxTokens, image });
  }
  // Anthropic: an institution model override (raw id or alias) wins over the
  // per-tier alias; both go through the alias resolver.
  const effModel = resolveModel(String(creds.model || '').trim() || model);
  return completeAnthropic({ key, model: effModel, system, prompt, maxTokens, image, effort });
}

// --- Streaming chat ------------------------------------------------------------
// A conversation is [{ role: 'user' | 'assistant', content, images? }], images
// ([{ media, data }], base64) going with the message they belong to.

const anthropicMessage = ({ role, content, images = [] }) => ({
  role,
  content: images.length
    ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } })), { type: 'text', text: content }]
    : content,
});

async function streamAnthropic({ key, model, system, messages, maxTokens, signal, onStart, onText }) {
  const res = await postWithRetry('https://api.anthropic.com/v1/messages', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: messages.map(anthropicMessage), stream: true }),
    signal,
  });
  onStart?.();
  let text = '';
  let stop = null;
  for await (const { data } of sseEvents(res.body)) {
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    // Text arrives as text deltas; thinking, if the model does any, is not shown.
    if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
      text += msg.delta.text;
      onText?.(msg.delta.text);
    } else if (msg.type === 'message_delta') {
      stop = msg.delta?.stop_reason ?? stop;
    } else if (msg.type === 'error') {
      throw apiError(`The AI service stopped answering: ${msg.error?.message || 'error'}`, 502);
    } else if (msg.type === 'message_stop') {
      break;
    }
  }
  return { text, truncated: stop === 'max_tokens' };
}

const openaiMessage = ({ role, content, images = [] }) => ({
  role,
  content: images.length
    ? [...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.media};base64,${i.data}` } })), { type: 'text', text: content }]
    : content,
});

async function streamOpenAICompatible(p, { key, model, system, messages, maxTokens, signal, onStart, onText }) {
  const payload = {
    model,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(openaiMessage)],
  };
  payload[p.tokenParam || 'max_tokens'] = maxTokens;
  const res = await postWithRetry(`${p.baseUrl}/chat/completions`, {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  onStart?.();
  let text = '';
  let stop = null;
  for await (const { data } of sseEvents(res.body)) {
    if (data === '[DONE]') break;
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    if (msg.error) throw apiError(`The AI service stopped answering: ${msg.error.message || 'error'}`, 502);
    const choice = msg.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece) {
      text += piece;
      onText?.(piece);
    }
    if (choice?.finish_reason) stop = choice.finish_reason;
  }
  return { text, truncated: stop === 'length' };
}

/**
 * The next reply in a conversation, streamed. `onStart` is called once the
 * provider has accepted the request (a refusal before that throws), `onText`
 * with each piece of the reply as it arrives. Resolves to the whole reply,
 * { text, truncated } (truncated: it ran out of tokens).
 * @param {object} o
 * @param {{provider?:string, apiKey?:string, model?:string}} [o.creds]  institution credentials
 * @param {string} [o.model]   per-call tier hint (Anthropic alias); an institution model override wins
 * @param {string} [o.system]  system prompt
 * @param {Array<{role:'user'|'assistant', content:string, images?:Array<{media:string, data:string}>}>} o.messages
 * @param {number} [o.maxTokens]
 * @param {AbortSignal} [o.signal]  stops the request, and the bill, when the asker goes away
 * @param {() => void} [o.onStart]
 * @param {(text: string) => void} [o.onText]
 */
export async function streamChat({ creds = {}, model, system, messages, maxTokens = 2000, signal, onStart, onText }) {
  const { key, p } = resolveKey(creds);
  // A provider that reads no images gets the words alone.
  const sent = p.vision === false ? messages.map(({ images, ...m }) => m) : messages;
  if (p.openaiCompatible) {
    const effModel = String(creds.model || '').trim() || p.defaultModel;
    return streamOpenAICompatible(p, { key, model: effModel, system, messages: sent, maxTokens, signal, onStart, onText });
  }
  const effModel = resolveModel(String(creds.model || '').trim() || model);
  return streamAnthropic({ key, model: effModel, system, messages: sent, maxTokens, signal, onStart, onText });
}

/**
 * Extract the first JSON object/array from a model response, tolerating ```fences
 * and stray LaTeX backslashes (\frac, \sqrt, …) that break strict JSON.parse.
 */
export function parseJson(text) {
  let t = String(text || '').trim();

  if (t.includes('```')) {
    for (let part of t.split('```')) {
      part = part.replace(/^json/i, '').trim();
      if (part.startsWith('{') || part.startsWith('[')) { t = part; break; }
    }
  }

  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  let endChar = '}';
  if (firstArr !== -1 && (firstArr < firstObj || firstObj === -1)) { start = firstArr; endChar = ']'; }
  else if (firstObj !== -1) { start = firstObj; endChar = '}'; }
  if (start !== -1) {
    const last = t.lastIndexOf(endChar);
    if (last > start) t = t.slice(start, last + 1);
  }

  try {
    return JSON.parse(t);
  } catch {
    const fixed = t.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    return JSON.parse(fixed);
  }
}
