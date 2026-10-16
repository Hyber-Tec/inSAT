// End-to-end check of the AI assistant, driven in a real browser. It runs its
// own API on :3014, with the AI provider mocked by mock-llm.mjs (the answer
// says back the screen and question it was sent, so what the AI saw can be
// checked), and its own build of the client on :5186 against it; the database
// is the local emulators (`./start.sh` brings them up).
//
//   From web: npm run check:assistant
//
// A self-guided academy with its own bank (math questions with a figure):
// before it has an AI key its student is not offered the assistant and its
// admin is led to Settings to add one. Then the admin asks about Settings; the
// student asks on the dashboard (answers stream in, math set as math, a price
// left a price, follow-ups keep the conversation, an answer can be stopped, a
// chat started over), finds no assistant in the test runner, and asks about a
// reviewed question beside it: the AI is sent the question and its figure,
// the arrow keys stay in the box, Escape closes only the assistant, and the
// conversation goes on in the corner when the review closes. The same on a
// phone. Asked directly: an assigned test in progress turns it off until it
// is left, a day's messages run out, an admin can turn it off for students,
// and the platform owner has none. Every screen is checked for page errors,
// failed API calls and content wider than a phone; screenshots go to
// .logs/screens/assistant/. Everything it made is removed.

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  COL, ask, call, close, getRow, importRows, institutionsNamed, makeAccount, makeInstitution, removeAccount, removeInstitution,
} from './fixtures.mjs';
import { DISPLAY, INLINE, prepare } from '../src/assistant/prepare.js';

const { contentHash } = await import('../../functions/lib/items.js');
const { col, now } = await import('../../functions/lib/store.js');

const API_PORT = 3014;
const CLIENT_PORT = 5186;
const DAILY_LIMIT = 40;
const apiUrl = `http://127.0.0.1:${API_PORT}`;
// The client, which serves the API on its own origin (vite preview's proxy).
const origin = `http://127.0.0.1:${CLIENT_PORT}`;
const apiOrigin = `${origin}/api`;
const logs = path.resolve('../.logs');
const output = path.join(logs, 'screens/assistant');
const clientBuild = path.join(logs, 'assistant-client');
// What the mocked AI was sent, a line of JSON per message (mock-llm.mjs).
const record = path.join(logs, 'assistant-requests.jsonl');
fs.rmSync(output, { recursive: true, force: true });
fs.rmSync(record, { force: true });
fs.mkdirSync(output, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const SKILL = 'Linear equations in one variable';
const tag = crypto.randomUUID().slice(0, 8);
const password = crypto.randomBytes(12).toString('base64url');
const email = (who) => `assistant-${who}-${tag}@example.test`;
const account = (who) => ({ email: email(who), password });
const academy = `Harbor Prep ${tag}`;
const problems = [];
const children = [];
const extraAccounts = [];
let shot = 0;
let browser;
let current;

const expect = (ok, message) => { if (!ok) problems.push(message); };

/** Start a process and wait until `url` answers. */
async function serve(name, command, args, { cwd, env, url }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(logs, `assistant-${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited; see .logs/assistant-${name}.log`);
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
  page.on('response', (r) => { if (r.url().startsWith(apiOrigin) && r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(origin, '')}`); });
  return page;
}

async function capture(page, name, { full = true } = {}) {
  await page.waitForTimeout(300); // let entry animations settle
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) problems.push(`${name}: page wider than the screen by ${over}px`);
  shot += 1;
  await page.screenshot({ path: path.join(output, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: full, animations: 'disabled' });
}

async function signIn(page, who) {
  await page.goto(`${origin}/sign-in`);
  await page.locator('input[type=email]').fill(email(who));
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Asked from here as `who`, so an expected refusal is not counted as a failed call of the page. */
const asked = (who, method, endpoint, body) => ask(origin, account(who), method, endpoint, body);
const statusOf = async (who) => (await asked(who, 'GET', '/api/assistant/status')).body;

const launcher = (page) => page.getByRole('button', { name: 'Ask AI', exact: true });
const panelOf = (page) => page.getByRole('dialog', { name: 'AI assistant' });
const box = (scope) => scope.getByRole('textbox', { name: 'Message the AI assistant' });
const ENDING = 'A price of $5 stays a price.';

/** What the AI was sent with the latest message: { system, title, screen, question, history, figures }. */
const lastSent = () => JSON.parse(fs.readFileSync(record, 'utf8').trim().split('\n').at(-1));

/** Wait for the `n`th answer in `scope` to have come in whole, and check how it reads. */
async function answered(scope, n, { asked: question, sees }) {
  await scope.getByText(ENDING).nth(n - 1).waitFor({ timeout: 20000 });
  await scope.getByRole('button', { name: 'Send' }).waitFor();
  const text = await scope.innerText();
  if (question) expect(text.includes(`You asked: "${question}"`), `answer ${n}: did not say back "${question}"`);
  if (sees) expect((await scope.locator('strong', { hasText: sees }).count()) > 0, `answer ${n}: the AI was not sent the screen "${sees}"`);
  expect((await scope.locator('.katex').count()) >= 2 * n, `answer ${n}: its math was not set as math`);
  expect(!/\\\(|\\\[/.test(text), `answer ${n}: raw LaTeX delimiters on the page`);
  return text;
}

// A math question of the academy's own (answer at `i % 4`), with a figure.
const FIGURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 150" width="240" height="150"><rect width="240" height="150" fill="#fff"/><path d="M20 130 L220 20" stroke="#394447" stroke-width="3" fill="none"/><text x="26" y="34" font-size="15" font-family="sans-serif">y = 2x + 1</text></svg>';
function question(i) {
  const a = 2 + (i % 5);
  const b = 1 + (i % 4);
  const x = 3 + i;
  const at = i % 4;
  const wrong = [x - 2, x - 1, x + 1].map(String);
  const choices = [...wrong.slice(0, at), String(x), ...wrong.slice(at)];
  const text = `The line in the figure is one of several. If \\(${a}x + ${b} = ${a * x + b}\\), what is the value of \\(x\\)? (Set ${tag}, no. ${i + 1})`;
  return {
    content_hash: contentHash({ section: 'math', question: text, choices, passage: null }),
    section: 'math', domain: 'algebra', skill: SKILL, difficulty: ['easy', 'medium', 'hard'][i % 3],
    passage: null, question: text, choices, correct_idx: at, answer_type: 'multiple-choice',
    rationale: { correct: `Subtract ${b} from both sides, then divide both sides by ${a}: \\(x = ${x}\\).` },
    figure: null, svg: FIGURE, source: 'original', verified: true, realism: 4,
  };
}

/** Take the practice set that is open: answer B everywhere, through every module. */
async function takeIt(page) {
  const results = page.getByText('Click any question to see what went wrong.');
  for (let modules = 0; modules < 4; modules += 1) {
    const start = page.getByRole('button', { name: /^Start( Module \d)?$/ });
    await start.or(results).first().waitFor();
    if (await results.isVisible()) return;
    expect(!(await launcher(page).count()), 'runner: the assistant is offered before a module');
    await start.first().click();
    const nav = page.getByRole('button', { name: /^Question 1 of \d+$/ });
    await nav.waitFor();
    expect(!(await launcher(page).count()), 'runner: the assistant is offered during a practice set');
    const count = Number((await nav.textContent()).match(/of (\d+)/)[1]);
    for (let i = 1; i <= count; i += 1) {
      await page.locator('button:has(> span:text-is("B"))').first().click();
      if (i < count) await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  }
  throw new Error('the practice set did not reach its results');
}

const addUser = (role, who, institutionId, name) => makeAccount({ email: email(who), password, role, institutionId, name });

// ---- An answer's text as markdown gets it: math carried as code, money and code left alone.
{
  const same = (got, want, what) => expect(got === want, `prepare: ${what}: ${JSON.stringify(got)}`);
  same(prepare('Solve \\(2x = 6\\) for $5.'), `Solve \`${INLINE}2x = 6\` for $5.`, 'inline math beside a price');
  same(prepare('So \\[ y = 2x + 1 \\] holds.'), `So \`${DISPLAY}y = 2x + 1\` holds.`, 'display math');
  same(prepare('Both $$\\frac{1}{2}$$ and `\\(x\\)`'), `Both \`${DISPLAY}\\frac{1}{2}\` and \`\\(x\\)\``, 'dollars, and code as written');
  same(prepare('Now \\(\\frac{1}{', true), 'Now', 'a formula still coming waits');
  same(prepare('I can see **Dash', true), 'I can see **Dash**', 'a bold still coming is closed');
  same(prepare('I can see **Dash'), 'I can see **Dash', 'a whole answer is left as written');
}

try {
  // ---- A self-guided academy with its own bank, an admin and a student.
  const academyId = await makeInstitution({ name: academy, slug: `harbor-${tag}`, ownBank: true });
  const seeded = await importRows(Array.from({ length: 12 }, (_, i) => question(i)), academyId, { nearDuplicates: 'allow' });
  if (seeded.added !== 12) throw new Error(`seeded ${seeded.added} of 12 questions`);
  await addUser('admin', 'admin', academyId, 'Robin Admin');
  const dana = await addUser('student', 'dana', academyId, 'Dana Student');
  const owner = await makeAccount({ email: email('owner'), password, role: 'superadmin', name: 'Platform Owner' });
  extraAccounts.push(owner.id);

  // ---- Its own API, with the AI provider mocked, and a client built against
  // it (in its own mode, so no production setting reaches it).
  await serve('api', process.execPath, ['--import', path.resolve('scripts/mock-llm.mjs'), 'server.js'], {
    cwd: path.resolve('../functions'),
    env: {
      PORT: String(API_PORT), CLIENT_ORIGIN: origin, REQUIRE_INSTITUTION_KEY: 'true', ANTHROPIC_API_KEY: '',
      ASSISTANT_DAILY_LIMIT: String(DAILY_LIMIT), MOCK_LLM_RECORD: record,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
      FIREBASE_STORAGE_EMULATOR_HOST: process.env.FIREBASE_STORAGE_EMULATOR_HOST, METADATA_SERVER_DETECTION: 'none',
    },
    url: `${apiUrl}/api/health`,
  });
  const vite = path.resolve('node_modules/vite/bin/vite.js');
  const clientEnv = { ...process.env, VITE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST, VITE_API_PROXY: apiUrl };
  execFileSync(process.execPath, [vite, 'build', '--mode', 'e2e', '--outDir', clientBuild, '--emptyOutDir', '--logLevel', 'error'], {
    env: clientEnv, stdio: 'inherit',
  });
  await serve('client', process.execPath, [vite, 'preview', '--mode', 'e2e', '--outDir', clientBuild, '--port', String(CLIENT_PORT), '--strictPort', '--host', '127.0.0.1'], {
    env: clientEnv, url: `${origin}/`,
  });
  browser = await chromium.launch();

  // ---- No AI key yet: no assistant for the student; the admin is led to Settings.
  let page = await open();
  await signIn(page, 'dana');
  await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
  await page.waitForTimeout(500);
  expect(!(await launcher(page).count()), 'student: offered the assistant before the academy set up AI');
  expect((await asked('dana', 'POST', '/api/assistant/chat', { messages: [{ role: 'user', content: 'Hi' }] })).status === 409,
    'api: a student was answered before the academy set up AI');
  await page.context().close();

  const admin = await open();
  await signIn(admin, 'admin');
  await admin.getByRole('button', { name: 'Add student' }).waitFor();
  await launcher(admin).click();
  let panel = panelOf(admin);
  await panel.getByText("Add your academy's AI key in Settings to turn on the assistant.").waitFor();
  expect(!(await box(panel).count()), 'admin: the box to ask in shows before AI is set up');
  await capture(admin, 'admin-panel-no-key', { full: false });
  await panel.getByRole('button', { name: 'Open Settings' }).click();
  await admin.getByText('AI provider & API key').waitFor();
  expect(!(await panel.count()), 'admin: the panel stayed open on the way to Settings');
  await admin.getByText('Needs an AI key').waitFor();
  await admin.locator('#api-key').fill('sk-ant-mock-0000000000');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await admin.getByText('Saved', { exact: true }).waitFor();
  await admin.getByText(`Each person can send it up to ${DAILY_LIMIT} messages a day, on your AI key.`).waitFor();
  expect(await admin.getByRole('switch', { name: 'Students can ask AI' }).isChecked(), 'settings: students are not on by default');
  await capture(admin, 'admin-settings');

  // The admin asks about the screen they are on; a key typed into it is not sent.
  await admin.locator('#api-key').fill('sk-ant-typed-but-not-saved');
  await launcher(admin).click();
  panel = panelOf(admin);
  await panel.getByText('Sees: Settings').waitFor();
  await panel.getByRole('button', { name: 'What is the AI key used for?' }).click();
  await answered(panel, 1, { asked: 'What is the AI key used for?', sees: 'Settings' });
  let sent = lastSent();
  expect(sent.screen.includes('AI provider & API key') && sent.screen.includes('Students can ask AI'), 'settings: the AI was not sent the screen');
  expect(!sent.screen.includes('sk-ant-typed'), 'privacy: a key typed into Settings was sent to the AI');
  expect(sent.system.includes('Robin Admin runs Harbor Prep'), 'settings: the AI was not told who is asking');
  await capture(admin, 'admin-panel-answer', { full: false });
  await admin.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  expect(await launcher(admin).evaluate((el) => el === document.activeElement), 'panel: closing it did not hand focus back to its button');

  // ---- The student, on the dashboard: answers stream in and keep the conversation.
  page = await open();
  await signIn(page, 'dana');
  await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
  await launcher(page).waitFor();
  await capture(page, 'student-dashboard', { full: false });
  await launcher(page).click();
  panel = panelOf(page);
  await panel.getByText('Sees: Dashboard').waitFor();
  await capture(page, 'student-panel-welcome', { full: false });
  await panel.getByRole('button', { name: 'What should I practice next?' }).click();
  const first = await answered(panel, 1, { asked: 'What should I practice next?', sees: 'Dashboard' });
  sent = lastSent();
  expect(sent.title === 'Dashboard' && sent.screen.includes('# Start with a diagnostic test'), 'dashboard: the AI was not sent what the dashboard says');
  expect(sent.system.includes('Dana Student is a student of Harbor Prep'), 'dashboard: the AI was not told who is asking');
  expect(sent.figures.length === 0, 'dashboard: figures were sent from a screen without any');
  expect(first.includes('$5'), 'answer: a price was not left a price');
  await capture(page, 'student-panel-answer', { full: false });

  await box(panel).fill('And how long is the full test?');
  await box(panel).press('Enter');
  const second = await answered(panel, 2, { asked: 'And how long is the full test?' });
  expect(second.includes('Earlier messages in this chat: 2') && lastSent().history === 2, 'follow-up: the conversation so far was not sent');

  // A long answer can be stopped part way.
  await box(panel).fill('Explain the whole test slowly');
  await box(panel).press('Enter');
  await panel.getByText('You asked: "Explain the whole test slowly"').waitFor();
  await panel.getByRole('button', { name: 'Stop the answer' }).click();
  await panel.getByText('Stopped.').waitFor();
  expect((await panel.getByText(ENDING).count()) === 2, 'stop: the answer went on after it was stopped');
  await capture(page, 'student-panel-stopped', { full: false });
  await panel.getByRole('button', { name: 'New chat' }).click();
  await panel.getByText('Ask about what is on your screen').waitFor();
  await panel.getByRole('button', { name: 'Close' }).click();

  // ---- A practice set: no assistant in the runner; it comes back for the results.
  const set = await call(origin, account('dana'), 'POST', '/api/student/practice', { mode: 'skills', skills: [SKILL] });
  expect((await getRow(COL.sessions, set.sessionId))?.active_at instanceof Date, 'session: a new attempt has no active_at');
  await page.reload();
  await page.getByRole('button', { name: /Resume/ }).first().click();
  // The runner's first screen (the dashboard has a Start button of its own).
  await page.getByRole('button', { name: 'Back to dashboard' }).waitFor();
  await takeIt(page);
  await launcher(page).waitFor();
  await capture(page, 'results', { full: false });

  // A question's review: the assistant opens beside it and is sent the question and its figure.
  const firstQuestion = page.getByRole('button', { name: /^Question 1: (correct|incorrect|not answered)$/ });
  expect(await firstQuestion.count() === 1, 'results: the question grid does not say how each question went');
  await firstQuestion.click();
  // The review's name follows the question it shows.
  const review = page.getByRole('dialog', { name: /^Question \d+$/ });
  await review.waitFor();
  expect(!(await launcher(page).count()), 'review: the floating button shows over the review');
  await review.getByRole('button', { name: 'Ask AI about this question' }).click();
  const pane = review.getByRole('region', { name: 'AI assistant' });
  await pane.getByText('Sees: Math question 1').waitFor();
  expect(await review.locator('img[data-figure]').isVisible(), 'review: the question is not beside the assistant on a desktop');
  await pane.getByRole('button').filter({ hasText: /step by step|answer wrong|start this question/ }).first().click();
  await answered(pane, 1, { sees: 'Math question 1' });
  sent = lastSent();
  expect(sent.screen.includes('## Question 1') && sent.screen.includes('The line in the figure is one of several.'), 'review: the question was not sent');
  expect(/\\\(\d+x \+ \d+ = \d+\\\)/.test(sent.screen), 'review: the question\'s math was not sent as LaTeX');
  expect(sent.screen.includes('[Figure]') && sent.figures.length === 1 && sent.figures[0].media === 'image/png' && sent.figures[0].bytes > 1000,
    'review: the question\'s figure was not sent as a picture');
  expect(sent.screen.includes('--- Behind this dialog ---') && /\[Question 1: (correct|incorrect)\]/.test(sent.screen), 'review: the results behind the review were not sent');
  expect(!sent.screen.includes('Message the AI assistant'), 'review: the assistant itself was sent as part of the screen');
  await capture(page, 'review-assistant', { full: false });

  // The arrow keys stay in the box; the buttons still step through the questions.
  await box(pane).fill('ab');
  await box(pane).press('ArrowLeft');
  expect(await review.getByRole('heading', { name: 'Question 1' }).count() === 1, 'review: an arrow key in the box changed the question');
  await review.getByRole('button', { name: 'Next question' }).click();
  await pane.getByText('Sees: Math question 2').waitFor();
  // Escape in the assistant closes only the assistant.
  await box(pane).press('Escape');
  await pane.waitFor({ state: 'detached' });
  expect(await review.isVisible(), 'review: Escape in the assistant closed the review');
  await review.getByRole('button', { name: 'Ask AI about this question' }).click();
  await pane.waitFor();
  await review.getByRole('button', { name: 'Close', exact: true }).click();
  // On a desktop the conversation goes on in the corner.
  panel = panelOf(page);
  await panel.waitFor();
  expect(await panel.getByText('It has 1 figure.').count() === 1, 'review: the conversation did not carry over to the panel');
  await panel.getByText('Sees: Results').waitFor();
  await capture(page, 'results-panel-after-review', { full: false });
  await panel.getByRole('button', { name: 'Close' }).click();

  // ---- On a phone.
  const phone = await open(PHONE);
  await signIn(phone, 'dana');
  await phone.getByRole('button', { name: /Review/ }).first().waitFor();
  await launcher(phone).waitFor();
  await capture(phone, 'phone-dashboard', { full: false });
  await launcher(phone).click();
  panel = panelOf(phone);
  await panel.getByText('Sees: Dashboard').waitFor();
  const fits = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left === 0 && Math.round(r.width) === window.innerWidth && Math.round(r.bottom) <= window.innerHeight + 1;
  });
  expect(fits, 'phone: the panel does not fill the screen');
  await capture(phone, 'phone-panel', { full: false });
  await panel.getByRole('button', { name: 'Make me a study plan for the next two weeks' }).click();
  await answered(panel, 1, { asked: 'Make me a study plan for the next two weeks', sees: 'Dashboard' });
  await capture(phone, 'phone-panel-answer', { full: false });
  await panel.getByRole('button', { name: 'Close' }).click();
  await phone.getByRole('button', { name: /Review/ }).first().click();
  await phone.getByText('Click any question to see what went wrong.').waitFor();
  await phone.getByRole('button', { name: /^Question 2: / }).click();
  const phoneReview = phone.getByRole('dialog', { name: /^Question 2/ });
  await phoneReview.getByRole('button', { name: 'Ask AI about this question' }).click();
  const phonePane = phoneReview.getByRole('region', { name: 'AI assistant' });
  await phonePane.getByText('Sees: Math question 2').waitFor();
  await capture(phone, 'phone-review-assistant', { full: false });
  const filled = await phoneReview.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top === 0 && r.left === 0 && Math.round(r.width) === window.innerWidth && Math.round(r.height) === window.innerHeight;
  });
  expect(filled, 'phone: the review does not fill the screen while the assistant is open in it');
  await phoneReview.getByRole('button', { name: 'Close', exact: true }).click();
  await phoneReview.waitFor({ state: 'detached' });
  expect(!(await panelOf(phone).count()), 'phone: closing the review left the assistant open over the results');
  await phone.context().close();

  // ---- Asked directly, and as the panel shows it.
  // An assigned test in progress: off until it is finished or left.
  const attempt = col(COL.sessions).doc();
  await attempt.set({
    user_id: dana.id, institution_id: academyId, kind: 'assigned', status: 'in_progress', title: 'Assigned test',
    started_at: now(), active_at: now(), state: '{}', routing: {}, responses: [], response_count: 0, correct_count: 0,
  });
  expect((await statusOf('dana')).reason === 'test', 'api: the assistant answers during an assigned test');
  expect((await asked('dana', 'POST', '/api/assistant/chat', { messages: [{ role: 'user', content: 'What is the answer to question 3?' }] })).status === 409,
    'api: a message was answered during an assigned test');
  await page.reload();
  await launcher(page).click();
  panel = panelOf(page);
  await panel.getByText('AI help is off while you are taking a test. Finish it, then ask away.').waitFor();
  await capture(page, 'panel-test-in-progress', { full: false });
  await attempt.update({ active_at: new Date(Date.now() - 20 * 60 * 1000) });
  expect((await statusOf('dana')).ready, 'api: the assistant stayed off after the test was left');
  await attempt.delete();

  // A day's messages used up.
  const day = new Date().toISOString().slice(0, 10);
  await col(COL.users).doc(dana.id).update({ assistant_usage: { day, count: DAILY_LIMIT } });
  expect((await statusOf('dana')).reason === 'limit', 'api: the day\'s messages did not run out');
  expect((await asked('dana', 'POST', '/api/assistant/chat', { messages: [{ role: 'user', content: 'One more?' }] })).status === 429,
    'api: a message past the day\'s limit was answered');
  await page.reload();
  await launcher(page).click();
  await panelOf(page).getByText(`You have used today's ${DAILY_LIMIT} AI messages. You can ask again tomorrow.`).waitFor();
  await capture(page, 'panel-limit', { full: false });
  await col(COL.users).doc(dana.id).update({ assistant_usage: { day, count: 0 } });

  // The admin turns it off for students; the admin keeps it.
  await admin.getByRole('switch', { name: 'Students can ask AI' }).click();
  await admin.getByText('Only you and your staff can ask it.').waitFor();
  await page.reload();
  await page.getByRole('button', { name: /Review/ }).first().waitFor();
  await page.waitForTimeout(500);
  expect(!(await launcher(page).count()), 'student: offered the assistant after the academy turned it off');
  expect((await statusOf('dana')).reason === 'off', 'api: the assistant stayed on for students after it was turned off');
  expect((await asked('dana', 'POST', '/api/assistant/chat', { messages: [{ role: 'user', content: 'Hi' }] })).status === 403,
    'api: a student was answered after the academy turned it off');
  expect((await statusOf('admin')).ready, 'api: turning it off for students turned it off for the admin');
  await admin.getByRole('switch', { name: 'Students can ask AI' }).click();
  await admin.getByText('On for everyone in your academy.').waitFor();

  // The platform owner has no assistant.
  expect((await asked('owner', 'GET', '/api/assistant/status')).status === 403, 'api: the platform owner was offered the assistant');

  console.log(`${shot} screens in ${output}`);
  console.log(problems.length ? `${problems.length} problems:\n  ${problems.join('\n  ')}` : 'the AI assistant works end to end; no page errors, failed calls or overflow');
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
  for (const id of await institutionsNamed(academy)) await removeInstitution(id);
  for (const id of extraAccounts) await removeAccount(id);
  fs.rmSync(clientBuild, { recursive: true, force: true });
  await close();
}
