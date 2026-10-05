// Checks that every math span in the transcribed records renders in KaTeX,
// the same renderer the exam UI uses (client/src/MathText.jsx), and that no
// LaTeX leaks outside a delimiter, where the UI would print it raw.
//
// Usage: node katex_check.mjs <record.json | dir> ...   -> one JSON line per problem

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const katex = require('katex');

const DELIM = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$)/g;

function* strings(value, where) {
  if (typeof value === 'string') yield [where, value];
  else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) yield* strings(value[i], `${where}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['bbox', 'image', 'kind', 'check', 'flags', 'uid', 'out'].includes(k)) continue;
      yield* strings(v, where ? `${where}.${k}` : k);
    }
  }
}

function problems(text, where = '') {
  const out = [];
  DELIM.lastIndex = 0;
  let last = 0;
  let m;
  const outside = [];
  while ((m = DELIM.exec(text))) {
    outside.push(text.slice(last, m.index));
    const tok = m[0];
    const display = !tok.startsWith('\\(');
    const tex = tok.startsWith('$$') ? tok.slice(2, -2) : tok.slice(2, -2);
    try {
      katex.renderToString(tex, { throwOnError: true, displayMode: display, strict: 'ignore' });
    } catch (err) {
      out.push({ kind: 'katex', tex, error: String(err.message).replace(/^KaTeX parse error: /, '').slice(0, 160) });
    }
    last = m.index + tok.length;
  }
  outside.push(text.slice(last));
  const rest = outside.join(' ');
  if (/\\\(|\\\)|\\\[|\\\]/.test(rest)) out.push({ kind: 'unbalanced-delimiter' });
  const bare = rest.match(/\\[a-zA-Z]+|[A-Za-z0-9)]\^|[A-Za-z]_[{A-Za-z0-9]/g);
  // Figure descriptions are alt text, where plain "x^2" is fine.
  if (bare && !where.endsWith('description')) out.push({ kind: 'latex-outside-math', sample: bare.slice(0, 5) });
  return out;
}

function files(args) {
  const list = [];
  for (const a of args) {
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(a)) if (f.endsWith('.json')) list.push(path.join(a, f));
    } else list.push(a);
  }
  return list;
}

let bad = 0;
for (const file of files(process.argv.slice(2))) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(JSON.stringify({ file, kind: 'invalid-json', error: err.message }));
    bad += 1;
    continue;
  }
  for (const [where, text] of strings(rec, '')) {
    for (const p of problems(text, where)) {
      console.log(JSON.stringify({ uid: rec.uid, file, where, ...p }));
      bad += 1;
    }
  }
}
process.exitCode = bad ? 1 : 0;
