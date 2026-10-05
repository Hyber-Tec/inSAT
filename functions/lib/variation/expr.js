// Math expressions as the question bank writes them, parsed into one tree.
//
// The bank mixes three notations, often within one question: LaTeX inside
// \( \) ("\frac{x}{3} = 7"), ClassMarker's fractions ("^{1}/_{34}", "x^{2}",
// "R₁", "−"), and plain text ("3x + 5 = 20", "(x + 3)(x − 13) = 0"). All three
// parse into the same tree, and the tree prints back as SAT-style LaTeX.
//
// The parser is deliberately strict. Anything it cannot read unambiguously
// ("1/2x", "√7fg", "(10x)2", a \text{} unit) is a ParseError, and a question
// that holds such a span is left out of variation rather than guessed at.
//
// Nodes:
//   num   { v: rational, places, commas }  an unsigned literal and how it was written
//   sym   { name }                         a variable or constant: x, a, R_1
//   pi    {}                               the constant pi
//   add   { items: [{ neg, e }] }          a sum as written, each term with its sign
//   mul   { items: [e], explicit }         a product; explicit when written with a sign
//   div   { num, den, style }              'frac' (stacked) or 'slash' (a/b)
//   pow   { base, exp }
//   neg   { e }                            unary minus
//   group { e }                            parentheses as written
//   abs   { e }
//   sqrt  { e, index }
//   call  { f, arg }                       function application f(x)
//   pct   { e }                            e%
//   tuple { items }                        an ordered pair (x, y)
//   rel   { op, l, r }                     = < > <= >= !=
//   chain { ops, items }                   a < x < b

import * as R from './rational.js';

export class ParseError extends Error {}

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
const RELOPS = new Set(['=', '<', '>', '<=', '>=', '!=']);

/** Unicode and LaTeX spellings reduced to one vocabulary before tokenizing. */
export function preclean(src) {
  return String(src)
    // Mathematical italic letters (𝑛, 𝑥) are ordinary letters.
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => ch.normalize('NFKC'))
    .replace(/[−–‒﹣－]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/ƒ/g, 'f')
    .replace(/×/g, '\\times ')
    .replace(/[·⋅]/g, '\\cdot ')
    .replace(/÷/g, '\\div ')
    .replace(/≤|⩽/g, '\\le ')
    .replace(/≥|⩾/g, '\\ge ')
    .replace(/≠/g, '\\ne ')
    .replace(/π/g, '\\pi ')
    .replace(/√/g, '\\surd ')
    .replace(/∣/g, '|')
    .replace(/\{,\}/g, ',')
    .replace(/\\[dt]frac/g, '\\frac')
    .replace(/\\left\s*\./g, '')
    .replace(/\\right\s*\./g, '')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*(?=[()[\]|]|\\[{}|])/g, '')
    .replace(/\\[{}]/g, (m) => (m === '\\{' ? '(' : ')'))
    .replace(/\\\|/g, '|')
    .replace(/\\[,;:!> ]/g, ' ')
    .replace(/~/g, ' ');
}

const COMMANDS = {
  '\\frac': { t: 'frac' },
  '\\sqrt': { t: 'sqrt' },
  '\\surd': { t: 'surd' },
  '\\cdot': { t: 'op', v: '*', explicit: 'cdot' },
  '\\times': { t: 'op', v: '*', explicit: 'times' },
  '\\div': { t: 'op', v: '/' },
  '\\le': { t: 'rel', v: '<=' },
  '\\leq': { t: 'rel', v: '<=' },
  '\\leqslant': { t: 'rel', v: '<=' },
  '\\ge': { t: 'rel', v: '>=' },
  '\\geq': { t: 'rel', v: '>=' },
  '\\geqslant': { t: 'rel', v: '>=' },
  '\\ne': { t: 'rel', v: '!=' },
  '\\neq': { t: 'rel', v: '!=' },
  '\\lt': { t: 'rel', v: '<' },
  '\\gt': { t: 'rel', v: '>' },
  '\\pi': { t: 'pi' },
  '\\%': { t: 'pct' },
};

/** Index just past the brace group that opens at s[i] === '{'. */
function closeBrace(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') { depth -= 1; if (!depth) return j + 1; }
  }
  throw new ParseError('unbalanced braces');
}

export function tokenize(src) {
  const s = preclean(src);
  const out = [];
  let i = 0;
  let spaced = false;
  const push = (tok) => { out.push({ ...tok, spaced }); spaced = false; };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; spaced = true; continue; }
    // ClassMarker's fraction: ^{numerator}/_{denominator}, with no base before the ^.
    if (c === '^' && s[i + 1] === '{') {
      const prev = out[out.length - 1];
      const baseless = !prev || prev.t === 'op' || prev.t === 'rel' || prev.t === 'lp' || prev.t === 'comma' || spaced;
      const numEnd = closeBrace(s, i + 1);
      const rest = s.slice(numEnd).match(/^\s*\/\s*_\s*\{/);
      if (baseless && rest) {
        const denStart = numEnd + rest[0].length - 1;
        const denEnd = closeBrace(s, denStart);
        push({ t: 'cmfrac', num: s.slice(i + 2, numEnd - 1), den: s.slice(denStart + 1, denEnd - 1) });
        i = denEnd;
        continue;
      }
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1] || ''))) {
      const m = s.slice(i).match(/^(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)?(?:\.\d+)?/);
      const text = m[0];
      if (!text || text === '.') throw new ParseError(`bad number at ${i}`);
      const places = text.includes('.') ? text.split('.')[1].length : 0;
      push({ t: 'num', v: R.fromDecimal(text), places, commas: text.includes(',') });
      i += text.length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let name = c;
      let j = i + 1;
      // Subscripts: R₁, x_1, x_{12}, x_n.
      const isSub = (ch) => Boolean(ch) && SUB_DIGITS.includes(ch);
      if (isSub(s[j])) {
        let sub = '';
        while (isSub(s[j])) { sub += String(SUB_DIGITS.indexOf(s[j])); j += 1; }
        name += `_${sub}`;
      } else if (s[j] === '_') {
        const m = s.slice(j).match(/^_(?:\{([A-Za-z0-9]{1,3})\}|([A-Za-z0-9]))/);
        if (!m) throw new ParseError('bad subscript');
        name += `_${m[1] || m[2]}`;
        j += m[0].length;
      }
      push({ t: 'sym', name });
      i = j;
      continue;
    }
    if (c === '\\') {
      const m = s.slice(i).match(/^\\(?:[A-Za-z]+|%)/);
      if (!m) throw new ParseError(`stray backslash at ${i}`);
      const cmd = COMMANDS[m[0]];
      if (!cmd) throw new ParseError(`unsupported command ${m[0]}`);
      push(cmd);
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=') { push({ t: 'rel', v: two }); i += 2; continue; }
    if (c === '=' || c === '<' || c === '>') { push({ t: 'rel', v: c }); i += 1; continue; }
    if (c === '+' || c === '-' || c === '/') { push({ t: 'op', v: c }); i += 1; continue; }
    if (c === '*') { push({ t: 'op', v: '*', explicit: 'star' }); i += 1; continue; }
    if (c === '^') { push({ t: 'caret' }); i += 1; continue; }
    if (c === '²' || c === '³') { push({ t: 'sup', v: c === '²' ? 2 : 3 }); i += 1; continue; }
    if (c === '(' || c === '[') { push({ t: 'lp', v: c }); i += 1; continue; }
    if (c === ')' || c === ']') { push({ t: 'rp', v: c }); i += 1; continue; }
    if (c === '{') { push({ t: 'lb' }); i += 1; continue; }
    if (c === '}') { push({ t: 'rb' }); i += 1; continue; }
    if (c === '|') { push({ t: 'bar' }); i += 1; continue; }
    if (c === ',') { push({ t: 'comma' }); i += 1; continue; }
    if (c === '%') { push({ t: 'pct' }); i += 1; continue; }
    throw new ParseError(`unexpected "${c}"`);
  }
  return out;
}

/**
 * Parse one math span into a tree.
 * `functions` names the letters that are functions here (f in "f(x) = ..."),
 * so "f(2)" is a call while "a(b + c)" is a product.
 */
export function parse(src, { functions = new Set() } = {}) {
  const toks = tokenize(src);
  let pos = 0;
  let depth = 0;
  let absDepth = 0;
  const peek = (k = 0) => toks[pos + k];
  const next = () => toks[pos++];
  const expect = (t, v) => {
    const tok = next();
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) throw new ParseError(`expected ${v || t}`);
    return tok;
  };
  const enter = () => { if (++depth > 40) throw new ParseError('nesting too deep'); };

  function group() {
    expect('lb');
    const e = sum();
    expect('rb');
    return e;
  }

  function atom() {
    enter();
    const tok = next();
    if (!tok) throw new ParseError('unexpected end');
    let node;
    if (tok.t === 'num') node = { k: 'num', v: tok.v, places: tok.places, commas: tok.commas };
    else if (tok.t === 'pi') node = { k: 'pi' };
    else if (tok.t === 'sym') {
      const call = functions.has(tok.name) && peek()?.t === 'lp' && peek().v === '(' && !peek().spaced;
      if (call) {
        next();
        const arg = sum();
        expect('rp', ')');
        node = { k: 'call', f: tok.name, arg };
      } else node = { k: 'sym', name: tok.name };
    } else if (tok.t === 'lp') {
      const first = sum();
      if (peek()?.t === 'comma') {
        const items = [first];
        while (peek()?.t === 'comma') { next(); items.push(sum()); }
        expect('rp');
        node = { k: 'tuple', items };
      } else {
        expect('rp', tok.v === '(' ? ')' : ']');
        node = { k: 'group', e: first };
      }
    } else if (tok.t === 'lb') {
      // A LaTeX brace group is invisible grouping: {x + 1} prints as x + 1.
      pos -= 1;
      node = group();
      if (node.k === 'add') node = { k: 'group', e: node, invisible: true };
    } else if (tok.t === 'bar') {
      absDepth += 1;
      const e = sum();
      expect('bar');
      absDepth -= 1;
      node = { k: 'abs', e };
    } else if (tok.t === 'frac') {
      const num = group();
      const den = group();
      node = { k: 'div', num, den, style: 'frac' };
    } else if (tok.t === 'cmfrac') {
      const num = parse(tok.num, { functions });
      const den = parse(tok.den, { functions });
      if (num.k === 'rel' || den.k === 'rel') throw new ParseError('relation inside a fraction');
      node = { k: 'div', num: unwrap(num), den: unwrap(den), style: 'frac' };
    } else if (tok.t === 'sqrt') {
      let index = null;
      if (peek()?.t === 'lp' && peek().v === '[') {
        next();
        index = sum();
        expect('rp', ']');
      }
      node = { k: 'sqrt', e: group(), index };
    } else if (tok.t === 'surd') {
      // √ applies to the next atom only: √(3x + 8), √2. "√7fg" is ambiguous.
      const e = atom();
      if (startsImplicit()) throw new ParseError('ambiguous radical');
      node = { k: 'sqrt', e: e.k === 'group' ? e.e : e, index: null, surd: true };
    } else throw new ParseError(`unexpected ${tok.t}`);
    depth -= 1;
    return node;
  }

  function exponent() {
    const tok = peek();
    if (!tok) throw new ParseError('missing exponent');
    if (tok.t === 'lb') return group();
    if (tok.t === 'num') {
      next();
      // x^25 in plain text: only the first digit is the exponent in TeX, and
      // the bank never means that, so a multi-digit bare exponent is refused.
      if (tok.places || tok.v.n > 9n) throw new ParseError('ambiguous exponent');
      return { k: 'num', v: tok.v, places: 0, commas: false };
    }
    if (tok.t === 'sym') { next(); return { k: 'sym', name: tok.name }; }
    if (tok.t === 'lp') return atom();
    if (tok.t === 'op' && tok.v === '-') { next(); return { k: 'neg', e: exponent() }; }
    throw new ParseError('bad exponent');
  }

  function postfix() {
    let node = atom();
    for (;;) {
      const tok = peek();
      if (tok?.t === 'caret') {
        next();
        node = { k: 'pow', base: node, exp: exponent() };
      } else if (tok?.t === 'sup' && !tok.spaced) {
        next();
        node = { k: 'pow', base: node, exp: { k: 'num', v: R.Q(tok.v), places: 0, commas: false } };
      } else if (tok?.t === 'pct') {
        next();
        node = { k: 'pct', e: node };
      } else break;
    }
    return node;
  }

  function unary() {
    const tok = peek();
    if (tok?.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      next();
      const e = unary();
      return tok.v === '-' ? { k: 'neg', e } : e;
    }
    return postfix();
  }

  /**
   * Whether the next token begins a factor written right after the last one.
   * Inside |...| a bar closes the absolute value; outside one it opens a new
   * factor, as in 2|x - 3|.
   */
  function startsImplicit() {
    const tok = peek();
    if (!tok) return false;
    if (tok.t === 'bar') return absDepth === 0;
    return ['num', 'sym', 'pi', 'lp', 'frac', 'cmfrac', 'sqrt', 'surd', 'lb'].includes(tok.t);
  }

  function product() {
    enter();
    const items = [unary()];
    let explicit = null;
    for (;;) {
      const tok = peek();
      if (tok?.t === 'op' && tok.v === '*') {
        next();
        explicit = tok.explicit;
        items.push(unary());
      } else if (tok?.t === 'op' && tok.v === '/') {
        next();
        const den = unary();
        // "1/2x" and "a/bc" read two ways; the bank's fractions are stacked.
        if (startsImplicit()) throw new ParseError('ambiguous slash fraction');
        const num = items.length === 1 ? items.pop() : { k: 'mul', items: items.splice(0), explicit };
        items.push({ k: 'div', num, den, style: 'slash' });
      } else if (startsImplicit()) {
        const prev = items[items.length - 1];
        // "2 3" is two numbers, and "x2" or "(x)2" is not how anyone writes 2x.
        if (tok.t === 'num') throw new ParseError('number after a factor');
        const next = unary();
        // 5\frac{3}{4} or 5 ^{3}/_{4} may be the mixed number 5 3/4.
        if (prev.k === 'num' && next.k === 'div' && next.num.k === 'num' && next.den.k === 'num') throw new ParseError('ambiguous mixed number');
        items.push(next);
      } else break;
    }
    depth -= 1;
    return items.length === 1 ? items[0] : { k: 'mul', items, explicit: explicit || false };
  }

  function sum() {
    enter();
    const items = [];
    let neg = false;
    if (peek()?.t === 'op' && (peek().v === '-' || peek().v === '+')) neg = next().v === '-';
    items.push({ neg, e: product() });
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      items.push({ neg: op === '-', e: product() });
    }
    depth -= 1;
    if (items.length === 1) return items[0].neg ? { k: 'neg', e: items[0].e } : items[0].e;
    return { k: 'add', items };
  }

  function relation() {
    const first = sum();
    const ops = [];
    const items = [first];
    while (peek()?.t === 'rel') {
      ops.push(next().v);
      items.push(sum());
    }
    if (!ops.length) return first;
    if (ops.length === 1) return { k: 'rel', op: ops[0], l: items[0], r: items[1] };
    return { k: 'chain', ops, items };
  }

  const tree = relation();
  if (pos !== toks.length) throw new ParseError(`unparsed ${toks[pos].t}`);
  return tree;
}

const unwrap = (n) => (n.k === 'group' ? n.e : n);

// ---------------------------------------------------------------- printing

const PREC = { add: 1, neg: 2, mul: 3, div: 3, pow: 5 };
const RELTEX = { '=': '=', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '!=': '\\ne' };

/** A number as the SAT prints it: 1,200 keeps its comma, 22.80 its places. */
export function numTex(v, { places = null, commas = false } = {}) {
  if (!R.isInt(v) && R.decimalPlaces(v) === null) {
    const a = R.abs(v);
    return `${R.sign(v) < 0 ? '-' : ''}\\frac{${a.n}}{${a.d}}`;
  }
  let text = places !== null && places > 0 ? R.toFixed(v, Math.max(places, R.decimalPlaces(v))) : R.toDecimal(v);
  if (commas) text = text.replace(/^(-?)(\d+)/, (_, s, d) => s + d.replace(/\B(?=(\d{3})+(?!\d))/g, '{,}'));
  return text;
}

function isAtomic(n) {
  return n.k === 'num' || n.k === 'sym' || n.k === 'pi' || n.k === 'group' || n.k === 'abs' || n.k === 'call' || n.k === 'sqrt' || n.k === 'tuple';
}

function hasFrac(n) {
  for (const [node] of walk(n)) if (node.k === 'div' && node.style === 'frac') return true;
  return false;
}

function wrap(tex, node) {
  return hasFrac(node) ? `\\left(${tex}\\right)` : `(${tex})`;
}

/** SAT-style LaTeX for a tree (without the \( \) delimiters). */
export function toTex(n) {
  switch (n.k) {
    case 'num': return numTex(n.v, n);
    case 'sym': return n.name.includes('_') ? n.name.replace(/_(\w+)/, (_, s) => `_{${s}}`) : n.name;
    case 'pi': return '\\pi';
    case 'group': return n.invisible ? toTex(n.e) : wrap(toTex(n.e), n.e);
    case 'abs': return `\\left|${toTex(n.e)}\\right|`;
    case 'sqrt': return n.index ? `\\sqrt[${toTex(n.index)}]{${toTex(n.e)}}` : `\\sqrt{${toTex(n.e)}}`;
    case 'call': return `${n.f}(${toTex(n.arg)})`;
    case 'pct': return `${toTex(n.e)}\\%`;
    case 'tuple': return `(${n.items.map(toTex).join(', ')})`;
    case 'neg': {
      const inner = toTex(n.e);
      return n.e.k === 'add' || n.e.k === 'neg' ? `-${wrap(inner, n.e)}` : `-${inner}`;
    }
    case 'add':
      return n.items.map(({ neg, e }, i) => {
        let t = toTex(e);
        if (e.k === 'neg' || e.k === 'add') t = wrap(t, e);
        return i === 0 ? (neg ? `-${t}` : t) : `${neg ? '-' : '+'} ${t}`;
      }).join(' ');
    case 'mul': {
      const parts = n.items.map((e) => {
        const t = toTex(e);
        return e.k === 'add' || e.k === 'neg' ? wrap(t, e) : t;
      });
      if (n.explicit) return parts.join(n.explicit === 'times' ? ' \\times ' : ' \\cdot ');
      // Juxtaposition: 3x, 3(x + 5), (x + 3)(x - 5), xy. Two numbers side by
      // side would read as one, so a number after the first factor gets a dot.
      return parts.reduce((acc, t, i) => {
        if (!i) return t;
        const e = n.items[i];
        const needsDot = e.k === 'num' || (e.k === 'div' && e.style === 'slash') || e.k === 'pow' && e.base.k === 'num';
        return acc + (needsDot ? ` \\cdot ${t}` : t);
      }, '');
    }
    case 'div': {
      if (n.style === 'frac') return `\\frac{${toTex(n.num)}}{${toTex(n.den)}}`;
      const side = (e) => (isAtomic(e) || e.k === 'pow' ? toTex(e) : wrap(toTex(e), e));
      return `${side(n.num)}/${side(n.den)}`;
    }
    case 'pow': {
      const base = isAtomic(n.base) && !(n.base.k === 'num' && !R.isInt(n.base.v)) ? toTex(n.base) : wrap(toTex(n.base), n.base);
      const exp = toTex(n.exp);
      return `${base}^{${exp}}`;
    }
    case 'rel': return `${toTex(n.l)} ${RELTEX[n.op]} ${toTex(n.r)}`;
    case 'chain': return n.items.map((e, i) => (i ? ` ${RELTEX[n.ops[i - 1]]} ` : '') + toTex(e)).join('');
    default: throw new Error(`cannot print ${n.k}`);
  }
}

// -------------------------------------------------------------- evaluation

export class NotExact extends Error {}

/** Exact value at `env` (symbol name -> rational). Throws NotExact for surds and pi. */
export function evalQ(n, env = {}, fns = {}) {
  switch (n.k) {
    case 'num': return n.v;
    case 'sym': {
      if (!(n.name in env)) throw new NotExact(`unbound ${n.name}`);
      return env[n.name];
    }
    case 'pi': throw new NotExact('pi');
    case 'group': return evalQ(n.e, env, fns);
    case 'neg': return R.neg(evalQ(n.e, env, fns));
    case 'abs': return R.abs(evalQ(n.e, env, fns));
    case 'pct': return R.div(evalQ(n.e, env, fns), R.Q(100));
    case 'add': return n.items.reduce((acc, { neg, e }) => (neg ? R.sub : R.add)(acc, evalQ(e, env, fns)), R.ZERO);
    case 'mul': return n.items.reduce((acc, e) => R.mul(acc, evalQ(e, env, fns)), R.ONE);
    case 'div': {
      const d = evalQ(n.den, env, fns);
      if (R.isZero(d)) throw new NotExact('division by zero');
      return R.div(evalQ(n.num, env, fns), d);
    }
    case 'pow': {
      const e = evalQ(n.exp, env, fns);
      const b = evalQ(n.base, env, fns);
      if (R.isInt(e)) {
        if (R.isZero(b) && e.n < 0n) throw new NotExact('division by zero');
        return R.pow(b, Number(e.n));
      }
      if (e.d === 2n) {
        const root = R.sqrt(b);
        if (!root) throw new NotExact('irrational power');
        return R.pow(root, Number(e.n));
      }
      throw new NotExact('fractional power');
    }
    case 'sqrt': {
      if (n.index) throw new NotExact('root index');
      const r = R.sqrt(evalQ(n.e, env, fns));
      if (!r) throw new NotExact('irrational root');
      return r;
    }
    case 'call': {
      const f = fns[n.f];
      if (!f) throw new NotExact(`unknown function ${n.f}`);
      return evalQ(f.body, { ...env, [f.param]: evalQ(n.arg, env, fns) }, fns);
    }
    default: throw new NotExact(`cannot evaluate ${n.k}`);
  }
}

/** Floating-point value, for the independent numeric checks. NaN when undefined. */
export function evalF(n, env = {}, fns = {}) {
  switch (n.k) {
    case 'num': return R.toNumber(n.v);
    case 'sym': return n.name in env ? env[n.name] : NaN;
    case 'pi': return Math.PI;
    case 'group': return evalF(n.e, env, fns);
    case 'neg': return -evalF(n.e, env, fns);
    case 'abs': return Math.abs(evalF(n.e, env, fns));
    case 'pct': return evalF(n.e, env, fns) / 100;
    case 'add': return n.items.reduce((acc, { neg, e }) => acc + (neg ? -1 : 1) * evalF(e, env, fns), 0);
    case 'mul': return n.items.reduce((acc, e) => acc * evalF(e, env, fns), 1);
    case 'div': { const d = evalF(n.den, env, fns); return d === 0 ? NaN : evalF(n.num, env, fns) / d; }
    case 'pow': return evalF(n.base, env, fns) ** evalF(n.exp, env, fns);
    case 'sqrt': {
      const v = evalF(n.e, env, fns);
      const k = n.index ? evalF(n.index, env, fns) : 2;
      return v < 0 && k % 2 === 1 ? -((-v) ** (1 / k)) : v ** (1 / k);
    }
    case 'call': {
      const f = fns[n.f];
      return f ? evalF(f.body, { ...env, [f.param]: evalF(n.arg, env, fns) }, fns) : NaN;
    }
    default: return NaN;
  }
}

// ------------------------------------------------------------------ walking

/** Every node, depth first, with the path of child keys that leads to it. */
export function* walk(n, path = []) {
  yield [n, path];
  switch (n.k) {
    case 'group': case 'neg': case 'abs': case 'pct': yield* walk(n.e, [...path, 'e']); break;
    case 'sqrt': yield* walk(n.e, [...path, 'e']); if (n.index) yield* walk(n.index, [...path, 'index']); break;
    case 'call': yield* walk(n.arg, [...path, 'arg']); break;
    case 'add': for (let i = 0; i < n.items.length; i += 1) yield* walk(n.items[i].e, [...path, 'items', i, 'e']); break;
    case 'mul': case 'tuple': for (let i = 0; i < n.items.length; i += 1) yield* walk(n.items[i], [...path, 'items', i]); break;
    case 'chain': for (let i = 0; i < n.items.length; i += 1) yield* walk(n.items[i], [...path, 'items', i]); break;
    case 'div': yield* walk(n.num, [...path, 'num']); yield* walk(n.den, [...path, 'den']); break;
    case 'pow': yield* walk(n.base, [...path, 'base']); yield* walk(n.exp, [...path, 'exp']); break;
    case 'rel': yield* walk(n.l, [...path, 'l']); yield* walk(n.r, [...path, 'r']); break;
    default: break;
  }
}

export const clone = (n) => structuredClone(n);

export function getAt(n, path) {
  return path.reduce((node, key) => node[key], n);
}

/** A copy of `n` with the node at `path` replaced by `fn(old)`. */
export function replaceAt(n, path, fn) {
  if (!path.length) return fn(n);
  const out = Array.isArray(n) ? [...n] : { ...n };
  out[path[0]] = replaceAt(n[path[0]], path.slice(1), fn);
  return out;
}

/** Symbols used in a tree (function names excluded). */
export function symbols(n) {
  const out = new Set();
  for (const [node] of walk(n)) if (node.k === 'sym') out.add(node.name);
  return out;
}

/** Structural equality, ignoring how numbers were formatted. */
export function same(a, b) {
  const strip = (n) => JSON.stringify(n, (k, v) => (k === 'places' || k === 'commas' || k === 'invisible' || k === 'surd' ? undefined
    : v && typeof v === 'object' && typeof v.n === 'bigint' ? `${v.n}/${v.d}` : v));
  return strip(a) === strip(b);
}

/** Replace every call f(arg) with f's body, parameter bound to arg. */
export function inlineCalls(n, fns) {
  if (n.k === 'call' && fns[n.f]) {
    const f = fns[n.f];
    const arg = inlineCalls(n.arg, fns);
    return { k: 'group', e: substitute(f.body, { [f.param]: arg }) };
  }
  const out = { ...n };
  for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = inlineCalls(n[key], fns);
  if (n.items) out.items = n.items.map((it) => (it.e && n.k === 'add' ? { ...it, e: inlineCalls(it.e, fns) } : inlineCalls(it, fns)));
  return out;
}

/** Replace symbols by trees. */
export function substitute(n, map) {
  if (n.k === 'sym' && map[n.name]) return map[n.name].k === 'num' || map[n.name].k === 'sym' ? map[n.name] : { k: 'group', e: map[n.name] };
  const out = { ...n };
  for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = substitute(n[key], map);
  if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: substitute(it.e, map) } : substitute(it, map)));
  return out;
}
