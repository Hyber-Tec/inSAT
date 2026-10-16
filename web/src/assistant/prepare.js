// An AI answer's text, made ready for markdown (Markdown.jsx). The AI writes
// math between \( \) or \[ \] (as it is told, functions/lib/assistant.js),
// never between single dollar signs, which in SAT questions are money.
// Markdown would read those backslashes as escapes, so each formula is
// carried through it as a code span marked as math (INLINE or DISPLAY), which
// the renderer sets as math. Plain JS, so the browser checks can test it.

export const INLINE = '\uE000';
export const DISPLAY = '\uE001';

// Code as written (a fenced block, which may still be streaming, or a code
// span), then display math (\[..\], or $$..$$ should the AI use it), then
// inline math.
const TOKENS = /(```[\s\S]*?(?:```|$))|(`+)[\s\S]*?\2|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g;

function asCode(mark, tex) {
  const body = tex.trim().replace(/\s*\n\s*/g, ' ');
  const fence = body.includes('`') ? '``' : '`';
  return `${fence}${mark}${body}${fence}`;
}

/**
 * The answer's text ready for markdown: each formula a code span marked as
 * math. An answer not whole (still streaming, or stopped) shows no formula
 * that is not closed yet, rather than raw LaTeX, and closes a bold it is in
 * the middle of, rather than showing its asterisks.
 */
export function prepare(src, partial = false) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKENS)) {
    const [whole, , , display, dollars, inline] = m;
    out += src.slice(last, m.index);
    if (display != null || dollars != null) out += asCode(DISPLAY, display ?? dollars);
    else if (inline != null) out += asCode(INLINE, inline);
    else out += whole;
    last = m.index + whole.length;
  }
  let rest = src.slice(last);
  if (!partial) return out + rest;
  const open = rest.search(/\\[([]|\$\$/);
  if (open >= 0) rest = rest.slice(0, open);
  const text = (out + rest).trimEnd();
  const bold = text.replace(/(`+)[\s\S]*?\1/g, '').match(/\*\*/g)?.length || 0;
  return bold % 2 ? `${text}**` : text;
}
