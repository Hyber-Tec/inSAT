// Split a question (or a choice) into prose and math.
//
// Math arrives delimited (\( \), \[ \], $$ $$) or bare in the prose, as plain
// text ("If 3x + 5 = 20, what is x?") or in ClassMarker's notation ("^{1}/_{34}").
// The result is a skeleton, the prose with each math span replaced by a
// placeholder ("If ⟦0⟧, what is the value of x?"), plus the spans. Numbers
// standing alone in the prose ("a $5 fee", "15%", "320 pages") are listed
// separately: they are a word problem's quantities, not formal math.

const DELIMITED = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;

// Hyphenated words that start with a variable ("xy-plane", "x-intercept") are
// prose, not a subtraction.
const COMPOUND = /\b(?:[a-zA-Z]{1,2}|\d+)-(?:plane|axis|axes|intercepts?|coordinates?|values?|terms?|squared|cubed|degree|inch|foot|feet|meter|meters|mile|miles|day|days|hour|hours|minute|minutes|year|years|month|months|week|weeks|person|people|page|pages|point|points|question|questions|sided|side|gon|digit|digits|by|ounce|pound|gallon|liter|centimeter|kilometer|second|seconds|percent)\b/g;

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const OPS = '+-−–=<>≤≥≠×·÷*/^|√π²³%';

/** Index past a balanced {...} starting at s[i] === '{'. */
function braceEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') { depth -= 1; if (!depth) return j + 1; }
  }
  return -1;
}

/**
 * Lexemes of undelimited prose. Kinds: word, letter (one letter, maybe with a
 * subscript), num, op, open, close, comma, cmfrac, sup ('^{..}' or '^2'),
 * space, punct.
 */
function lex(s) {
  const out = [];
  let i = 0;
  const push = (kind, text) => { out.push({ kind, text, at: i }); i += text.length; };
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (/\s/.test(c)) {
      // A line break ends a math run: two equations on two lines are two spans.
      const ws = rest.match(/^\s+/)[0];
      push(ws.includes('\n') ? 'newline' : 'space', ws);
      continue;
    }
    if (c === '^' && s[i + 1] === '{') {
      const end = braceEnd(s, i + 1);
      const tail = end > 0 ? s.slice(end).match(/^\s*\/\s*_\s*\{/) : null;
      if (tail) {
        const denEnd = braceEnd(s, end + tail[0].length - 1);
        if (denEnd > 0) { push('cmfrac', s.slice(i, denEnd)); continue; }
      }
      if (end > 0) { push('sup', s.slice(i, end)); continue; }
    }
    if (c === '^' && /[\d\-a-z(]/i.test(s[i + 1] || '')) {
      const m = rest.match(/^\^(?:-?\d+|[a-zA-Z]|\([^)]*\))/);
      if (m) { push('sup', m[0]); continue; }
    }
    const num = rest.match(/^(?:\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(?:\.\d+)?|^\.\d+/);
    if (num) { push('num', num[0]); continue; }
    const letters = rest.match(/^[A-Za-zƒ]+(?:[₀-₉]+|_\{[A-Za-z0-9]{1,3}\}|_[A-Za-z0-9])?/);
    if (letters) {
      const t = letters[0];
      const bare = t.replace(/[₀-₉]+$|_.*$/, '');
      push(bare.length === 1 || t !== bare ? 'letter' : 'word', t);
      continue;
    }
    if (c === '(' || c === '[') { push('open', c); continue; }
    if (c === ')' || c === ']') { push('close', c); continue; }
    if (c === '{' || c === '}') { push(c === '{' ? 'open' : 'close', c); continue; }
    if (c === ',') { push('comma', c); continue; }
    if (OPS.includes(c) || SUB.includes(c)) { push('op', c); continue; }
    push('punct', c);
  }
  return out;
}

const isMathLex = (l) => ['letter', 'num', 'op', 'open', 'close', 'cmfrac', 'sup'].includes(l.kind);

/**
 * Math spans in undelimited prose. A span is a maximal run of math lexemes
 * (spaces allowed between them) that contains an operator, a power, a
 * ClassMarker fraction, an implicit product ("3x") or a call ("f(2)"). A
 * lone number or a lone letter is prose. Multi-letter words end a run,
 * except a letter pair glued to math ("3xy", "mv^{2}").
 */
function bareSpans(s) {
  const lx = lex(s);
  const spans = [];
  let i = 0;
  while (i < lx.length) {
    if (!isMathLex(lx[i]) && !(lx[i].kind === 'word' && gluedWord(lx, i))) { i += 1; continue; }
    // Opening brackets may belong to prose ("(Use 1 mile = ...)"); a run starts at math.
    let j = i;
    let depth = 0;
    let last = i;
    while (j < lx.length) {
      const l = lx[j];
      if (l.kind === 'space') { j += 1; continue; }
      if (l.kind === 'comma') {
        // A comma belongs to the span only inside brackets: (x, y).
        if (depth > 0) { last = j; j += 1; continue; }
        break;
      }
      if (l.kind === 'word' && !gluedWord(lx, j)) break;
      if (!isMathLex(l) && l.kind !== 'word') break;
      if (l.kind === 'open') depth += 1;
      if (l.kind === 'close') { if (depth === 0) break; depth -= 1; }
      last = j;
      j += 1;
    }
    const from = lx[i].at;
    const to = lx[last].at + lx[last].text.length;
    spans.push({ from, to, lexemes: lx.slice(i, last + 1).filter((l) => l.kind !== 'space') });
    i = last + 1;
  }
  return spans.map((sp) => trimSpan(s, sp)).filter(Boolean);
}

// "mv" in "^{1}/_{2}mv^{2}" or "xy" in "3xy" is a product of letters, not a word.
function gluedWord(lx, i) {
  const w = lx[i];
  if (w.kind !== 'word' || w.text.length > 3) return false;
  const prev = lx[i - 1];
  const next = lx[i + 1];
  const mathBefore = prev && ['num', 'cmfrac', 'close', 'sup'].includes(prev.kind);
  const mathAfter = next && (next.kind === 'sup' || (next.kind === 'op' && '^²³'.includes(next.text)) || next.kind === 'open');
  return Boolean(mathBefore || mathAfter);
}

/** Drop brackets that do not balance inside the span, and decide whether it is math. */
function trimSpan(s, sp) {
  let lxs = sp.lexemes;
  // Unmatched brackets at the edges belong to the prose around the span.
  const balance = (list) => list.reduce((d, l) => d + (l.kind === 'open') - (l.kind === 'close'), 0);
  while (lxs.length && lxs[0].kind === 'open' && balance(lxs) > 0) lxs = lxs.slice(1);
  while (lxs.length && lxs[lxs.length - 1].kind === 'close' && balance(lxs) < 0) lxs = lxs.slice(0, -1);
  // A trailing sentence-level sign ("x -" before a word) is not math.
  if (!lxs.length) return null;
  const from = lxs[0].at;
  const to = lxs[lxs.length - 1].at + lxs[lxs.length - 1].text.length;
  const text = s.slice(from, to);
  const kinds = lxs.map((l) => l.kind);
  // A sign or bracket on its own ("-", "+") is punctuation, not math.
  if (!lxs.some((l) => ['num', 'letter', 'word', 'cmfrac'].includes(l.kind))) return null;
  const hasOp = lxs.some((l) => l.kind === 'op' && !(l.text === '%' && lxs.length === 2));
  const hasFrac = kinds.includes('cmfrac') || kinds.includes('sup');
  const implicit = lxs.some((l, k) => (l.kind === 'num' || l.kind === 'close') && ['letter', 'word', 'open'].includes(lxs[k + 1]?.kind) && !/\s/.test(s.slice(l.at + l.text.length, lxs[k + 1].at)));
  const call = lxs.some((l, k) => l.kind === 'letter' && lxs[k + 1]?.kind === 'open' && lxs[k + 1].at === l.at + l.text.length);
  const tuple = kinds[0] === 'open' && kinds.includes('comma');
  // "(Use 1 mile = 1.61 km)" style conversions are prose with an equals sign.
  if (!(hasOp || hasFrac || implicit || call || tuple)) return null;
  return { from, to, text };
}

/**
 * Segment a string.
 * Returns { skeleton, spans: [{ src, delimited, display }], numbers: [{ text, value, at }] }.
 */
export function segment(input) {
  const src = String(input ?? '');
  const spans = [];
  let skeleton = '';
  let last = 0;
  const addProse = (prose) => {
    // Protect hyphenated compounds and table rows ("x | y"), then find bare
    // math. Masking keeps every offset, so spans map back onto the prose.
    const masked = prose.replace(COMPOUND, (m) => m.replace(/-/g, '‐'))
      .replace(/^.*\s\|\s.*$/gm, (row) => '⁣'.repeat(row.length));
    let at = 0;
    for (const sp of bareSpans(masked)) {
      skeleton += prose.slice(at, sp.from);
      skeleton += `⟦${spans.length}⟧`;
      spans.push({ src: prose.slice(sp.from, sp.to), delimited: false, display: false });
      at = sp.to;
    }
    skeleton += prose.slice(at);
  };
  DELIMITED.lastIndex = 0;
  let m;
  while ((m = DELIMITED.exec(src))) {
    addProse(src.slice(last, m.index));
    const body = m[1] ?? m[2] ?? m[3];
    skeleton += `⟦${spans.length}⟧`;
    spans.push({ src: body, delimited: true, display: m[1] === undefined });
    last = m.index + m[0].length;
  }
  addProse(src.slice(last));
  // Numbers left in the prose: quantities of a word problem.
  const numbers = [];
  const re = /(\$?)(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?(%?)/g;
  let n;
  while ((n = re.exec(skeleton))) {
    // Placeholder indices are not numbers.
    if (skeleton[n.index - 1] === '⟦') continue;
    numbers.push({ text: n[0], at: n.index });
  }
  return { skeleton, spans, numbers };
}

/** The skeleton with placeholders filled back in, each span through `render(span, i)`. */
export function fill(skeleton, render) {
  return skeleton.replace(/⟦(\d+)⟧/g, (_, i) => render(Number(i)));
}
