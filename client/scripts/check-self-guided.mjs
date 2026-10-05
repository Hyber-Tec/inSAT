// Real browser + database check. Requires the local API/client and a prepared batch.
// From client: npm run check:self-guided -- ../exports/verified-practice-2026-09-30
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { query, pool } from '../../server/lib/db.js';
import { hashPassword } from '../../server/lib/auth.js';
import { importTemplateRows } from '../../server/lib/templateItems.js';

const batchDirectory = path.resolve(process.argv[2] || '../exports/verified-practice-2026-09-30');
const output = path.resolve(process.env.E2E_OUTPUT || '../.logs/self-guided-e2e');
const origin = process.env.E2E_CLIENT_URL || 'http://127.0.0.1:5174';
const apiOrigin = process.env.E2E_API_URL || 'http://localhost:3002';
fs.mkdirSync(output, { recursive: true });
const users = [], institutions = [], errors = [], evidence = {};
let browser, page;

async function student(institutionId) {
  const email = `self-guided-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomBytes(24).toString('base64url');
  const { rows } = await query("INSERT INTO pa_users(email,password_hash,display_name,role,institution_id,must_change_password) VALUES($1,$2,'Practice check','student',$3,false) RETURNING id", [email, await hashPassword(password), institutionId]);
  users.push(rows[0].id);
  return { ...rows[0], email, password };
}
async function login(account) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (r) => { if (r.url().startsWith(apiOrigin) && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${origin}/sign-in`);
  await page.locator('input[type=email]').fill(account.email);
  await page.locator('input[type=password]').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
}
async function api(endpoint, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${localStorage.getItem('satify_token')}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  }, { url: `${apiOrigin}/api/student/${endpoint}`, method, body });
}
async function stored(id) {
  return (await query('SELECT * FROM pa_sessions WHERE id=$1', [id])).rows[0];
}
const served = (s) => s.form.sections.flatMap((sec) => sec.modules.flatMap((m) => m.questions || m.variants[s.routing[sec.kind]]));
async function startPractice(button) {
  const pending = page.waitForResponse((r) => r.url().endsWith('/api/student/practice') && r.request().method() === 'POST');
  await button.click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const s = await response.json();
  assert.ok(s.sessionId);
  assert.equal(s.practice.short.length, 0);
  const text = JSON.stringify(s.form);
  for (const secret of ['correctIdx', 'answerText', 'rationale']) assert.ok(!text.includes(`"${secret}"`));
  return s;
}
async function answerModule(count, { correct = false, questions = [], screenshot = null } = {}) {
  for (let i = 0; i < count; i++) {
    await page.getByRole('button', { name: `Question ${i + 1} of ${count}`, exact: true }).waitFor();
    if (await page.getByPlaceholder('Your answer').count()) {
      await page.getByPlaceholder('Your answer').fill(correct ? questions[i].answerText : '0');
    } else {
      const letter = correct ? 'ABCD'[questions[i].correctIdx] : 'A';
      await page.locator(`button:has(> span:text-is("${letter}"))`).click();
    }
    if (i === 0 && screenshot) {
      await page.screenshot({ path: path.join(output, `${screenshot}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await page.locator('.katex-error').count(), 0);
    }
    if (i < count - 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
}
async function submit(suffix) {
  const pending = page.waitForResponse((r) => r.url().endsWith(suffix) && ['POST', 'PATCH'].includes(r.request().method()));
  await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  const r = await pending; assert.equal(r.status(), 200); return r.json();
}
async function completeSkillSet(session, correct = false) {
  const data = await stored(session.sessionId);
  for (const section of data.form.sections) {
    await page.getByRole('heading', { name: section.name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const questions = section.modules[0].questions;
    await answerModule(questions.length, { correct, questions });
    await submit(section === data.form.sections.at(-1) ? '/finish' : '/state');
  }
  await page.getByText('Click any question to see what went wrong.').waitFor();
  const completed = await stored(session.sessionId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.total_scaled, null, 'skill sets must not produce SAT scaled scores');
  return completed;
}

try {
  const institution = (await query("SELECT id FROM pa_institutions WHERE slug='satify'")).rows[0];
  assert.ok(institution, 'the default institution (slug satify) must exist');
  browser = await chromium.launch({ headless: true });
  const learner = await student(institution.id);
  await login(learner);
  const initial = await api('profile'); assert.equal(initial.skills.length, 29); assert.equal(initial.answered, 0);
  const diagnostic = await startPractice(page.getByRole('button', { name: 'Start a full practice test', exact: true }));
  assert.equal(diagnostic.practice.questionCount, 98);
  for (let sec = 0; sec < 2; sec++) {
    for (let mod = 0; mod < 2; mod++) {
      await page.getByRole('button', { name: `Start Module ${mod + 1}`, exact: true }).click();
      await answerModule(sec === 0 ? 27 : 22, { screenshot: mod === 0 ? `${sec ? 'math' : 'reading'}-question` : null });
      const response = await submit(mod === 0 ? '/route' : sec === 1 ? '/finish' : '/state');
      if (mod === 0) assert.equal(response.routing, 'easy');
      console.log(`Completed diagnostic section ${sec + 1}, module ${mod + 1}`);
    }
    if (sec === 0) await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await page.getByText('Click any question to see what went wrong.').waitFor();
  await page.screenshot({ path: path.join(output, 'diagnostic-results.png'), fullPage: true, animations: 'disabled' });
  const result = (await api(`sessions/${diagnostic.sessionId}/results`)).results;
  assert.equal(result.totalQuestions, 98);
  assert.ok(result.sections.every((s) => s.questions.every((q) => q.skill && q.rationale.correct)));
  await page.getByRole('button', { name: '1', exact: true }).first().click();
  await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'explanation.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
  await page.getByRole('heading', { name: /Practice your weakest/ }).waitFor();
  const profile = await api('profile'); assert.equal(profile.answered, 98); assert.ok(profile.recommended.length);
  await page.screenshot({ path: path.join(output, 'recommendations.png'), fullPage: true, animations: 'disabled' });
  const followup = await startPractice(page.getByRole('button', { name: /^Practice (these \d+ skills|this skill)$/ }));
  assert.deepEqual(followup.practice.skills, profile.recommended);
  const first = served(await stored(diagnostic.sessionId)), next = served(await stored(followup.sessionId));
  const seen = new Set(first.map((q) => q.itemId));
  assert.ok(next.every((q) => !seen.has(q.itemId)));
  assert.ok(next.every((q) => profile.recommended.includes(q.skill)));
  await completeSkillSet(followup);
  assert.equal((await api('profile')).answered, 98 + next.length);
  evidence.diagnostic = { questions: 98, routing: result.routing, recommended: profile.recommended, followupQuestions: next.length, repeatedQuestions: 0, followupCompleted: true };

  // A second learner with only the new batch proves those exact questions can
  // be served, answered correctly after shuffling, scored, and reviewed.
  const records = fs.readFileSync(path.join(batchDirectory, 'questions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  // Its institution draws on its own bank, which holds the batch alone, not on
  // insat's pool (server/lib/pool.js).
  const { rows: fixture } = await query("INSERT INTO pa_institutions(name,slug) VALUES('Temporary practice check',$1) RETURNING id", [`qa-${crypto.randomUUID()}`]);
  const fixtureId = fixture[0].id; institutions.push(fixtureId);
  await query('UPDATE pa_institutions SET pool_institution_id = id WHERE id = $1', [fixtureId]);
  const imported = await importTemplateRows(records, fixtureId); assert.equal(imported.added, records.length);
  await page.context().close();
  await login(await student(fixtureId));
  await page.getByRole('tab', { name: 'Math', exact: true }).click();
  await page.getByRole('radio', { name: 'Easy', exact: true }).click();
  const skill = records[0].skill;
  await page.getByRole('checkbox', { name: new RegExp(`^${skill}`) }).click();
  const practice = await startPractice(page.getByRole('button', { name: 'Practice selected', exact: true }));
  const fresh = await stored(practice.sessionId);
  const freshItems = served(fresh);
  assert.equal(freshItems.length, 10);
  const batchHashes = new Set(records.map((r) => r.content_hash));
  const bank = (await query('SELECT id,content_hash FROM pa_items WHERE institution_id=$1', [fixtureId])).rows;
  const byId = new Map(bank.map((r) => [r.id, r.content_hash]));
  assert.ok(freshItems.every((q) => batchHashes.has(byId.get(q.itemId))));
  await completeSkillSet(practice, true);
  const freshResult = (await api(`sessions/${practice.sessionId}/results`)).results;
  assert.equal(freshResult.totalCorrect, 10);
  assert.equal(freshResult.totalScaled, null);
  await page.screenshot({ path: path.join(output, 'fresh-batch-results.png'), fullPage: true, animations: 'disabled' });
  evidence.freshBatch = { generated: records.length, verified: records.filter((r) => r.verified).length, served: 10, correct: 10, classifiedSkill: skill };

  // Strong performance must select the hard adaptive route as well.
  await page.context().close(); await login(await student(institution.id));
  const hardTest = await api('practice', 'POST', { mode: 'math', timed: false });
  const hardStored = await stored(hardTest.sessionId);
  const module1 = hardStored.form.sections[0].modules[0].questions;
  const answers = Object.fromEntries(module1.map((q) => [q.qid, q.answerType === 'grid-in' ? q.answerText : q.correctIdx]));
  const hard = await api(`sessions/${hardTest.sessionId}/route`, 'POST', { sectionKind: 'math', state: { answers } });
  assert.equal(hard.routing, 'hard'); evidence.hardRoute = true;

  // Mobile reading questions must remain readable without horizontal scrolling.
  await page.reload(); await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
  await page.getByRole('checkbox', { name: /^Transitions/ }).click();
  await startPractice(page.getByRole('button', { name: 'Practice selected', exact: true }));
  await page.getByRole('heading', { name: 'Reading and Writing', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const passage = document.querySelector('.pa-exam-passage').getBoundingClientRect();
    const question = document.querySelector('.pa-exam-question').getBoundingClientRect();
    return { width: innerWidth, scroll: document.documentElement.scrollWidth, stacked: question.top >= passage.bottom - 1 };
  });
  assert.equal(layout.scroll, layout.width); assert.ok(layout.stacked);
  await page.screenshot({ path: path.join(output, 'reading-mobile.png'), fullPage: true, animations: 'disabled' });
  evidence.mobile = layout;
  assert.deepEqual(errors, []);
  evidence.errors = errors;
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (err) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw err;
} finally {
  await browser?.close();
  for (const id of users) await query('DELETE FROM pa_users WHERE id=$1', [id]);
  for (const id of institutions) await query('DELETE FROM pa_institutions WHERE id=$1', [id]);
  await pool.end();
}
