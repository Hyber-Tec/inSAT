// Multi-provider LLM client. Question generation, verification, and image/PDF
// extraction all run through here, billed to the institution's own key (any
// supported provider) or the platform Anthropic key as a fallback. Uses Node's
// built-in fetch.
//
// Providers: Anthropic (native Messages API) plus any OpenAI-compatible Chat
// Completions API - OpenAI, Google Gemini (via its OpenAI-compat endpoint), xAI
// (Grok), and DeepSeek. Text and images work on all of them; PDFs are native on
// Anthropic and best-effort (base64 `file` part) on the OpenAI-compatible ones.

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

const apiError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST JSON with backoff on transient (429 / 529 / 5xx / network) failures so
// parallel extraction calls don't silently drop questions when throttled.
async function postJson(url, { headers, body, label }) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw apiError(`Could not reach ${label}: ${err.message}`, 502);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) return res.json();

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
      badKey ? `${label} rejected the API key - check the key in Settings.` : `${label} ${res.status}: ${errBody.slice(0, 200)}`,
      badKey ? 400 : 502,
    );
  }
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
  let provider = creds.provider || DEFAULT_PROVIDER;
  let key = String(creds.apiKey || '').trim();
  // No institution key -> fall back to the platform key, which is Anthropic's.
  if (!key) {
    key = config.platformApiKey;
    provider = DEFAULT_PROVIDER;
  }
  if (!key) {
    throw apiError('No LLM API key configured. Add one in Settings to generate or upload questions.', 400);
  }

  const p = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  if (p.openaiCompatible) {
    const effModel = String(creds.model || '').trim() || p.defaultModel;
    return completeOpenAICompatible(p, { key, model: effModel, system, prompt, maxTokens, image });
  }
  // Anthropic: an institution model override (raw id or alias) wins over the
  // per-tier alias; both go through the alias resolver.
  const effModel = resolveModel(String(creds.model || '').trim() || model);
  return completeAnthropic({ key, model: effModel, system, prompt, maxTokens, image, effort });
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
