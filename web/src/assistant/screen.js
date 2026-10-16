// What is on the screen, for the AI assistant: the text a person sees, as
// they see it, and pictures of the question figures on it. Taken the moment
// they send a message, so the AI reads the screen they asked from.
//
// An open dialog (a question's review) is what they are looking at, so it
// comes first; the page behind it follows, shorter. Text is read off the page
// as laid out: headings, list items, table rows and buttons each on their own
// line, a formula as its LaTeX (KaTeX keeps it), what a control is called
// when it has no text, and a meter's value. Hidden things are left out, and
// so are form fields' values, password fields and the assistant itself
// ([data-assistant]). Figures are the images marked data-figure, drawn into
// a PNG: the AI reads bitmaps, and many figures are SVG.

const LIMIT = 16000; // characters in all, as the API takes (functions/lib/assistant.js)
const DIALOG_LIMIT = 12000;
const FIGURES = 2;
const FIGURE_SIZE = 1200; // the longer side of a figure's picture, in pixels
const FIGURE_CHARS = 1.5 * 1024 * 1024; // as the API takes, two to a message

const SKIP = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'video', 'audio',
  'input[type="password"]', '[data-assistant]', '.katex-html', '[aria-hidden="true"]',
].join(',');

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LABEL', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
]);

function visible(el) {
  if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** What a form field is called (never what is typed into it, except a choice's state). */
function fieldText(el) {
  const name = el.getAttribute('aria-label') || el.labels?.[0]?.textContent?.trim() || el.placeholder || '';
  if (el.type === 'checkbox' || el.type === 'radio') return ` [${el.checked ? 'x' : ' '}] ${name} `;
  if (el.tagName === 'SELECT') return ` [${name}: ${el.selectedOptions?.[0]?.textContent?.trim() || ''}] `;
  return name ? ` [Field: ${name}] ` : '';
}

function walk(node, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.data);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;
  if (el.matches(SKIP) || !visible(el)) return;
  const tag = el.tagName;

  // A formula: its LaTeX, which KaTeX keeps beside what it draws (less the
  // \displaystyle the app sets inline math in).
  if (el.classList.contains('katex')) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.replace(/^\s*\\displaystyle\b\s*/, '').trim();
    if (tex) out.push(el.parentElement?.classList.contains('katex-display') ? `\n\\[${tex}\\]\n` : `\\(${tex}\\)`);
    return;
  }
  if (tag === 'IMG') {
    out.push(el.hasAttribute('data-figure') ? '\n[Figure]\n' : el.alt ? ` [Image: ${el.alt}] ` : '');
    return;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    out.push(fieldText(el));
    return;
  }
  const role = el.getAttribute('role');
  if (role === 'progressbar' || role === 'meter') {
    const label = el.getAttribute('aria-label');
    const value = el.getAttribute('aria-valuetext') || (el.hasAttribute('aria-valuenow') ? `${el.getAttribute('aria-valuenow')}%` : '');
    out.push(` [${[label, value].filter(Boolean).join(': ')}] `);
    return;
  }
  // A control known by its name rather than its text (an icon button, a
  // question in the review grid).
  const label = el.getAttribute('aria-label');
  if (label && (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'radio' || role === 'tab')) {
    out.push(` [${label}] `);
    return;
  }
  // Something drawn, not written, with its meaning in a tooltip (a mastery meter).
  if (el.title && !el.textContent.trim()) {
    out.push(` [${el.title}] `);
    return;
  }

  const block = BLOCK.has(tag);
  if (block) out.push('\n');
  if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} `);
  else if (tag === 'LI') out.push('- ');
  for (const child of el.childNodes) walk(child, out);
  if (tag === 'TD' || tag === 'TH') out.push(' | ');
  else if (block) out.push('\n');
}

/** An element's text as laid out, trimmed to `limit` characters. */
export function textOf(root, limit = LIMIT) {
  if (!root) return '';
  const out = [];
  walk(root, out);
  const text = out.join('')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}\n[...]` : text;
}

/** The dialog in front, if one is open (the assistant's own panel is not one). */
function openDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .filter((d) => !d.closest('[data-assistant]') && d.getAttribute('data-state') !== 'closed' && visible(d));
  return dialogs.at(-1) || null;
}

/** A picture of a figure as a PNG data URL, or null when it cannot be drawn (not loaded, from elsewhere). */
function picture(img) {
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!img.complete || !w0 || !h0) return null;
  const scale = Math.min(2, FIGURE_SIZE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // figures are drawn for a white page
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    return png.length <= FIGURE_CHARS ? png : canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null; // an image from another origin cannot be read back
  }
}

/** The figures on the screen, the ones in view first, as pictures. */
function figuresIn(roots) {
  const imgs = roots.flatMap((r) => (r ? [...r.querySelectorAll('img[data-figure]')] : [])).filter(visible);
  const inView = (img) => {
    const r = img.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };
  const ordered = [...imgs.filter(inView), ...imgs.filter((i) => !inView(i))];
  const out = [];
  for (const img of ordered) {
    const png = picture(img);
    if (png && png.length <= FIGURE_CHARS) out.push(png);
    if (out.length === FIGURES) break;
  }
  return out;
}

/**
 * The screen now: { text, figures }. `page` is the page's own content (its
 * <main>), behind any dialog.
 */
export function captureScreen(page = document.querySelector('main')) {
  const dialog = openDialog();
  if (!dialog) return { text: textOf(page), figures: figuresIn([page]) };
  const front = textOf(dialog, DIALOG_LIMIT);
  const behind = textOf(page, Math.max(2000, LIMIT - front.length - 100));
  return {
    text: `${front}${behind ? `\n\n--- Behind this dialog ---\n${behind}` : ''}`,
    figures: figuresIn([dialog, page]),
  };
}
