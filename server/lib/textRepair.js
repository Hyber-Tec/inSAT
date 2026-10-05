// Text a model or an agent wrote as JSON sometimes reaches the bank damaged in
// a way a student then sees as raw markup:
//   - a LaTeX backslash read as a JSON escape: "\frac" parses as a form feed
//     followed by "rac", "\beta" as a backspace and "eta";
//   - a line break escaped once too often, arriving as the two characters "\n";
//   - math delimiters written as bare parentheses: "is (5\sqrt{3}/3)" for
//     "is \(5\sqrt{3}/3\)";
//   - a $ or % inside a math span, which TeX reads as math shift and comment
//     rather than as money and percent.
// repairText undoes exactly those and leaves everything else as it is, so
// running it again changes nothing.

// Inline and display math, as the client's MathText finds it.
const MATH = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$)/;

// The letter a lost backslash's escape ate.
const EATEN = { '\b': 'b', '\t': 't', '\v': 'v', '\f': 'f', '\r': 'r' };
// A backspace, a vertical tab or a form feed never belongs in a question. A tab
// or a carriage return can be real whitespace, so inside math they count as a
// lost backslash only before the rest of a LaTeX command, and in prose never.
const COMMAND_REST = {
  '\t': /^(?:imes|ext[a-z]*|heta|an|riangle|frac|o|au|op|ilde)(?![a-z])/,
  '\r': /^(?:ight[a-z]*|ho|angle|floor|ceil)(?![a-z])/,
};
// The rest of a LaTeX command that starts with n, which "\n" may well be.
const N_COMMAND_REST = /^(?:eq|e|u|ot|otin|abla|eg|ewline|i|mid|leq|geq|parallel|subseteq|exists)(?![A-Za-z])/;

function restoreBackslashes(text, inMath) {
  return text.replace(/[\b\t\v\f\r](?=[a-z])/g, (ch, at) => {
    const rest = COMMAND_REST[ch];
    if (rest && !(inMath && rest.test(text.slice(at + 1)))) return ch;
    return `\\${EATEN[ch]}`;
  });
}

// Math written as a parenthesized group: set off by a space before (not a
// function's argument, f(x)) and by a space, punctuation or the end after (not
// a base, (x + 1)^{2}, or a factor, (x + 1)(x - 1)), outside any other group,
// holding nothing but math: numbers, single letters, LaTeX commands.
const BARE_GROUP = /(^|[\s,;:])\(([^()]*)\)(?=[\s.,;:!?]|$)/g;
const mathOnly = (g) => /^[\d\s\\{}A-Za-z/=.+\-\u2212\u00d7\u00b7]*$/.test(g) && /\d/.test(g)
  && !/[A-Za-z]{2,}/.test(g.replace(/\\[A-Za-z]+/g, ''));
const hasCommand = (g) => /\\[A-Za-z]+/.test(g);
const topLevel = (text, at) => {
  let depth = 0;
  for (let k = 0; k < at; k += 1) depth += text[k] === '(' ? 1 : text[k] === ')' ? -1 : 0;
  return depth === 0;
};

const bareGroups = (prose) => [...prose.matchAll(BARE_GROUP)].filter((m) => topLevel(prose, m.index + m[1].length));
/** Whether a text writes math as a bare parenthesized group holding a LaTeX command. */
const writesBareMath = (text) => text.split(MATH).some((part, i) => i % 2 === 0
  && bareGroups(part).some((m) => hasCommand(m[2]) && mathOnly(m[2])));

/**
 * Math delimiters written as bare parentheses: "the short leg is
 * (5\sqrt{3}/3)". A group that holds a LaTeX command gives the writer away;
 * in a text that has one (or, with `known`, whose writer is known to do it),
 * a math-only fraction such as "(5/2)" was written the same way.
 */
function restoreDelimiters(prose, known) {
  const groups = bareGroups(prose);
  if (!known && !groups.some((m) => hasCommand(m[2]) && mathOnly(m[2]))) return prose;
  let out = '';
  let last = 0;
  for (const m of groups) {
    const g = m[2];
    if (!mathOnly(g) || !(hasCommand(g) || g.includes('/'))) continue;
    out += `${prose.slice(last, m.index)}${m[1]}\\(${g}\\)`;
    last = m.index + m[0].length;
  }
  return out + prose.slice(last);
}

/**
 * One text field with the damage described above undone. `bareMath` says its
 * writer is known to write math in bare parentheses (seen in another field).
 */
export function repairText(text, { bareMath = false } = {}) {
  if (typeof text !== 'string') return text;
  // Delimiters first, so what they restore is repaired as math below.
  const delimited = text.split(MATH).map((part, i) => (i % 2 ? part : restoreDelimiters(part, bareMath))).join('');
  return delimited.split(MATH).map((part, i) => {
    if (i % 2 === 0) {
      // Prose: a "\n" that starts no command is the line break it was meant to be.
      return restoreBackslashes(part, false)
        .replace(/(?<!\\)\\n/g, (all, at, whole) => (N_COMMAND_REST.test(whole.slice(at + 2)) ? all : '\n'));
    }
    let math = restoreBackslashes(part, true)
      .replace(/\n(?=(?:eq|e|u|ot|abla|eg)(?![A-Za-z]))/g, '\\n');
    if (!math.startsWith('$$')) {
      const open = math.slice(0, 2);
      const close = math.slice(-2);
      math = open + math.slice(2, -2).replace(/(?<!\\)[$%]/g, '\\$&') + close;
    }
    return math;
  }).join('');
}

const EXPLAINED = ['correct', 'A', 'B', 'C', 'D'];

/**
 * A question with repairText applied to what a student reads: its question,
 * passage, choices and explanations (a string, or one per choice). Anything
 * else, such as a transcriber's notes, stays as written. One writer wrote all
 * of a question's explanations, so a habit seen in one is looked for in all.
 */
export function repairItemText(item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  for (const key of ['question', 'passage']) if (typeof out[key] === 'string') out[key] = repairText(out[key]);
  if (Array.isArray(out.choices)) out.choices = out.choices.map((c) => repairText(c));
  if (typeof out.rationale === 'string') out.rationale = repairText(out.rationale);
  else if (out.rationale && typeof out.rationale === 'object') {
    out.rationale = { ...out.rationale };
    const keys = EXPLAINED.filter((key) => typeof out.rationale[key] === 'string');
    const bareMath = keys.some((key) => writesBareMath(out.rationale[key]));
    for (const key of keys) out.rationale[key] = repairText(out.rationale[key], { bareMath });
  }
  return out;
}
