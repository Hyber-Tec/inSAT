// Tiny fetch client for the insat API. Stores the JWT in localStorage
// and attaches it as a Bearer token. Throws an Error (with .status/.code) on
// non-2xx responses so callers can show the server's message.

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const TOKEN_KEY = 'satify_token';

let token = null;
try {
  token = window.localStorage?.getItem(TOKEN_KEY) || null;
} catch {
  token = null;
}

export function setToken(t) {
  token = t || null;
  try {
    if (t) window.localStorage?.setItem(TOKEN_KEY, t);
    else window.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* ignore storage failures */
  }
}

export const getToken = () => token;

/** Absolute URL for a question figure asset (or null). */
export const assetUrl = (id) => (id ? `${BASE}/api/assets/${id}` : null);

async function request(method, path, body, isForm) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (isForm) {
    payload = body; // FormData - let the browser set the boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
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
