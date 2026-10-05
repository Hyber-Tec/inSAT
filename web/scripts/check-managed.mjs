// End-to-end check of an institution-managed academy, driven in a real browser
// the way its people use it. Requires the local API and client (`./start.sh`),
// on the emulators.
//
//   From web: npm run check:managed
//
// A temporary platform owner creates a managed academy and its admin. The
// admin adds two students, makes a group, creates a Full SAT (drawn from
// insat's question pool, which a new academy shares from its first day),
// locks and unlocks it, and assigns it to one student and the group. The
// student takes it; the admin opens that student's page and assigns practice on their
// weakest skills; the student does the practice (and is offered no practice
// of their own); the admin sees both results. The guards are asked directly:
// a managed student cannot start practice, and once the owner makes the
// academy self-guided again its admin loses groups and tests. Every screen is
// checked for page errors, failed API calls and content wider than a phone;
// screenshots go to .logs/screens/managed/. Everything it made is removed.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ask, close, institutionsNamed, makeAccount, removeAccount, removeInstitution,
} from './fixtures.mjs';

// The client, which serves the API on its own origin (the Vite proxy).
const origin = process.env.E2E_CLIENT_URL || 'http://127.0.0.1:5180';
const apiOrigin = `${origin}/api`;
const output = path.resolve('../.logs/screens/managed');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const tag = crypto.randomUUID().slice(0, 8);
const password = crypto.randomBytes(12).toString('base64url');
const email = (who) => `managed-${who}-${tag}@example.test`;
const academy = `Northside Prep ${tag}`;
const problems = [];
let shot = 0;
let browser;
let current;
let ownerId = null;

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

const expect = (ok, message) => { if (!ok) problems.push(message); };

/** Take whatever test or practice set is open: answer A where there is an A, through every module and break. */
async function takeIt(page) {
  const results = page.getByText('Click any question to see what went wrong.');
  const breakTime = page.getByRole('button', { name: 'Continue', exact: true });
  for (let modules = 0; modules < 8; modules += 1) {
    const start = page.getByRole('button', { name: /^Start( Module \d)?$/ });
    await start.or(results).or(breakTime).first().waitFor();
    if (await results.isVisible()) return;
    if (await breakTime.isVisible()) { await breakTime.click(); continue; }
    await start.first().click();
    const nav = page.getByRole('button', { name: /^Question 1 of \d+$/ });
    await nav.waitFor();
    const count = Number((await nav.textContent()).match(/of (\d+)/)[1]);
    for (let i = 1; i <= count; i += 1) {
      const a = page.locator('button:has(> span:text-is("A"))').first();
      if (await a.isVisible().catch(() => false)) await a.click();
      if (i < count) await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  }
  throw new Error('the test did not reach its results');
}

/** Asked from here as `who`, so an expected refusal is not counted as a failed call of the page. */
async function asked(who, method, endpoint, body) {
  return (await ask(origin, { email: email(who), password }, method, endpoint, body)).status;
}

try {
  ownerId = (await makeAccount({ email: email('owner'), password, role: 'superadmin', name: 'Platform Owner' })).id;
  browser = await chromium.launch();

  // ---- The platform owner creates a managed academy and its admin.
  const owner = await open();
  await signIn(owner, email('owner'));
  await owner.getByRole('button', { name: /New institution/ }).click();
  await owner.locator('#inst-name').fill(academy);
  await owner.getByRole('radio', { name: /^Institution-managed/ }).click();
  await owner.locator('#inst-admin-name').fill('Dana Admin');
  await owner.locator('#inst-admin-email').fill(email('admin'));
  await owner.locator('#inst-admin-password').fill(password);
  await capture(owner, 'owner-new-institution', { full: false });
  await owner.getByRole('button', { name: 'Create institution' }).click();
  await owner.getByText(`${academy} is ready`).waitFor();
  await capture(owner, 'owner-institutions');
  expect(await owner.getByText('Institution-managed', { exact: true }).first().isVisible(), 'owner: the new academy does not show as institution-managed');

  // ---- Its admin: students, a group, a test, assignments.
  const admin = await open();
  await signIn(admin, email('admin'));
  await admin.getByRole('button', { name: 'Add student' }).waitFor();
  for (const label of ['Groups', 'Tests', 'Assignments', 'Progress']) {
    expect(await admin.getByRole('button', { name: label, exact: true }).first().isVisible(), `admin: no ${label} section in a managed academy`);
  }
  for (const [name, who] of [['Ana Lopez', 'ana'], ['Ben Ortiz', 'ben']]) {
    await admin.getByRole('button', { name: 'Add student' }).click();
    await admin.getByRole('tab', { name: 'Set password' }).click();
    await admin.locator('#student-name').fill(name);
    await admin.locator('#student-email').fill(email(who));
    await admin.locator('#student-password').fill(password);
    await admin.getByRole('button', { name: 'Create student' }).click();
    await admin.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await admin.getByText('2 students').waitFor();

  await admin.getByRole('button', { name: 'Groups', exact: true }).first().click();
  await admin.getByRole('button', { name: 'New group' }).click();
  await admin.locator('#group-name').fill('Period 1');
  await admin.getByRole('button', { name: 'Create group' }).click();
  await admin.getByRole('button', { name: 'Members' }).click();
  await admin.getByRole('checkbox', { name: /Ben Ortiz/ }).click();
  await admin.getByRole('button', { name: 'Add 1 student' }).click();
  await admin.getByText('1 member', { exact: true }).waitFor();
  await capture(admin, 'admin-group-members');

  await admin.getByRole('button', { name: 'Tests', exact: true }).first().click();
  await admin.getByRole('button', { name: 'New test' }).click();
  await admin.locator('#test-title').fill('Practice SAT');
  await admin.locator('#test-timed').click();
  await capture(admin, 'admin-new-test', { full: false });
  await admin.getByRole('button', { name: 'Create test' }).click();
  await admin.getByText('Full SAT · 98 questions').waitFor();
  // Locked, students see it but cannot start it; unlocked, they can.
  await admin.getByRole('button', { name: 'More for Practice SAT' }).click();
  await admin.getByRole('menuitem', { name: /^Lock/ }).click();
  await admin.getByRole('button', { name: 'Lock test' }).click();
  await admin.getByText('Locked', { exact: true }).waitFor();
  await capture(admin, 'admin-tests-locked');
  await admin.getByRole('button', { name: 'More for Practice SAT' }).click();
  await admin.getByRole('menuitem', { name: 'Unlock' }).click();
  await admin.getByText('Locked', { exact: true }).waitFor({ state: 'detached' });

  await admin.getByRole('button', { name: 'Assign', exact: true }).click();
  const assign = admin.getByRole('dialog', { name: 'Assign a test' });
  await assign.getByRole('checkbox', { name: /Ana Lopez/ }).click();
  await assign.getByRole('checkbox', { name: /Period 1/ }).click();
  await capture(admin, 'admin-assign-test', { full: false });
  await assign.getByRole('button', { name: 'Assign', exact: true }).click();
  await admin.getByText('Assigned "Practice SAT": 2 new.').waitFor();
  await admin.getByRole('button', { name: 'Assignments', exact: true }).first().click();
  await admin.getByText('Given to students directly').waitFor();
  await capture(admin, 'admin-assignments');

  // ---- The student takes the test.
  const ana = await open();
  await signIn(ana, email('ana'));
  await ana.getByRole('heading', { name: 'Practice SAT' }).waitFor();
  await capture(ana, 'student-home-new');
  await ana.getByRole('button', { name: 'Start test' }).click();
  await takeIt(ana);
  expect(!(await ana.getByRole('button', { name: /Practice these skills/ }).isVisible()), 'student: a managed student is offered practice of their own');
  await ana.getByRole('link', { name: 'insat home' }).click();
  await ana.getByRole('heading', { name: 'Nothing waiting for you' }).waitFor();
  expect(await asked('ana', 'POST', '/api/student/practice', { mode: 'skills', skills: ['Linear equations in one variable'] }) === 403,
    'api: a managed student could start practice of their own');

  // ---- The admin follows the student and assigns practice from their skills.
  await admin.getByRole('button', { name: 'Students', exact: true }).first().click();
  await admin.getByRole('button', { name: 'Ana Lopez', exact: true }).click();
  await admin.getByRole('heading', { name: 'Ana Lopez' }).waitFor();
  await admin.getByText('Tests done').waitFor();
  await capture(admin, 'admin-student-page');
  await admin.getByRole('button', { name: 'Assign practice' }).click();
  const practice = admin.getByRole('dialog', { name: 'Assign practice' });
  await practice.getByText(/questions, \d+ per skill/).waitFor();
  await capture(admin, 'admin-assign-practice', { full: false });
  await practice.getByRole('button', { name: 'Assign', exact: true }).click();
  await admin.getByText('Assigned the practice: 1 new.').waitFor();
  await admin.setViewportSize(PHONE);
  await capture(admin, 'admin-student-page-phone');
  await admin.setViewportSize(DESKTOP);

  // ---- The student does the practice.
  await ana.reload();
  await ana.getByRole('button', { name: 'Start practice' }).click();
  await takeIt(ana);
  await ana.getByRole('link', { name: 'insat home' }).click();
  await ana.getByRole('heading', { name: 'Nothing waiting for you' }).waitFor();
  await capture(ana, 'student-home-done');
  await ana.setViewportSize(PHONE);
  await capture(ana, 'student-home-phone');

  // ---- Both results reach the admin.
  await admin.getByRole('button', { name: 'Progress', exact: true }).first().click();
  await admin.getByText('Assigned practice').first().waitFor();
  await capture(admin, 'admin-progress');
  // The name opens the student's page (the row around it opens the result).
  await admin.getByRole('button', { name: 'Ana Lopez', exact: true }).first().click();
  await admin.getByRole('heading', { name: 'Ana Lopez' }).waitFor();

  // ---- The group member sees the test through the group.
  const ben = await open();
  await signIn(ben, email('ben'));
  await ben.getByRole('heading', { name: 'Practice SAT' }).waitFor();
  expect(await ben.getByText('Period 1').first().isVisible(), 'student: a group assignment does not name its group');

  // ---- Self-guided again: the admin loses groups and tests at once.
  await owner.reload();
  await owner.getByRole('button', { name: `More for ${academy}` }).click();
  await owner.getByRole('menuitem', { name: 'Make self-guided' }).click();
  await capture(owner, 'owner-make-self-guided', { full: false });
  await owner.getByRole('button', { name: 'Make self-guided' }).click();
  await owner.getByRole('dialog').waitFor({ state: 'detached' });
  expect(await asked('admin', 'GET', '/api/admin/groups') === 403, 'api: a self-guided academy\'s admin still reaches groups');
  await admin.reload();
  await admin.getByRole('button', { name: 'Add student' }).waitFor();
  expect(!(await admin.getByRole('button', { name: 'Tests', exact: true }).count()), 'admin: a self-guided academy still shows Tests');

  console.log(`${shot} screens in ${output}`);
  console.log(problems.length ? `${problems.length} problems:\n  ${problems.join('\n  ')}` : 'managed academy works end to end; no page errors, failed calls or overflow');
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  const file = path.join(output, 'failure.png');
  await current?.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.error(`stopped: ${e.message.split('\n')[0]}\n  at ${current?.url()}, photographed in ${file}`);
  if (problems.length) console.error(`problems so far:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const id of await institutionsNamed(academy)) await removeInstitution(id);
  if (ownerId) await removeAccount(ownerId);
  await close();
}
