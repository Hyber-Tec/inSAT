// How questions actually look to a student, checked in a real browser.
// Requires the local API and client (`./start.sh`).
//
//   From client:
//   npm run check:rendering -- --items <id,id,...>   # through the real UI: a practice set, the review
//   npm run check:rendering -- --items <id,...> --phone  # the same on a phone-sized screen
//   npm run check:rendering -- --audit [--institution satify] [--limit N]
//   npm run check:rendering -- --fixtures                    # only the known shapes, in seconds
//
// --items puts those bank items in a temporary student's practice set, submits
// it unanswered and opens every question in the answer review, as a student
// sees it after a set. --audit renders every servable item of an institution
// (question, passage, choices, every explanation) through the app's own
// MathText renderer on a dev page, fast enough for the whole bank, after a
// fixed set of shapes the bank has shown (FIXTURES), each of which must become
// exactly its expected TeX.
//
// Either way the check reads the text a student can see (KaTeX's hidden
// MathML copy excluded) and flags raw markup: ClassMarker's ^{..} and _{..},
// LaTeX commands or \( \) delimiters left as text, braces outside math
// (a set such as {0, 15, 30} aside), control characters, and KaTeX errors.
// Findings and screenshots go to .logs/rendering/. Temporary students and
// institutions are removed.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, pool } from '../../functions/lib/db.js';
import { hashPassword } from '../../functions/lib/auth.js';
import { importRows } from '../../functions/lib/items.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const origin = process.env.E2E_CLIENT_URL || 'http://127.0.0.1:5174';
const apiOrigin = process.env.E2E_API_URL || 'http://localhost:3002';
const output = path.resolve(process.env.E2E_OUTPUT || '../.logs/rendering');
fs.mkdirSync(output, { recursive: true });

// What a student must never see. Each is [name, test on a scanned field]: its
// visible text (KaTeX's hidden MathML copy excluded), its prose (the text
// outside KaTeX), and its KaTeX errors, among them the red text KaTeX sets
// for a command it does not know.
const PROBLEMS = [
  ['ClassMarker ^{..} or _{..}', (s) => /[\^_]\{/.test(s.text)],
  ['LaTeX command as text', (s) => /\\[A-Za-z]/.test(s.text)],
  ['\\( \\) delimiter as text', (s) => /\\[()[\]]/.test(s.text)],
  // A brace in prose is markup, unless it encloses a set: {0, 15, 30, ...}.
  ['brace as text', (s) => /[{}]/.test(s.prose.replace(/\{[^{}]*,[^{}]*\}/g, ''))],
  ['control character', (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s.text)],
  ['broken \\frac (rac{)', (s) => /(?:^|[^A-Za-z])rac\{/.test(s.text)],
  ['KaTeX error', (s) => s.errors > 0],
];

/** In the page: every element tagged data-check, its visible text, prose, TeX and KaTeX errors. */
const SCAN = `(() => [...document.querySelectorAll('[data-check]')].map((el) => {
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.katex-mathml').forEach((m) => m.remove());
  const text = copy.textContent;
  copy.querySelectorAll('.katex').forEach((m) => m.remove());
  return {
    key: el.getAttribute('data-check'),
    text,
    prose: copy.textContent,
    tex: [...el.querySelectorAll('annotation[encoding="application/x-tex"]')].map((a) => a.textContent.replace(/^\\\\displaystyle /, '')),
    errors: el.querySelectorAll('.katex-error, .katex [style*="#cc0000"]').length,
  };
}))()`;

function findings(scanned) {
  const out = [];
  for (const s of scanned) {
    for (const [name, test] of PROBLEMS) if (test(s)) out.push({ key: s.key, problem: name, text: s.text.slice(0, 200) });
  }
  return out;
}

// Shapes the bank has shown, each with the math it must become (the TeX KaTeX
// is given, one entry per math span) and, where it matters, the prose around
// it. The audit renders them first, so a change to MathText that breaks one
// fails whatever the bank holds.
const FIXTURES = [
  // ClassMarker fractions, in each spelling its export has
  ['√3 /_{2}', ['\\frac{\\sqrt{3}}{2}']],
  ['-√2 /_{2}', ['-\\frac{\\sqrt{2}}{2}']],
  ['(x + 1) /_{3}', ['\\frac{x + 1}{3}']],
  ['^{(w − 23y + z)}/_{(46wy)}', ['\\frac{w - 23y + z}{46wy}']],
  ['^{30/}230', ['\\frac{30}{230}']],
  ['^{50}_{/230}', ['\\frac{50}{230}']],
  ['^{65/}_{230}', ['\\frac{65}{230}']],
  ['^{-5/}_{2}', ['-\\frac{5}{2}']],
  ['l = ^{P − 2w} /2', ['l = \\frac{P - 2w}{2}']],
  ['G = ^{Fr^{2}}/_{Mm}', ['G = \\frac{Fr^{2}}{Mm}']],
  ['\\sqrt{3} /_{2}', ['\\frac{\\sqrt{3}}{2}']],
  ['F = ^{GMm}/_{r^{2}}', ['F = \\frac{GMm}{r^{2}}']],
  ['10 = ^{(4 − x)}/2', ['10 = \\frac{4 - x}{2}']],
  ['Tan Y = ^{7} /√85; Tan Z = ^{6} /_{√85 }', ['\\frac{7}{\\sqrt{85}}', '\\frac{6}{\\sqrt{85}}']],
  ['t(x) = ^{−}^{1}/_{3 }x + 7', ['t(x) = -\\frac{1}{3}x + 7']],
  // a group holding math is math, its parentheses sized to a fraction, with its
  // coefficient and a unary sign; a power sets on it
  ['r = 32 (^{1}/_{2})^{x}', ['r = 32 {\\left(\\frac{1}{2}\\right)}^{x}']],
  ['A = P (1 + ^{r}/_{n})^{nt}', ['A = P {\\left(1 + \\frac{r}{n}\\right)}^{nt}']],
  ['- (^{27}/_{4})^{2}', ['-{\\left(\\frac{27}{4}\\right)}^{2}']],
  ['which gives - (^{27}/_{4})^{2}.', ['-{\\left(\\frac{27}{4}\\right)}^{2}']],
  ['7(x^{3} - 2x^{2})^{2}', ['7(x^{3} - 2x^{2})^{2}']],
  ['g(x) = k(1.83^{x})^{1/4}', ['g(x) = k(1.83^{x})^{1/4}']],
  ['y = (^{-} ^{3}/_{7})_{ }x + 15', ['y = {\\left(-\\frac{3}{7}\\right)}x + 15']],
  ['(^{-112}/5, 0)', ['{\\left(-\\frac{112}{5}, 0\\right)}']],
  ['8,000(1.60)^{t/2}', ['8{,}000(1.60)^{t/2}']],
  ['y^(12/5)', ['y^{12/5}']],
  // math either side of an operator is one expression; a binary sign stays out
  ['7x^{6} - 14x^{2}, where x > 0', ['7x^{6} - 14x^{2}']],
  ['7x^{2}(x^{4} - 2)', ['7x^{2}(x^{4} - 2)']],
  ['g(x) = x^{2} + (^{27}/_{2})x', ['g(x) = x^{2} + {\\left(\\frac{27}{2}\\right)}x']],
  ['(x⁶)^{1/5} = y^{3/2}', ['(x⁶)^{1/5} = y^{3/2}']],
  ['y = 3x - ^{1}/_{2}', ['y = 3x - \\frac{1}{2}']],
  // plain-text math: signed and bare scripts, sqrt written out, a slash between
  // math, and numbers and operators written flush against math
  ['(5×10^-8)/(6×10^-9)=8.33, closest to 8.', ['(5×10^{-8})/(6×10^{-9})=8.33'], ', closest to 8.'],
  ['so the model is 1,800(0.97)^t.', ['1{,}800(0.97)^{t}'], 'so the model is .'],
  ['The point is sqrt(10) units away.', ['\\sqrt{10}']],
  ['a side is sqrt(8^2+15^2)=17', ['\\sqrt{8^{2}+15^{2}}=17'], 'a side is '],
  ['side length sqrt(200)=10sqrt(2).', ['\\sqrt{200}=10\\sqrt{2}'], 'side length .'],
  ['x^{4}y^{2} + 9xy^{4}− 15xy^{2}', ['x^{4}y^{2} + 9xy^{4}- 15xy^{2}']],
  ['Combining like terms gives 2x^2y+2xy^2.', ['2x^{2}y+2xy^{2}'], 'Combining like terms gives .'],
  ['^{47} / _{cos Q}', ['\\frac{47}{\\cos Q}']],
  ['^{1}/_{cosQ}', ['\\frac{1}{\\cos Q}']],
  // minus signs in prose: next to math, before a lone variable, never a suffix
  ['h = -16t^{2} + 64t + 8', ['h = -16t^{2} + 64t + 8'], ''],
  ['For x²+bx, the minimum is -b²/4=-(27/4)².', [], 'For x²+bx, the minimum is \u2212b²/4=\u2212(27/4)².'],
  ['cos(C) = -√2/2', [], 'cos(C) = \u2212√2/2'],
  ['by adding -ed and -s to verbs', [], 'by adding -ed and -s to verbs'],
  ['so y = -x + 3, and it is -x + 3 too', [], 'so y = \u2212x + 3, and it is \u2212x + 3 too'],
  ['y = (^{1}/_{2})(50,000)^{t}', ['y = {\\left(\\frac{1}{2}\\right)}(50{,}000)^{t}']],
  ['G = Fr^{2}Mn', ['G = Fr^{2}Mn']],
  ['Solving the law for G gives G=Fr^2/(Mm).', ['G=Fr^{2}/(Mm)'], 'Solving the law for G gives .'],
  ['(3x - 2)^{2} - ^{25}/_{12}, then', ['(3x - 2)^{2} - \\frac{25}{12}'], ', then'],
  // parentheses around a fraction grow with it, in LaTeX the data wrote too
  ['\\(5(\\frac{y}{2}+5)=2y+(\\frac{1}{2})y\\)', ['5{\\left(\\frac{y}{2}+5\\right)}=2y+{\\left(\\frac{1}{2}\\right)}y']],
  ['\\(f(x)=\\left(x+\\frac{1}{2}\\right)^{2}, [0, \\frac{1}{2})\\)', ['f(x)=\\left(x+\\frac{1}{2}\\right)^{2}, [0, \\frac{1}{2})']],
  ['\\((0, 1]\\cup[\\frac{3}{2}, 2)\\)', ['(0, 1]\\cup[\\frac{3}{2}, 2)']],
  // debris: an empty superscript, a script over nothing
  ['y = 14^{x}^{ }in the xy-plane', ['14^{x}']],
  ['h = -16 ^{2} + 64t', ['h = -16 {}^{2} + 64t']],
  // money and percent inside math, digit groups
  ['\\(($66,000-$26,000)/10=$4,000\\)', ['(\\$66{,}000-\\$26{,}000)/10=\\$4{,}000']],
  ['\\(5%\\) of \\(1,296\\)', ['5\\%', '1{,}296']],
  // braces that are not markup
  ['{0, 15, 30, 45, 60, 75…}', []],
  ['\\(\\begin{cases} y = 3x \\\\ x^{2} - y^{2} = -288 \\end{cases}\\)', ['\\begin{cases} y = 3x \\\\ x^{2} - y^{2} = -288 \\end{cases}']],
];

/** Render the fixtures; any raw markup, or math that is not the expected TeX, is a finding. */
async function checkFixtures(page) {
  await page.evaluate((items) => window.renderItems(items), [{ id: 'fixture', fields: FIXTURES.map(([text], i) => [String(i), text]) }]);
  const scanned = await page.evaluate(SCAN);
  const found = findings(scanned).map((f) => ({ ...f, input: FIXTURES[Number(f.key.split('|')[1])][0] }));
  for (const s of scanned) {
    const [input, tex, prose] = FIXTURES[Number(s.key.split('|')[1])];
    if (JSON.stringify(s.tex) !== JSON.stringify(tex)) found.push({ key: s.key, problem: 'unexpected TeX', input, text: JSON.stringify(s.tex) });
    if (prose != null && s.prose !== prose) found.push({ key: s.key, problem: 'unexpected prose', input, text: JSON.stringify(s.prose) });
  }
  for (const f of found) console.log(`  fixture ${JSON.stringify(f.input)}: ${f.problem}: ${f.text}`);
  console.log(`${FIXTURES.length} fixtures checked; ${new Set(found.map((f) => f.key)).size} render wrong`);
  return found;
}

function summarize(found, total) {
  const by = {};
  for (const f of found) (by[f.problem] ||= new Set()).add(f.key.split('|')[0]);
  const lines = Object.entries(by).map(([p, ids]) => `  ${String(ids.size).padStart(5)}  ${p}`);
  console.log(`${total} items checked; ${new Set(found.map((f) => f.key.split('|')[0])).size} render wrong${lines.length ? ':' : '.'}`);
  if (lines.length) console.log(lines.join('\n'));
}

// ------------------------------------------------------------------- audit

async function audit(browser, { fixturesOnly = false } = {}) {
  const slug = arg('institution', 'satify');
  const limit = Number(arg('limit', '0')) || null;
  const { rows } = fixturesOnly ? { rows: [] } : await query(
    `SELECT id, question, passage, choices, rationale FROM pa_items
      WHERE institution_id = (SELECT id FROM pa_institutions WHERE slug = $1)
        AND retired_at IS NULL AND source <> 'reference'
      ORDER BY id ${limit ? `LIMIT ${limit}` : ''}`,
    [slug],
  );
  const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/scripts/render-audit.html`);
  await page.waitForFunction(() => typeof window.renderItems === 'function');
  const fixtures = await checkFixtures(page);
  if (fixturesOnly) return fixtures.length === 0 && pageErrors.length === 0;
  const found = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({
      id: r.id,
      fields: [
        ['question', r.question], ['passage', r.passage],
        ...(r.choices || []).map((c, j) => [`choice ${'ABCD'[j]}`, c]),
        ...Object.entries(r.rationale || {}).filter(([k, v]) => ['correct', 'A', 'B', 'C', 'D'].includes(k) && typeof v === 'string').map(([k, v]) => [`rationale ${k}`, v]),
      ].filter(([, v]) => v),
    }));
    await page.evaluate((items) => window.renderItems(items), chunk);
    found.push(...findings(await page.evaluate(SCAN)));
  }
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify({ checked: rows.length, fixtures, found, pageErrors }, null, 2) + '\n');
  summarize(found, rows.length);
  if (pageErrors.length) console.log(`page errors: ${pageErrors.length}`);
  return fixtures.length === 0 && found.length === 0 && pageErrors.length === 0;
}

// ------------------------------------------------------------ the real UI

async function throughUi(browser, ids) {
  const institutions = [];
  const users = [];
  try {
    const { rows: items } = await query('SELECT * FROM pa_items WHERE id = ANY($1::uuid[])', [ids]);
    if (!items.length) throw new Error('no such items');
    const inst = (await query("INSERT INTO pa_institutions(name,slug) VALUES('Temporary rendering check',$1) RETURNING id", [`qa-${crypto.randomUUID()}`])).rows[0].id;
    institutions.push(inst);
    await importRows(items.map((r) => ({ ...r, variant_of: null })), inst, { nearDuplicates: 'allow' });
    // The copies have their own ids: follow them by content.
    const copies = new Map((await query('SELECT id, content_hash FROM pa_items WHERE institution_id = $1', [inst])).rows.map((r) => [r.id, items.find((it) => it.content_hash === r.content_hash)?.id]));
    const email = `render-${crypto.randomUUID()}@example.test`;
    const password = crypto.randomBytes(24).toString('base64url');
    users.push((await query("INSERT INTO pa_users(email,password_hash,display_name,role,institution_id,must_change_password) VALUES($1,$2,'Rendering check','student',$3,false) RETURNING id", [email, await hashPassword(password), inst])).rows[0].id);
    const page = await (await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1200, height: 900 }, deviceScaleFactor: 2 })).newPage();
    await page.goto(`${origin}/sign-in`);
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
    // A set of exactly these items' skills, submitted unanswered.
    const skills = [...new Set(items.map((r) => r.skill))];
    await page.evaluate(async ({ url, skills }) => {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('satify_token')}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'skills', skills }) });
      if (!r.ok) throw new Error(await r.text());
    }, { url: `${apiOrigin}/api/student/practice`, skills });
    await page.reload();
    await page.getByRole('button', { name: /Resume|Continue/ }).first().click();
    const session = (await query('SELECT id, form FROM pa_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1', [users[0]])).rows[0];
    for (const section of session.form.sections) {
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      // The runner opens on the first question; the last one carries the submit button.
      const count = section.modules[0].questions.length;
      await page.getByRole('button', { name: `Question 1 of ${count}`, exact: true }).waitFor();
      for (let i = 1; i < count; i += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
      const pending = page.waitForResponse((r) => /\/(finish|state)$/.test(r.url()));
      await page.getByRole('button', { name: 'Submit module', exact: true }).click();
      await pending;
    }
    await page.getByText('Click any question to see what went wrong.').waitFor();
    const served = session.form.sections.flatMap((s) => s.modules.flatMap((m) => m.questions));
    const found = [];
    let checked = 0;
    for (const [i, q] of served.entries()) {
      const original = copies.get(q.itemId);
      if (!original) continue;
      checked += 1;
      await page.getByRole('button', { name: String(i + 1), exact: true }).first().click();
      await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
      // Tag the review dialog for the scan.
      const dialog = page.getByRole('dialog');
      await dialog.evaluate((el, id) => el.setAttribute('data-check', `${id}|review`), original);
      found.push(...findings(await page.evaluate(SCAN)));
      // Nothing a student can see may stick out sideways: not the page, and
      // not the review's content past the review, where it would be cut off.
      // What an element shows is clipped by its clipping ancestors (KaTeX
      // draws a radical's bar wide and clips it); what a scrolling box holds
      // is reachable by scrolling it; KaTeX's MathML copy is hidden.
      const over = await dialog.evaluate((el) => {
        const edge = el.getBoundingClientRect().right;
        const visibleRight = (x) => {
          let right = x.getBoundingClientRect().right;
          for (let a = x.parentElement; a && a !== el; a = a.parentElement) {
            const o = getComputedStyle(a).overflowX;
            if (o === 'auto' || o === 'scroll') return -Infinity;
            if (o === 'hidden' || o === 'clip') right = Math.min(right, a.getBoundingClientRect().right);
          }
          return right;
        };
        let worst = { by: document.documentElement.scrollWidth - document.documentElement.clientWidth, what: 'the page' };
        for (const x of el.querySelectorAll('*')) {
          if (x.closest('.katex-mathml') || !x.getClientRects().length) continue;
          const by = visibleRight(x) - edge;
          if (by > worst.by) worst = { by, what: `<${x.tagName.toLowerCase()} class="${x.getAttribute('class') || ''}"> ${x.textContent.slice(0, 60)}` };
        }
        return worst;
      });
      if (over.by > 1) found.push({ key: `${original}|review`, problem: `wider than the screen by ${Math.round(over.by)}px`, text: over.what });
      await page.evaluate(() => document.querySelector('[data-check]')?.removeAttribute('data-check'));
      await page.screenshot({ path: path.join(output, `review-${phone ? 'phone-' : ''}${original.slice(0, 8)}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
    if (checked !== ids.length) throw new Error(`only ${checked} of ${ids.length} items were served`);
    fs.writeFileSync(path.join(output, 'items.json'), JSON.stringify({ checked, found }, null, 2) + '\n');
    summarize(found, checked);
    for (const f of found.slice(0, 10)) console.log(`  ${f.key}: ${f.problem}: ${JSON.stringify(f.text.slice(0, 120))}`);
    return found.length === 0;
  } finally {
    for (const id of users) await query('DELETE FROM pa_users WHERE id=$1', [id]);
    for (const id of institutions) await query('DELETE FROM pa_institutions WHERE id=$1', [id]);
  }
}

const phone = process.argv.includes('--phone');
let browser;
let ok = false;
try {
  browser = await chromium.launch({ headless: true });
  const ids = arg('items');
  ok = ids ? await throughUi(browser, ids.split(',')) : await audit(browser, { fixturesOnly: process.argv.includes('--fixtures') });
} finally {
  await browser?.close();
  await pool.end();
}
process.exitCode = ok ? 0 : 1;
