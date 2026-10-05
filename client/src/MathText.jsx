// Renders a string that mixes prose, LaTeX math and <u> underlines. Handles
// explicit delimiters (\(..\), \[..\], $$..$$) and also math written without
// them, as the bank's sources write it: bare LaTeX (\command{..}, x^2, a_n),
// ClassMarker's fractions (^{a}/_{b} and its variants), groups holding math,
// sqrt(..) written out, and plain-text math flush against any of those. KaTeX
// renders each math span; prose stays plain text. KaTeX output is
// non-executable, so dangerouslySetInnerHTML is safe here.
// client/scripts/check-rendering.mjs holds the shapes this must keep rendering.

import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

function renderTex(tex, display) {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display, strict: false });
  } catch {
    return null;
  }
}

// ClassMarker writes a fraction as ^{numerator}/_{denominator} (sometimes with
// the fraction slash U+2044), each part plain text: "^{(w − 23y + z)}/_{(46wy)}".
// Returns the fraction as LaTeX and where it ends, or null.
function cmFraction(s, i, readGroup) {
  if (s[i] !== '^' || s[i + 1] !== '{') return null;
  const numEnd = readGroup(i + 1);
  const mid = /^\s*[/\u2044]\s*_\s*\{/.exec(s.slice(numEnd));
  if (!mid) return null;
  const denStart = numEnd + mid[0].length - 1;
  const denEnd = readGroup(denStart);
  if (denEnd > s.length || s[denEnd - 1] !== '}') return null;
  // Parentheses that only group a whole part are the fraction bar's job.
  const part = (t) => {
    let x = t.trim();
    if (/^\((.*)\)$/.test(x) && balanced(x.slice(1, -1))) x = x.slice(1, -1).trim();
    return texOf(x);
  };
  let num = part(s.slice(i + 2, numEnd - 1));
  // A negative numerator is a negative fraction, its sign set before the bar.
  const sign = /^-\s*(?=[\w.\\{}]+$)/.exec(num);
  if (sign) num = num.slice(sign[0].length);
  return { tex: `${sign ? '-' : ''}\\frac{${num}}{${part(s.slice(denStart + 1, denEnd - 1))}}`, end: denEnd };
}

// ClassMarker's fraction also comes with its slash inside a part or its
// denominator bare: ^{30/}_{230}, ^{50}_{/230}, ^{30/}230, and, with nothing
// before the numerator to raise, ^{7} /√85 or ^{(4 - x)}/2. Each is rewritten
// as ^{a}/_{b}. A bare denominator is a number or letters, a radical on one,
// or a group.
const DEN = String.raw`(√?\s*[A-Za-z0-9.]+|\([^()]*\))`;
const cmFractionForms = (t) => t
  .replace(/\^\{([^{}]*?)\s*[/\u2044]\s*\}\s*_\s*\{/g, '^{$1}/_{')
  .replace(/\^\{([^{}]*)\}\s*_\s*\{\s*[/\u2044]\s*/g, '^{$1}/_{')
  .replace(new RegExp(String.raw`\^\{([^{}]*?)\s*[/\u2044]\s*\}\s*${DEN}`, 'g'), '^{$1}/_{$2}')
  .replace(new RegExp(String.raw`(^|[\s=(+,;:\u2212-])\^\{([^{}]*)\}\s*[/\u2044]\s*${DEN}`, 'g'), '$1^{$2}/_{$3}');

// Plain text written as math, made LaTeX: the minus sign, function names
// (cos Q -> \cos Q), a radical on a number, a letter or a group (√3 ->
// \sqrt{3}), and the characters TeX reserves (% would start a comment, $
// would end the math).
const texOf = (t) => t.replace(/\u2212/g, '-')
  .replace(/(?<![\\A-Za-z])(sin|cos|tan|log|ln)(?![a-z])/g, (_, f, at, all) => `\\${f}${/[A-Za-z]/.test(all[at + f.length] || '') ? ' ' : ''}`)
  .replace(/√\s*(\([^()]*\)|[A-Za-z0-9.]+)/g, (_, r) => `\\sqrt{${r.replace(/^\((.*)\)$/, '$1')}}`)
  .replace(/(?<!\\)[%$#&]/g, '\\$&');

// Prose inside a group taken into math must read as math: numbers,
// variables, operators, Unicode super- and subscripts (x⁶). A run of three
// letters is a word.
const mathy = (t) => /^[\s\w.,+\-\u2212*/=<>\u2264\u2265\u00d7\u00f7\u00b7√()%\u00b2\u00b3\u00b9\u2070-\u209f]*$/.test(t) && !/[A-Za-z]{3,}/.test(t);

// A sign is binary after something it subtracts from ("x - ", "3 - ",
// ") - ", or math just before it), else unary ("= -", "( -", "gives -"), and
// a unary sign belongs to the math that follows it.
const OPERAND_END = /(?:^|[^A-Za-z])[A-Za-z]$|[\d)\]\u00b2\u00b3\u00b9\u2070-\u2079\u03c0]$/;
/** Where a unary minus that ends `text` starts, or -1. `afterMath`: math comes before `text`. */
function unarySign(text, afterMath = false) {
  const m = /[-\u2212]\s*$/.exec(text);
  if (!m) return -1;
  const before = text.slice(0, m.index).trimEnd();
  return OPERAND_END.test(before) || (afterMath && !before) ? -1 : m.index;
}

// A coefficient or function name written against a parenthesis: 7(, k(, 8,000(.
const COEFFICIENT = /(?:\d{1,3}(?:,\d{3})+|[A-Za-z0-9.]+)$/;
const coefficientAt = (text) => {
  const m = COEFFICIENT.exec(text);
  return m && !/[A-Za-z]{3,}/.test(m[0]) ? m.index : -1;
};

/**
 * A group in prose that holds math of its own is math, whole: (^{2}/_{7}),
 * (x^{4} - 2), (-^{5}/_{2}, 1), with the coefficient written against it and a
 * unary sign before it. Called at a closing parenthesis, `buf` holding the
 * prose since the last segment: finds the opening one in an earlier prose
 * segment, takes the group out of `segs` and returns it as LaTeX, or null.
 * (growParens later sizes the pair to a fraction inside it.)
 */
function takeGroup(segs, buf) {
  let depth = 1; // the closing parenthesis being read
  for (let k = buf.length - 1; k >= 0; k -= 1) {
    if (buf[k] === ')') depth += 1;
    else if (buf[k] === '(' && --depth === 0) return null; // opens in buf: no math inside
  }
  for (let p = segs.length - 1; p >= 0; p -= 1) {
    const seg = segs[p];
    if (seg.math) continue;
    for (let k = seg.text.length - 1; k >= 0; k -= 1) {
      if (seg.text[k] === ')') depth += 1;
      else if (seg.text[k] === '(' && --depth === 0) {
        const parts = [{ math: false, text: seg.text.slice(k + 1) }, ...segs.slice(p + 1), { math: false, text: buf }];
        if (!parts.every((x) => x.math || mathy(x.text))) return null;
        const inner = parts.map((x) => (x.math ? x.text : texOf(x.text))).join('');
        let tex = `(${inner})`;
        let head = seg.text.slice(0, k);
        // sqrt(...) written out is a radical.
        const root = /(?:^|[^A-Za-z])sqrt\s*$/.exec(head);
        if (root) {
          tex = `\\sqrt{${inner}}`;
          head = head.slice(0, head.lastIndexOf('sqrt'));
        }
        const at = coefficientAt(head);
        if (at >= 0) { tex = texOf(head.slice(at)) + tex; head = head.slice(0, at); }
        const sign = unarySign(head, segs[p - 1]?.math);
        if (sign >= 0) { tex = `-${tex}`; head = head.slice(0, sign); }
        segs.length = p;
        if (head) segs.push({ math: false, text: head });
        return tex;
      }
    }
  }
  return null;
}

// Math on both sides of a bare operator is one expression, and so is math
// right after math: 7x^{6} - 14x^{2}, 7x^{2}(x^{4} - 2).
const OPERATOR = /^\s*[-+=<>/\u2212\u00d7\u00f7\u00b7\u2264\u2265]\s*$/;
const glue = (a, b) => (/\\[A-Za-z]+$/.test(a) && /^[A-Za-z]/.test(b) ? `${a} ${b}` : a + b);

// Plain-text math written flush against a math piece continues it:
// "u^2+14u+49=(u+7)^2", "F(h)=5000(2.20)^(h/3)", "Fr^2/(Mm)". A run of
// numbers, letters, operators and balanced parentheses with no space, and no
// run of three letters (a word; two are a product, Mm).
const RUN = String.raw`[\w.()+\-\u2212*/=<>\u00d7\u00f7\u00b7\u00b2\u00b3]+`;
const RUN_BEFORE = new RegExp(String.raw`(?:^|\s)(${RUN})$`);
const RUN_AFTER = new RegExp(`^${RUN}`);
function tightRun(run, side) {
  let r = run;
  if (side === 'after') {
    // Sentence punctuation ends it; an operator at its end belongs with
    // whatever follows ("9xy^{4}\u2212 15xy^{2}").
    r = r.replace(/[.,;:!?]+$/, '');
    while (r.endsWith(')') && !balanced(r)) r = r.slice(0, -1);
    r = r.replace(/[-+\u2212*/=<>\u00d7\u00f7\u00b7]+$/, '');
  } else {
    while (r.startsWith('(') && !balanced(r)) r = r.slice(1);
  }
  return r && balanced(r) && !/[A-Za-z]{3,}|_/.test(r) ? r : '';
}

function joinMath(segs) {
  const parts = segs.map((seg) => ({ ...seg }));
  parts.forEach((seg, k) => {
    if (!seg.math || seg.display) return;
    const prev = parts[k - 1];
    const next = parts[k + 1];
    const before = prev && !prev.math ? tightRun(RUN_BEFORE.exec(prev.text)?.[1] || '', 'before') : '';
    if (before) {
      prev.text = prev.text.slice(0, prev.text.length - before.length);
      seg.text = texOf(before) + seg.text;
    }
    const after = next && !next.math ? tightRun(RUN_AFTER.exec(next.text)?.[0] || '', 'after') : '';
    if (after) {
      next.text = next.text.slice(after.length);
      seg.text = glue(seg.text, texOf(after));
    }
  });
  const out = [];
  for (const seg of parts) {
    if (!seg.math && !seg.text) continue;
    const last = out.at(-1);
    if (seg.math && last?.math) {
      last.text = glue(last.text, seg.text);
    } else if (seg.math && last && OPERATOR.test(last.text) && out.at(-2)?.math) {
      out.pop();
      out.at(-1).text = glue(out.at(-1).text + texOf(last.text), seg.text);
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** Where the parenthesized group that ends `buf` opens, or -1. */
function groupStart(buf) {
  if (!buf.endsWith(')')) return -1;
  let depth = 0;
  for (let k = buf.length - 1; k >= 0; k -= 1) {
    if (buf[k] === ')') depth += 1;
    else if (buf[k] === '(' && --depth === 0) return k;
  }
  return -1;
}

function balanced(t) {
  let depth = 0;
  for (const ch of t) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

// Scan prose (no explicit delimiters) for bare LaTeX: \command{..} and ^/_ runs.
function splitBareLatex(raw) {
  // ClassMarker export debris: a superscript minus before a fraction
  // ("^{-} ^{3}/_{7}") is the fraction's sign, an empty subscript is nothing,
  // and an empty superscript at most a space ("14^{x}^{ }in").
  const s = cmFractionForms(raw
    .replace(/\^\{\s*[-\u2212]\s*\}\s*(?=\^\{)/g, '-')
    .replace(/_\{\s*\}/g, '')
    .replace(/\^\{(\s*)\}/g, (_, space) => (space ? ' ' : '')));
  const segs = [];
  const n = s.length;
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { segs.push({ math: false, text: buf }); buf = ''; } };
  const readGroup = (j) => { // j points at '{' -> return index just after the matching '}'
    let depth = 0;
    for (; j < n; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return j;
  };
  while (i < n) {
    const c = s[i];
    const frac = c === '^' ? cmFraction(s, i, readGroup) : null;
    if (frac) {
      // A unary sign just before the fraction belongs to it: (-^{5}/_{2}, 1).
      const sign = unarySign(buf, segs.at(-1)?.math);
      if (sign >= 0) buf = buf.slice(0, sign);
      flush();
      segs.push({ math: true, text: `${sign >= 0 ? '-' : ''}${frac.tex}` });
      i = frac.end;
      continue;
    }
    // ClassMarker's fraction with a bare numerator: the token written before
    // "/_{..}" is the numerator ("√3 /_{2}", "-√2 /_{2}", "(x + 1) /_{3}").
    const bare = c === '/' || c === '\u2044' ? /^[/\u2044]\s*_\s*\{/.exec(s.slice(i)) : null;
    if (bare) {
      const m = /(√\s*)?(\([^()]*\)|[A-Za-z0-9.]+)\s*$/.exec(buf);
      const denStart = i + bare[0].length - 1;
      const denEnd = readGroup(denStart);
      if (m && !/[A-Za-z0-9)]/.test(buf[m.index - 1] || '') && s[denEnd - 1] === '}') {
        buf = buf.slice(0, m.index);
        const sign = unarySign(buf, segs.at(-1)?.math);
        if (sign >= 0) buf = buf.slice(0, sign);
        flush();
        const core = m[2].replace(/^\((.*)\)$/, '$1');
        const num = m[1] ? `\\sqrt{${core}}` : core;
        segs.push({ math: true, text: `${sign >= 0 ? '-' : ''}\\frac{${texOf(num)}}{${texOf(s.slice(denStart + 1, denEnd - 1).trim())}}` });
        i = denEnd;
        continue;
      }
      // The numerator is the math just before: "Fr^{2} / _{Mm}".
      if (!buf.trim() && segs.at(-1)?.math && s[denEnd - 1] === '}') {
        const num = segs.pop().text;
        buf = '';
        segs.push({ math: true, text: `\\frac{${num}}{${texOf(s.slice(denStart + 1, denEnd - 1).trim())}}` });
        i = denEnd;
        continue;
      }
    }
    // \command (letters), optional [..] arg, then any {..} groups
    if (c === '\\' && /[a-zA-Z]/.test(s[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(s[j])) j++;
      if (s[j] === '[') { const k = s.indexOf(']', j); if (k >= 0) j = k + 1; }
      while (s[j] === '{') j = readGroup(j);
      flush();
      segs.push({ math: true, text: s.slice(i, j) });
      i = j;
      continue;
    }
    // power / subscript: <base>^.. or <base>_..
    if (c === '^' || c === '_') {
      let j = i + 1;
      let script = null;
      if (s[j] === '{') {
        j = readGroup(j);
        script = s.slice(i + 1, j);
      } else if (s[j] === '(' && c === '^') {
        // A parenthesized exponent: y^(12/5) is y^{12/5}.
        let depth = 0;
        let k = j;
        for (; k < n; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && --depth === 0) break;
        }
        if (k < n) { script = `{${s.slice(j + 1, k)}}`; j = k + 1; }
      } else {
        // A bare script: a number or one letter (x^2y is x^{2}y), signed
        // (10^-8), braced so its sign is raised with it. A period after it
        // ends the sentence.
        if ((s[j] === '-' || s[j] === '\u2212') && /[A-Za-z0-9]/.test(s[j + 1] || '')) j++;
        if (/[A-Za-z]/.test(s[j] || '')) j++;
        else while (j < n && /[0-9.]/.test(s[j])) j++;
        while (j > i + 1 && s[j - 1] === '.') j--;
        script = j > i + 1 ? `{${s.slice(i + 1, j)}}` : null;
      }
      // A unit squared or cubed is text, as the SAT prints it: cm³, ft².
      if (/^\{\s*[23]\s*\}$/.test(script || '') && /(?:^|[^A-Za-z])(?:cm|mm|km|ft|in|yd|mi)$/.test(buf)) {
        buf += script.includes('2') ? '\u00b2' : '\u00b3';
        i = j;
        continue;
      }
      // A caret with nothing readable after it is not math.
      if (script) {
        let b = buf.length;
        while (b > 0 && /[A-Za-z0-9.]/.test(buf[b - 1])) b--;
        let base = b < buf.length ? texOf(buf.slice(b)) : null;
        if (base == null && c === '^') {
          // A parenthesized base, with the coefficient written against it:
          // (x + 4)^{2}, 8,000(1.60)^{t/2}. (A group holding math of its own
          // is already math, taken at its closing parenthesis.)
          const g = groupStart(buf);
          if (g >= 0 && mathy(buf.slice(g))) {
            const at = coefficientAt(buf.slice(0, g));
            b = at >= 0 ? at : g;
            base = texOf(buf.slice(b));
          }
        }
        const tex = `${c}${texOf(script)}`;
        if (base == null && !buf && segs.at(-1)?.math) {
          // A script right after math is that math's: \sqrt{2}^{3},
          // (\frac{1}{2})^{x}. Math that already ends in a script is braced
          // first, since a second one on the same atom is a TeX error.
          const prev = segs.at(-1).text;
          segs.at(-1).text = /[\^_](?:\{[^{}]*\}|\w)$/.test(prev) ? `{${prev}}${tex}` : prev + tex;
          i = j;
          continue;
        }
        // A script over nothing, as ClassMarker sometimes exports one
        // ("-16 ^{2}"), is still set raised rather than shown as markup.
        if (base == null && s[i + 1] === '{') base = '{}';
        if (base != null) {
          buf = buf.slice(0, b);
          flush();
          segs.push({ math: true, text: base + tex });
          i = j;
          continue;
        }
      }
    }
    if (c === ')') {
      const group = takeGroup(segs, buf);
      if (group != null) {
        buf = '';
        segs.push({ math: true, text: group });
        i++;
        continue;
      }
      // sqrt(...) written out, all prose inside: sqrt(10), 10sqrt(2).
      const root = /(^|[^A-Za-z])sqrt\s*\(([^()]*)$/.exec(buf);
      if (root && mathy(root[2])) {
        buf = buf.slice(0, root.index + root[1].length);
        let tex = `\\sqrt{${texOf(root[2])}}`;
        const at = coefficientAt(buf);
        if (at >= 0) { tex = texOf(buf.slice(at)) + tex; buf = buf.slice(0, at); }
        flush();
        segs.push({ math: true, text: tex });
        i++;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return joinMath(segs);
}

// Single-$ is intentionally NOT a delimiter (collides with currency like "$5").
const DELIM = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$)/g;

function toSegments(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  let m;
  DELIM.lastIndex = 0;
  while ((m = DELIM.exec(s))) {
    if (m.index > last) out.push(...splitBareLatex(s.slice(last, m.index)));
    const tok = m[0];
    let tex = tok;
    let display = false;
    if (tok.startsWith('\\(')) tex = tok.slice(2, -2);
    else if (tok.startsWith('\\[')) { tex = tok.slice(2, -2); display = true; }
    else if (tok.startsWith('$$')) { tex = tok.slice(2, -2); display = true; }
    out.push({ math: true, text: tex, display });
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(...splitBareLatex(s.slice(last)));
  return out;
}

// Underlined spans mark "the underlined sentence" a Reading and Writing
// question asks about. The question bank stores them as <u>...</u>, the only
// markup it allows; everything else stays plain prose and math.
const UNDERLINE = /<u>([\s\S]*?)<\/u>/g;

// Inline math is set in display style, as the SAT sets it: a fraction in a
// stem or an answer choice keeps full-size numerals instead of shrinking to
// text style. Exponents and subscripts still shrink, since KaTeX sets scripts
// in script style whatever the outer style is.
// In prose, a hyphen that stands for minus is set as the minus sign the math
// uses: "-70" and "x - 3", but never "xy-plane" or "well - known".
const UNARY_MINUS = /(^|[\s([=+,])-(?=[\d.√\u03c0(])/g;
// Before a lone letter: where no word comes before ("= -x", "(-b"), or where
// math follows the letter ("is -b²/4", "is -x + 3"), but never a suffix, as in
// "adding -s".
const UNARY_MINUS_VAR = /(^|[([=+,<>]\s*|\s)-(?=[A-Za-z](?![A-Za-z]))/g;
const MATH_AFTER_VAR = /^[A-Za-z](?:[\u00b2\u00b3\u00b9\u2070-\u2079^(/*\d]|\s*[-+=\u2212<>])/;
const minusVar = (all, before, at, whole) => (
  /^\s$/.test(before) && !MATH_AFTER_VAR.test(whole.slice(at + all.length)) ? all : `${before}\u2212`);
const BINARY_MINUS = /(?<=(?:^|[^A-Za-z])[A-Za-z]|[\d)\u00b2\u00b3\u00b9\u2070-\u2079\u03c0]) - (?=[\d(√\u03c0]|[A-Za-z](?![A-Za-z]))/g;
const typeset = (t) => t.replace(UNARY_MINUS, '$1\u2212').replace(UNARY_MINUS_VAR, minusVar).replace(BINARY_MINUS, ' \u2212 ');
// In math a comma is punctuation, followed by a thin space; the comma that
// groups digits (1,296) is not. An unescaped % or $ in a stored span is a
// percent or dollar sign, not TeX's comment or math shift.
const DIGIT_GROUPS = /(?<![\d.])[1-9]\d{0,2}(?:,\d{3})+(?!\d)/g;
const mathTex = (t) => growParens(t.replace(DIGIT_GROUPS, (m) => m.replace(/,/g, '{,}')).replace(/(?<!\\)[%$]/g, '\\$&'));

// Math is set in display style, where a fraction is tall: parentheses around
// one grow with it, as the SAT sets them, 5(\frac{y}{2}+5) becoming
// 5{\left(\frac{y}{2}+5\right)}. Braced, the grown pair is an ordinary atom,
// set flush against its neighbors as plain parentheses are, without TeX's
// inner-atom spacing. Pairs match within one brace group, since \left and
// \right must share one. Square brackets take part in the matching, so the
// ends of an interval such as [0, \frac{1}{2}) stay as written, and so does a
// parenthesis already sized (\left(, \bigl().
const CONTROL = /\\(?:[A-Za-z]+|[\s\S])/y;
const SIZED = /^\\(?:left|right|[bB]igg?[lr]?)$/;
const FRACTION = /\\d?frac/;
function growParens(tex) {
  if (!FRACTION.test(tex)) return tex;
  const open = [];
  const grow = new Set();
  let depth = 0;
  for (let i = 0; i < tex.length; i += 1) {
    const ch = tex[i];
    if (ch === '\\') {
      CONTROL.lastIndex = i;
      const name = CONTROL.exec(tex)?.[0] ?? '\\';
      i += name.length - 1;
      if (SIZED.test(name) && '()[]'.includes(tex[i + 1] ?? ' ')) i += 1;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      while (open.length && open.at(-1).depth > depth) open.pop();
    } else if (ch === '(' || ch === '[') {
      open.push({ at: i, ch, depth });
    } else if ((ch === ')' || ch === ']') && open.at(-1)?.depth === depth) {
      const o = open.pop();
      if (o.ch === '(' && ch === ')' && FRACTION.test(tex.slice(o.at, i))) grow.add(o.at).add(i);
    }
  }
  if (!grow.size) return tex;
  return tex.replace(/[()]/g, (c, at) => (!grow.has(at) ? c : c === '(' ? '{\\left(' : '\\right)}'));
}

// A line that is nothing but math is set as math whole, so the "y = " or
// "g(x) = " it opens with is not in the text face beside the math it
// defines. Its prose may hold numbers, single letters, operators and
// parentheses, never a word ("x > 0, where", "is", "of").
const MATH_PROSE = /^[\s\d.,;:+\-\u2212*/=<>\u2264\u2265\u00d7\u00f7\u00b7√()%|\u00b2\u00b3A-Za-z]*$/;
function wholeMath(segs) {
  const allMath = segs.some((seg) => seg.math && !seg.display)
    && segs.every((seg) => (seg.math ? !seg.display : MATH_PROSE.test(seg.text) && !/[A-Za-z]{2,}/.test(seg.text)));
  if (!allMath) return segs;
  return [{ math: true, text: segs.map((seg) => (seg.math ? seg.text : texOf(seg.text))).reduce(glue) }];
}

function renderSegments(text, keyPrefix) {
  const segs = wholeMath(toSegments(text));
  return segs.map((seg, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (!seg.math) {
      // A sign next to math is set as math: "7x^{6} - 14x^{2}" and "= -16t^{2}"
      // read their neighbors, which stand in as a digit (the swap keeps length).
      const before = segs[idx - 1]?.math ? '1' : '';
      const after = segs[idx + 1]?.math ? '1' : '';
      const prose = typeset(before + seg.text + after).slice(before.length, (before + seg.text).length);
      return <React.Fragment key={key}>{prose}</React.Fragment>;
    }
    const tex = mathTex(seg.text);
    const html = renderTex(seg.display ? tex : `\\displaystyle ${tex}`, !!seg.display);
    if (html == null) return <React.Fragment key={key}>{seg.text}</React.Fragment>;
    return (
      <span
        key={key}
        style={{ display: seg.display ? 'block' : 'inline' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  });
}

// Bulleted notes ("\u2022 " at the start of a line) get a hanging indent, so a
// wrapped bullet lines up under its text rather than under the bullet.
const BULLET = '\u2022 ';
// A Reading and Writing passage is stored with one line break between its
// parts, as the question bank prints it: "Text 1" / "Text 2" headings above
// paired texts, a context line ("The following text is from ...") above an
// excerpt, verse one line each. The SAT sets the headings bold and leaves
// space before the second text and after the context line; verse lines stay
// together.
const TEXT_HEADING = /^Text [12]$/;
const CONTEXT_LINE = /^The following (text|texts|passage|poem|excerpt)\b/;

function lineStyle(line, i, lines) {
  if (TEXT_HEADING.test(line)) return { display: 'block', fontWeight: 600, marginTop: i ? '1em' : 0 };
  if (i === 0 && lines.length > 1 && CONTEXT_LINE.test(line)) return { display: 'block', marginBottom: '0.75em' };
  return { display: 'block' };
}

// A small table in a passage is written as rows of cells separated by " | ",
// the header row first, with its title on the line above. The SAT sets such a
// table with ruled cells, the title in bold above it.
const CELL_SEP = ' | ';
const NUMERIC = /^[-+]?[\d,]*\.?\d+%?$/;

function tableRows(lines, start) {
  const rows = [];
  for (let i = start; i < lines.length && lines[i].includes(CELL_SEP); i += 1) rows.push(lines[i].split(CELL_SEP).map((c) => c.trim()));
  return rows.length > 1 && rows.every((r) => r.length === rows[0].length) ? rows : null;
}

function Table({ rows, keyPrefix }) {
  const cell = 'border px-2.5 py-1 align-top';
  // A table wider than its column (a phone) scrolls sideways within it
  // rather than being cut off at the edge of the card.
  return (
    <span className="my-1.5 mb-2.5 block max-w-full overflow-x-auto">
      <table className="border-collapse text-[0.92em] leading-snug">
        <thead>
          <tr>{rows[0].map((c, j) => <th key={j} className={`${cell} bg-muted/60 text-left font-semibold`}>{renderLine(c, `${keyPrefix}h${j}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(1).map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={`${cell} ${NUMERIC.test(c) ? 'text-right tabular-nums' : 'text-left'}`}>{renderLine(c, `${keyPrefix}r${i}c${j}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </span>
  );
}

function renderLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const rows = line.includes(CELL_SEP) ? tableRows(lines, i) : null;
    if (rows) {
      out.push(<Table key={i} rows={rows} keyPrefix={`t${i}`} />);
      i += rows.length - 1;
    } else if (line.startsWith(BULLET)) {
      // The bullet sits in a box exactly as wide as the indent, so the
      // first line's text and its wrapped lines start at the same x.
      out.push(
        <span key={i} style={{ display: 'block', paddingLeft: '1em', textIndent: '-1em' }}>
          <span style={{ display: 'inline-block', width: '1em', textIndent: 0 }}>{'\u2022'}</span>
          {renderLine(line.slice(BULLET.length), `l${i}`)}
        </span>,
      );
    } else if (line && tableRows(lines, i + 1)) {
      out.push(<span key={i} style={{ display: 'block', fontWeight: 600 }}>{renderLine(line, `l${i}`)}</span>);
    } else {
      out.push(<span key={i} style={lineStyle(line, i, lines)}>{line ? renderLine(line, `l${i}`) : '\u00a0'}</span>);
    }
  }
  return out;
}

export function MathText({ children, text, style, className }) {
  const src = String((text != null ? text : children) ?? '');
  const lines = src.split('\n');
  if (lines.length > 1) {
    return (
      <span className={className} style={{ display: 'block', ...style }}>
        {renderLines(lines)}
      </span>
    );
  }
  // Spaces collapse as usual, so a wrapped underline does not run on over the
  // trailing space at the end of a line.
  return (
    <span className={className} style={{ whiteSpace: 'pre-line', ...style }}>
      {renderLine(src, 't')}
    </span>
  );
}

function renderLine(src, keyPrefix) {
  const parts = [];
  let last = 0;
  let n = 0;
  let m;
  UNDERLINE.lastIndex = 0;
  while ((m = UNDERLINE.exec(src))) {
    if (m.index > last) parts.push(...renderSegments(src.slice(last, m.index), `${keyPrefix}t${n++}`));
    parts.push(<u key={`${keyPrefix}u${n}`}>{renderSegments(m[1], `${keyPrefix}u${n++}`)}</u>);
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(...renderSegments(src.slice(last), `${keyPrefix}t${n++}`));
  return parts;
}

export default MathText;
