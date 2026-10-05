// Tiny fetch client for the insat API. Attaches the signed-in user's Firebase
// ID token as a Bearer token (Firebase refreshes it). Throws an Error (with
// .status/.code) on non-2xx responses so callers can show the server's message.
//
// The API is served on the app's own origin (Firebase Hosting rewrites /api/**
// to the function; Vite proxies it in development). Hosting gives a request 60
// seconds, which AI can outrun while it reads an upload or writes questions,
// so those go straight to the function (VITE_API_DIRECT_URL).

import { auth } from './firebase.js';

const BASE = import.meta.env.VITE_API_URL || '';
const DIRECT = import.meta.env.VITE_API_DIRECT_URL || BASE;
const LONG = /^\/api\/admin\/(exams\/(from-upload|from-ai|[^/]+\/questions\/(generate|upload))|bank\/(generate|ingest))$/;

/** The Authorization header for the signed-in user (none when signed out). */
export async function authHeaders() {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Absolute URL for a question figure asset (or null). */
export const assetUrl = (id) => (id ? `${BASE}/api/assets/${id}` : null);

async function request(method, path, body, isForm) {
  const headers = await authHeaders();
  let payload;
  if (isForm) {
    payload = body; // FormData - let the browser set the boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${LONG.test(path) ? DIRECT : BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Not the API's JSON: a proxy or an old server answering with an HTML
    // error page. Say what happened rather than dumping the markup.
    data = { message: /^\s*</.test(text) ? `${res.status} ${res.statusText || 'error'} from ${path}` : text };
  }
  if (!res.ok) {
    const err = new Error(data.message || res.statusText || 'Request failed');
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

export const api = {
  base: BASE,
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, formData) => request('POST', p, formData, true),
};
