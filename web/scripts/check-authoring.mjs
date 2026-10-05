// End-to-end check of custom tests (institution-managed academies: tests of
// their own questions, from an upload or written by AI), driven in a real
// browser. It runs its own API on :3012, with the AI provider mocked by
// mock-llm.mjs so no key or bill is needed, and its own build of the client on
// :5184 against it; the database is the local one (`./start.sh` brings it up).
//
//   From client: npm run check:authoring
//
// A managed academy's admin finds that uploads and AI need a key, adds one in
// Settings, has AI write a test (one draft fails the answer check and is left
// out) and reviews it: edits a question, removes one, adds questions from an
// uploaded PDF and writes one by hand, moves one to Module 2, and assigns the
// test, timed at the SAT's pace. The student takes it and sees the number
// correct, not a scaled score, and so does the admin. Asked directly: the
// academy's questions stay in its own bank (never insat's pool or the
// generation pool), and a self-guided institution's admin can neither make
// such a test nor set an AI key, and sees no AI settings. Every screen is
// checked for page errors, failed API calls and content wider than a phone;
// screenshots go to .logs/screens/authoring/. Everything it made is removed.

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, pool } from '../../functions/lib/db.js';
import { hashPassword } from '../../functions/lib/auth.js';
import { GLOBAL_POOL_SLUG, POOL_SLUG } from '../../functions/lib/pool.js';

const { PDFDocument, StandardFonts } = createRequire(path.resolve('../functions/package.json'))('pdf-lib');

const API_PORT = 3012;
const CLIENT_PORT = 5184;
const apiOrigin = `http://localhost:${API_PORT}`;
const origin = `http://127.0.0.1:${CLIENT_PORT}`;
const logs = path.resolve('../.logs');
const output = path.join(logs, 'screens/authoring');
const clientBuild = path.join(logs, 'authoring-client');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const tag = crypto.randomUUID().slice(0, 8);
const password = crypto.randomBytes(12).toString('base64url');
const email = (who) => `authoring-${who}-${tag}@example.test`;
const academy = `Lakeside Prep ${tag}`;
const otherSchool = `Open Study ${tag}`;
const title = 'Words in context drill';
const problems = [];
const children = [];
let shot = 0;
let browser;
let current;

const expect = (ok, message) => { if (!ok) problems.push(message); };

/** Start a process and wait until `url` answers. */
async function serve(name, command, args, { cwd, env, url }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(logs, `authoring-${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited; see .logs/authoring-${name}.log`);
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not come up at ${url}`);
}

async function open(viewport = DESKTOP) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  current = page;
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('response', (r) => { if (r.url().startsWith(apiOrigin) && r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(apiOrigin, '')}`); });
  return page;
}

async function capture(page, name, { full = true } = {}) {
  await page.waitForTimeout(250); // let entry animations settle
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) problems.push(`${name}: page wider than the screen by ${over}px`);
  shot += 1;
  await page.screenshot({ path: path.join(output, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: full, animations: 'disabled' });
}

async function signIn(page, address) {
  await page.goto(`${origin}/sign-in`);
  await page.locator('input[type=email]').fill(address);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Take whatever test is open: answer B where there is a B (else type 4), through every module and break. */
async function takeIt(page, onModule = async () => {}) {
  const results = page.getByText('Click any question to see what went wrong.');
  const breakTime = page.getByRole('button', { name: 'Continue', exact: true });
  for (let modules = 0; modules < 8; modules += 1) {
    const start = page.getByRole('button', { name: /^Start( Module \d)?$/ });
    await start.or(results).or(breakTime).first().waitFor();
    if (await results.isVisible()) return;
    if (await breakTime.isVisible()) { await breakTime.click(); continue; }
    await onModule(page);
    await start.first().click();
    const nav = page.getByRole('button', { name: /^Question 1 of \d+$/ });
    await nav.waitFor();
    const count = Number((await nav.textContent()).match(/of (\d+)/)[1]);
    for (let i = 1; i <= count; i += 1) {
      const b = page.locator('button:has(> span:text-is("B"))').first();
      if (await b.isVisible().catch(() => false)) await b.click();
      else await page.getByRole('textbox').first().fill('4').catch(() => {});
      if (i < count) await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  }
  throw new Error('the test did not reach its results');
}

/** Asked from here, so an expected refusal is not counted as a failed call of the page. */
async function asked(page, method, endpoint, body) {
  const token = await page.evaluate(() => localStorage.getItem('satify_token'));
  const r = await fetch(`${apiOrigin}${endpoint}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.status;
}

/** A two-page PDF standing in for a printed practice test (the mock reads it). */
async function practicePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of ['Practice test, Module 1', 'Module 2']) {
    doc.addPage([612, 792]).drawText(line, { x: 72, y: 700, size: 18, font });
  }
  const file = path.join(output, 'practice-test.pdf');
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function addUser(role, who, institutionId, name) {
  await query(
    `INSERT INTO pa_users (email, password_hash, display_name, role, institution_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [email(who), await hashPassword(password), name, role, institutionId],
  );
}

try {
  // ---- A managed academy with an admin and a student, and a self-guided institution's admin.
  const lakeside = (await query("INSERT INTO pa_institutions (name, slug, mode) VALUES ($1, $2, 'managed') RETURNING id", [academy, `lakeside-${tag}`])).rows[0].id;
  const open_ = (await query("INSERT INTO pa_institutions (name, slug, mode) VALUES ($1, $2, 'self_guided') RETURNING id", [otherSchool, `open-${tag}`])).rows[0].id;
  await addUser('admin', 'admin', lakeside, 'Riley Admin');
  await addUser('student', 'cam', lakeside, 'Cam Rivera');
  await addUser('admin', 'other', open_, 'Sam Admin');

  // ---- Its own API, with the AI provider mocked, and a client built against it.
  await serve('api', process.execPath, ['--env-file=.env', '--import', path.resolve('scripts/mock-llm.mjs'), 'index.js'], {
    cwd: path.resolve('../server'), env: { PORT: String(API_PORT), CLIENT_ORIGIN: origin }, url: `${apiOrigin}/api/health`,
  });
  const vite = path.resolve('node_modules/vite/bin/vite.js');
  execFileSync(process.execPath, [vite, 'build', '--outDir', clientBuild, '--emptyOutDir', '--logLevel', 'error'], {
    env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'inherit',
  });
  await serve('client', process.execPath, [vite, 'preview', '--outDir', clientBuild, '--port', String(CLIENT_PORT), '--strictPort', '--host', '127.0.0.1'], {
    url: `${origin}/`,
  });
  browser = await chromium.launch();

  // ---- No AI key yet: uploads and AI say so and lead to Settings.
  const admin = await open();
  await signIn(admin, email('admin'));
  await admin.getByRole('button', { name: 'Add student' }).waitFor();
  await admin.getByRole('button', { name: 'Tests', exact: true }).first().click();
  await admin.getByRole('button', { name: 'New test' }).click();
  await admin.getByRole('radio', { name: /^Written by AI/ }).click();
  await admin.getByText('Add your AI key first').waitFor();
  expect(await admin.getByRole('button', { name: 'Create test' }).isDisabled(), 'admin: a test could be written by AI with no key');
  await capture(admin, 'new-test-no-key', { full: false });
  await admin.getByRole('button', { name: 'Open Settings' }).click();
  await admin.getByText('AI provider & API key').waitFor();
  await admin.locator('#api-key').fill('sk-ant-mock-0000000000');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await admin.getByText('Saved', { exact: true }).waitFor();
  await capture(admin, 'settings-key-saved');

  // ---- AI writes a test; it opens on its questions.
  await admin.getByRole('button', { name: 'Tests', exact: true }).first().click();
  await admin.getByRole('button', { name: 'New test' }).click();
  await admin.locator('#test-title').fill(title);
  await admin.getByRole('radio', { name: /^Written by AI/ }).click();
  await admin.locator('#ai-domain').selectOption('craft-structure');
  await admin.locator('#ai-skill').selectOption('Words in Context');
  await admin.locator('#ai-count').fill('5');
  await capture(admin, 'new-test-ai', { full: false });
  await admin.getByRole('button', { name: 'Create test' }).click();
  await admin.getByRole('heading', { name: title }).waitFor();
  await admin.getByText(`Made "${title}" with 4 questions of the 5 asked for. 1 draft failed the answer check and was left out.`).waitFor();
  expect(await admin.locator('article').count() === 4, 'editor: the AI test does not show its 4 questions');
  await capture(admin, 'editor-ai-test');

  // ---- Edit one, remove one.
  await admin.locator('article').first().getByRole('button', { name: 'Edit' }).click();
  const edit = admin.getByRole('dialog', { name: 'Edit question' });
  await edit.locator('#q-explanation').fill('The tracking data weaken the earlier claim.');
  await capture(admin, 'edit-question', { full: false });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await admin.getByText('Question saved.').waitFor();
  await admin.getByText('The tracking data weaken the earlier claim.').waitFor();
  await admin.getByRole('button', { name: 'Remove question 2' }).click();
  await admin.getByRole('button', { name: 'Remove', exact: true }).click();
  await admin.getByText('3 questions', { exact: true }).waitFor();

  // ---- Questions from an uploaded PDF, where the file puts them.
  await admin.getByRole('button', { name: /Add questions/ }).click();
  await admin.getByRole('menuitem', { name: /From an upload/ }).click();
  const upload = admin.getByRole('dialog', { name: 'Add from an upload' });
  await upload.locator('input[type=file]').setInputFiles(await practicePdf());
  await upload.getByText('practice-test.pdf').waitFor();
  await capture(admin, 'upload-into-test', { full: false });
  await upload.getByRole('button', { name: 'Add questions' }).click();
  await admin.getByText(/^Added 7 questions from your upload\./).waitFor();
  await admin.getByRole('tab', { name: /Math/ }).waitFor();

  // ---- One written by hand, in Math Module 1, then moved to Module 2.
  await admin.getByRole('button', { name: /Add questions/ }).click();
  await admin.getByRole('menuitem', { name: /Write one yourself/ }).click();
  const write = admin.getByRole('dialog', { name: 'Write a question' });
  await write.getByRole('radio', { name: 'Math', exact: true }).click();
  await write.locator('#q-skill').selectOption('Linear functions');
  await write.locator('#q-question').fill('The function \\(f\\) is defined by \\(f(x) = 2x + 1\\). What is \\(f(3)\\)?');
  for (const [i, c] of ['5', '7', '9', '6'].entries()) await write.getByRole('textbox', { name: `Choice ${'ABCD'[i]}` }).fill(c);
  await write.getByRole('radio', { name: 'B is correct' }).click();
  await write.locator('#q-explanation').fill('\\(f(3) = 2(3) + 1 = 7\\).');
  await capture(admin, 'write-question', { full: false });
  await write.getByRole('button', { name: 'Add question' }).click();
  await admin.getByText('Question added.').waitFor();
  await admin.getByRole('tab', { name: /Math/ }).click();
  await admin.getByRole('radio', { name: /Module 1/ }).click();
  await admin.locator('article', { hasText: 'f(3)' }).getByRole('checkbox').click();
  await admin.getByRole('button', { name: 'Move to Module 2' }).click();
  await admin.getByText('Moved 1 question to Module 2.').waitFor();
  await admin.getByText('11 questions', { exact: true }).waitFor();
  await capture(admin, 'editor-math-module-2');
  await admin.setViewportSize(PHONE);
  await capture(admin, 'editor-phone');
  await admin.setViewportSize(DESKTOP);

  // ---- Timed at the SAT's pace, then assigned.
  expect(await admin.locator('#test-timed').getAttribute('data-state') === 'checked', 'editor: a test made timed does not show as timed');
  await admin.getByText(/\d+ minutes in all/).waitFor();
  await admin.getByRole('button', { name: 'Assign', exact: true }).click();
  const assign = admin.getByRole('dialog', { name: 'Assign a test' });
  await assign.getByRole('checkbox', { name: /Cam Rivera/ }).click();
  await assign.getByRole('button', { name: 'Assign', exact: true }).click();
  await admin.getByText(`Assigned "${title}": 1 new.`).waitFor();
  await admin.getByRole('button', { name: 'All tests' }).click();
  await admin.getByText('Custom · Reading and Writing and Math · 11 questions').waitFor();
  await capture(admin, 'tests-list');

  // ---- The student takes it, timed, and sees the number correct.
  const cam = await open();
  await signIn(cam, email('cam'));
  await cam.getByRole('heading', { name: title }).waitFor();
  await capture(cam, 'student-home');
  await cam.getByRole('button', { name: 'Start test' }).click();
  const times = [];
  await takeIt(cam, async (page) => {
    times.push(await page.locator('dt:text-is("Time") + dd').textContent().catch(() => null));
  });
  expect(times.length === 4 && times.every((t) => t && t !== 'Untimed'), `student: the timed test ran untimed (${times.join(', ')})`);
  await cam.getByText("This test is your academy's own, so it has no SAT scaled score.").waitFor();
  await capture(cam, 'student-results');
  await cam.getByRole('link', { name: 'insat home' }).click();
  await cam.getByText('Correct', { exact: true }).first().waitFor();
  await capture(cam, 'student-home-done');

  // ---- The admin sees it as the number correct too.
  await admin.getByRole('button', { name: 'Progress', exact: true }).first().click();
  await admin.getByText(title).first().click();
  const detail = admin.getByRole('dialog');
  await detail.getByText('Correct', { exact: true }).first().waitFor();
  expect(!(await detail.getByText(/scaled/).count()), 'admin: a custom test result shows a scaled score');
  await capture(admin, 'admin-result');

  // ---- Its questions stay in its own bank.
  const own = (await query('SELECT content_hash, source FROM pa_items WHERE institution_id = $1', [lakeside])).rows;
  expect(own.length >= 11, `bank: the academy's bank holds ${own.length} questions, fewer than its test`);
  expect(own.every((r) => ['ai-generated', 'extracted-from-upload', 'manual'].includes(r.source)), 'bank: the academy holds a question it did not make');
  const leaked = (await query(
    `SELECT count(*)::int AS n FROM pa_items i JOIN pa_institutions t ON t.id = i.institution_id
      WHERE t.slug = ANY($1::text[]) AND i.content_hash = ANY($2::text[])`,
    [[POOL_SLUG, GLOBAL_POOL_SLUG], own.map((r) => r.content_hash)],
  )).rows[0].n;
  expect(leaked === 0, `privacy: ${leaked} of the academy's questions reached a shared pool`);
  expect(await asked(admin, 'GET', '/api/admin/bank/meta') === 200, 'api: a managed academy cannot read its own bank');

  // ---- A self-guided institution makes no such tests and has no AI settings.
  const other = await open();
  await signIn(other, email('other'));
  await other.getByRole('button', { name: 'Add student' }).waitFor();
  for (const [method, endpoint, body] of [
    ['POST', '/api/admin/exams/from-ai', { title: 'x', section: 'rw', domain: 'craft-structure', n: 1 }],
    ['POST', '/api/admin/exams/from-upload'],
    ['GET', '/api/admin/settings/llm-key'],
    ['GET', '/api/admin/bank/meta'],
    ['POST', '/api/admin/bank/generate', { section: 'rw', domain: 'craft-structure' }],
  ]) {
    expect(await asked(other, method, endpoint, body) === 403, `api: a self-guided admin reached ${method} ${endpoint}`);
  }
  await other.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await other.getByText('Branding').waitFor();
  expect(!(await other.getByText('AI provider & API key').count()), 'admin: a self-guided institution shows AI settings');
  await capture(other, 'self-guided-settings');

  console.log(`${shot} screens in ${output}`);
  console.log(problems.length ? `${problems.length} problems:\n  ${problems.join('\n  ')}` : 'custom tests work end to end; no page errors, failed calls or overflow');
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  const file = path.join(output, 'failure.png');
  await current?.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.error(`stopped: ${e.message.split('\n')[0]}\n  at ${current?.url()}, photographed in ${file}`);
  if (problems.length) console.error(`problems so far:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  for (const name of [academy, otherSchool]) {
    const { rows } = await query('SELECT id FROM pa_institutions WHERE name = $1', [name]);
    for (const { id } of rows) {
      await query('DELETE FROM pa_sessions WHERE institution_id = $1', [id]);
      await query('DELETE FROM pa_institutions WHERE id = $1', [id]);
    }
  }
  fs.rmSync(clientBuild, { recursive: true, force: true });
  await pool.end();
}
