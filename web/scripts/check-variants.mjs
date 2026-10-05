// Real browser + database check of the variation engine's questions, on the
// emulators. Requires the local API and client (./start.sh), and a batch from
// `npm run pool:vary`.
//   From web: npm run check:variants -- ../exports/variants-2026-09-30
//
// In an isolated institution holding a set of source questions and their
// variants, a student practises one skill twice. The check proves that
// variants are served and answered through the real UI (choices shuffled),
// that a set never holds a question and its variant together, that a second
// set draws questions from lineages the student has not met before reusing a
// familiar one, and that every served question renders without a KaTeX error
// in the runner and in the explanation after it. Screenshots go to
// .logs/variants-e2e/. Everything it creates is removed afterwards.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  COL, bankOf, call, close, getMany, importRows, makeAccount, makeInstitution, removeAccount, removeInstitution, stored,
} from './fixtures.mjs';

const batchDirectory = path.resolve(process.argv[2] || '../exports/variants');
const skill = process.env.E2E_SKILL || 'Linear equations in one variable';
const sourceCount = Number(process.env.E2E_SOURCES || 12);
const output = path.resolve(process.env.E2E_OUTPUT || '../.logs/variants-e2e');
// The client, which serves the API on its own origin (the Vite proxy).
const origin = process.env.E2E_CLIENT_URL || 'http://127.0.0.1:5180';
const apiOrigin = `${origin}/api`;
fs.mkdirSync(output, { recursive: true });
const users = [];
const institutions = [];
const errors = [];
const evidence = {};
let browser;
let page;
let learner;

async function student(institutionId) {
  const account = await makeAccount({
    email: `variants-${crypto.randomUUID()}@example.test`, password: crypto.randomBytes(24).toString('base64url'),
    role: 'student', institutionId, name: 'Variant check',
  });
  users.push(account.id);
  return account;
}

async function login(account) {
  learner = account;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('response', (r) => { if (r.url().startsWith(apiOrigin) && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${origin}/sign-in`);
  await page.locator('input[type=email]').fill(account.email);
  await page.locator('input[type=password]').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
}

const served = (s) => s.form.sections.flatMap((sec) => sec.modules.flatMap((m) => m.questions || m.variants[s.routing[sec.kind]]));

/** Start a one-skill practice set from the dashboard, as a student does. */
async function practiceSkill() {
  await page.getByRole('tab', { name: 'Math', exact: true }).click();
  await page.getByRole('checkbox', { name: new RegExp(`^${skill}`) }).click();
  const pending = page.waitForResponse((r) => r.url().endsWith('/api/student/practice') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Practice selected', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  const s = await response.json();
  for (const secret of ['correctIdx', 'answerText', 'rationale']) assert.ok(!JSON.stringify(s.form).includes(`"${secret}"`), `${secret} leaked to the browser`);
  return s;
}

/** Answer every question correctly through the UI, screenshotting the variants. */
async function answerAll(session, lineage, label) {
  const data = await stored(session.sessionId);
  const shots = [];
  for (const section of data.form.sections) {
    await page.getByRole('heading', { name: section.name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const questions = section.modules[0].questions;
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      await page.getByRole('button', { name: `Question ${i + 1} of ${questions.length}`, exact: true }).waitFor();
      assert.equal(await page.locator('.katex-error').count(), 0, `KaTeX error in question ${i + 1}`);
      if (lineage.isVariant(q.itemId) && shots.length < 3) {
        const file = `${label}-question-${i + 1}.png`;
        await page.screenshot({ path: path.join(output, file), fullPage: true, animations: 'disabled' });
        shots.push(file);
      }
      if (q.answerType === 'grid-in') await page.getByPlaceholder('Your answer').fill(q.answerText);
      else await page.locator(`button:has(> span:text-is("${'ABCD'[q.correctIdx]}"))`).click();
      if (i < questions.length - 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    const pending = page.waitForResponse((r) => /\/(finish|state)$/.test(r.url()) && ['POST', 'PATCH'].includes(r.request().method()));
    await page.getByRole('button', { name: 'Submit module', exact: true }).click();
    assert.equal((await pending).status(), 200);
  }
  await page.getByText('Click any question to see what went wrong.').waitFor();
  return shots;
}

/** Open the explanation of the first served variant and check how it renders. */
async function reviewVariant(questions, lineage, label) {
  const index = questions.findIndex((q) => lineage.isVariant(q.itemId));
  assert.ok(index >= 0, 'a variant was served');
  await page.getByRole('button', { name: String(index + 1), exact: true }).first().click();
  await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
  assert.equal(await page.locator('.katex-error').count(), 0, 'KaTeX error in the explanation');
  const file = `${label}-explanation.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return file;
}

try {
  const records = fs.readFileSync(path.join(batchDirectory, 'questions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  // Sources of one skill with at least two variants each, and those variants.
  const bySource = new Map();
  for (const r of records) if (r.skill === skill && r.sourceSkill === skill) (bySource.get(r.variant_of) || bySource.set(r.variant_of, []).get(r.variant_of)).push(r);
  const picked = [...bySource.entries()].filter(([, vs]) => vs.length >= 2).slice(0, sourceCount);
  assert.ok(picked.length >= 11, `need at least 11 varied ${skill} sources, have ${picked.length}`);

  // The fixture institution draws on its own bank, not on insat's pool
  // (functions/lib/pool.js), so the check knows every question it can be served.
  const inst = await makeInstitution({ name: 'Temporary variant check', ownBank: true });
  institutions.push(inst);
  // Copy each source into the fixture institution, then its variants linked to the copy.
  const sourceIds = picked.map(([id]) => id);
  const sources = [...(await getMany(COL.items, sourceIds)).values()];
  const copy = new Map();
  for (const s of sources) {
    let added = null;
    const res = await importRows([{ ...s, image: null, png: null, svg: null, variant_of: null }], inst, { nearDuplicates: 'allow', onAdded: (r) => { added = r; } });
    assert.equal(res.added, 1);
    copy.set(s.id, added.id);
  }
  const variants = picked.flatMap(([id, vs]) => vs.map((v) => ({ ...v, variant_of: copy.get(id) })));
  const added = await importRows(variants, inst, { nearDuplicates: 'allow' });
  assert.equal(added.added, variants.length);
  const bank = await bankOf(inst);
  const lineageOf = new Map(bank.map((r) => [r.id, r.variant_of || r.id]));
  const lineage = { of: (id) => lineageOf.get(id) || id, isVariant: (id) => Boolean(bank.find((r) => r.id === id)?.variant_of) };

  browser = await chromium.launch({ headless: true });
  await login(await student(inst));

  // First set: every question from a different lineage.
  const first = await practiceSkill();
  const firstQs = served(await stored(first.sessionId));
  assert.equal(firstQs.length, 10);
  const firstLineages = firstQs.map((q) => lineage.of(q.itemId));
  assert.equal(new Set(firstLineages).size, firstQs.length, 'a question and its variant in one set');
  const shots1 = await answerAll(first, lineage, 'set1');
  const result1 = (await call(origin, learner, 'GET', `/api/student/sessions/${first.sessionId}/results`)).results;
  assert.equal(result1.totalCorrect, 10, 'every keyed answer, entered through the UI, is scored correct');
  const review1 = await reviewVariant(firstQs, lineage, 'set1');
  await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();

  // Second set: no repeats, no lineage twice, and the lineages not yet met come first.
  const second = await practiceSkill();
  const secondQs = served(await stored(second.sessionId));
  const seenItems = new Set(firstQs.map((q) => q.itemId));
  assert.ok(secondQs.every((q) => !seenItems.has(q.itemId)), 'a question served twice');
  const secondLineages = secondQs.map((q) => lineage.of(q.itemId));
  assert.equal(new Set(secondLineages).size, secondQs.length, 'a question and its variant in one set');
  const fresh = [...new Set(bank.map((r) => r.variant_of || r.id))].filter((l) => !firstLineages.includes(l));
  assert.ok(fresh.every((l) => secondLineages.includes(l)), 'an unmet lineage was passed over for a familiar one');
  const shots2 = await answerAll(second, lineage, 'set2');
  const review2 = await reviewVariant(secondQs, lineage, 'set2');

  // Phone width: the runner stays within the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: String(1), exact: true }).first().click();
  await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await page.screenshot({ path: path.join(output, 'explanation-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px on a phone`);

  assert.deepEqual(errors, []);
  Object.assign(evidence, {
    skill,
    sources: picked.length,
    variants: variants.length,
    firstSet: { questions: firstQs.length, variants: firstQs.filter((q) => lineage.isVariant(q.itemId)).length, lineages: new Set(firstLineages).size, correct: result1.totalCorrect },
    secondSet: { questions: secondQs.length, variants: secondQs.filter((q) => lineage.isVariant(q.itemId)).length, lineages: new Set(secondLineages).size, freshLineagesServed: fresh.length, repeats: 0 },
    screenshots: [...shots1, review1, ...shots2, review2, 'explanation-mobile.png'],
    errors,
  });
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (err) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-1500));
  }
  throw err;
} finally {
  await browser?.close();
  for (const id of users) await removeAccount(id);
  for (const id of institutions) await removeInstitution(id);
  await close();
}
