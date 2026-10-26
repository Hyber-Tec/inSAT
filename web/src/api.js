// Tiny fetch client for the insat API. Attaches the signed-in user's Firebase
// ID token as a Bearer token (Firebase refreshes it). Throws an Error (with
// .status/.code) on non-2xx responses so callers can show the server's message.
//
// The API is served on the app's own origin (Firebase Hosting rewrites /api/**
// to the function; Vite proxies it in development). Hosting gives a request 60
// seconds, which AI can outrun while it reads an upload or writes questions,
// and holds a streamed answer back until it ends, so those requests (and the
// AI assistant's answers) go straight to the function (VITE_API_DIRECT_URL).

import { auth } from './firebase.js';
import { viewHeaders } from './view.js';

const BASE = import.meta.env.VITE_API_URL || '';
const DIRECT = import.meta.env.VITE_API_DIRECT_URL || BASE;
const LONG = /^\/api\/(admin\/(exams\/(from-upload|from-ai|[^/]+\/questions\/(generate|upload))|bank\/(generate|ingest))|assistant\/chat)$/;
const urlFor = (path) => `${LONG.test(path) ? DIRECT : BASE}${path}`;

/** The Authorization header for the signed-in user (none when signed out), and a platform owner's student view. */
export async function authHeaders() {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}`, ...viewHeaders() } : {};
}

/** Absolute URL for a question figure asset (or null). */
export const assetUrl = (id) => (id ? `${BASE}/api/assets/${id}` : null);

/** Whether a question's figure shows its choices (four graphs or tables, labeled A to D): it then follows the question, as choices do. */
export const figureIsChoices = (q) => (q?.figure?.figures || []).some((f) => f.choice);

/** A response's JSON, or what went wrong in words when it is not the API's. */
async function readJson(res, path) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // Not the API's JSON: a proxy or an old server answering with an HTML
    // error page. Say what happened rather than dumping the markup.
    return { message: /^\s*</.test(text) ? `${res.status} ${res.statusText || 'error'} from ${path}` : text };
  }
}

function failed(res, data) {
  const err = new Error(data.message || res.statusText || 'Request failed');
  err.status = res.status;
  err.code = data.error;
  return err;
}

async function request(method, path, body, isForm) {
  const headers = await authHeaders();
  let payload;
  if (isForm) {
    payload = body; // FormData - let the browser set the boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(urlFor(path), { method, headers, body: payload });
  const data = await readJson(res, path);
  if (!res.ok) throw failed(res, data);
  return data;
}

/**
 * POST `body` and read the answer as it comes: a stream of JSON lines, each
 * handed to `onEvent`. Resolves when the stream ends; a refusal before it
 * starts throws as any request does. `signal` stops it.
 */
async function stream(path, body, { signal, onEvent }) {
  const headers = { ...(await authHeaders()), 'content-type': 'application/json' };
  const res = await fetch(urlFor(path), { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw failed(res, await readJson(res, path));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

export const api = {
  base: BASE,
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, formData) => request('POST', p, formData, true),
  stream,
};
