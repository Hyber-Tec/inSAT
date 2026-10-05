// Every screen of the app, photographed as a student, an admin and the
// platform owner see it, on a desktop and on a phone, for a visual review.
// Requires the local API and client (`./start.sh`).
//
//   From client: npm run check:screens [-- --label before]
//
// Temporary accounts in the default institution (a student, an admin) and a
// temporary superadmin walk through the landing page, sign-in, an invite, the
// dashboard, a practice set in the test runner (passage, choices, cross-out,
// navigator, calculator, reference sheet, dragging a tool window), its results
// and answer review, the account menu, and the admin and platform consoles,
// going home by the logo. Every screen is also checked for page errors, failed
// API calls, and content wider than a phone screen.
// Screenshots go to .logs/screens/<label>/; the accounts are removed after.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, pool } from '../../functions/lib/db.js';
import { hashPassword } from '../../functions/lib/auth.js';
import { signInvite } from '../../functions/lib/invite.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const origin = process.env.E2E_CLIENT_URL || 'http://127.0.0.1:5174';
const apiOrigin = process.env.E2E_API_URL || 'http://localhost:3002';
const output = path.resolve(`../.logs/screens/${arg('label', 'latest')}`);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const users = [];
const problems = [];
let shot = 0;
let browser;
let current; // the page open now, photographed if a step fails

async function account(role, institutionId, name) {
  const email = `screens-${role}-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  const { rows } = await query(
    `INSERT INTO pa_users(email,password_hash,display_name,role,institution_id,must_change_password)
     VALUES($1,$2,$3,$4,$5,false) RETURNING id`,
    [email, await hashPassword(password), name, role, institutionId],
  );
  users.push(rows[0].id);
  return { id: rows[0].id, email, password, name };
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

/** Photograph the page (or one element) and check nothing sticks out sideways. */
async function capture(page, name, { full = true, element = null } = {}) {
  await page.waitForTimeout(250); // let entry animations settle
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) problems.push(`${name}: page wider than the screen by ${over}px`);
  shot += 1;
  const file = path.join(output, `${String(shot).padStart(2, '0')}-${name}.png`);
  if (element) await element.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, fullPage: full, animations: 'disabled' });
}

async function signIn(page, who) {
  await page.goto(`${origin}/sign-in`);
  await page.locator('input[type=email]').fill(who.email);
  await page.locator('input[type=password]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function api(page, endpoint, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${localStorage.getItem('satify_token')}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  }, { url: `${apiOrigin}${endpoint}`, method, body });
}

try {
  const satify = (await query("SELECT id FROM pa_institutions WHERE slug='satify'")).rows[0].id;
  const learner = await account('student', satify, 'Riley Chen');
  const admin = await account('admin', satify, 'Morgan Admin');
  const owner = await account('superadmin', null, 'Platform Owner');
  browser = await chromium.launch({ headless: true });

  // ---- Signed out
  for (const [viewport, tag] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const page = await open(viewport);
    await page.goto(origin);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await capture(page, `landing-${tag}`);
    await page.goto(`${origin}/sign-in`);
    await page.locator('input[type=email]').waitFor();
    await capture(page, `sign-in-${tag}`);
    // The logo leads home from every page: here, the landing page.
    await page.getByRole('link', { name: 'insat home', exact: true }).click();
    await page.getByRole('heading', { name: /Practice that feels/ }).waitFor();
    await page.goto(`${origin}/?invite=${encodeURIComponent(signInvite({ userId: learner.id, email: learner.email }))}`);
    await page.getByRole('button', { name: /Set password/ }).waitFor();
    await capture(page, `invite-${tag}`);
    await page.getByRole('link', { name: 'insat home', exact: true }).click();
    await page.getByRole('heading', { name: /Practice that feels/ }).waitFor();
    await page.context().close();
  }

  // An invite: a broken one's "Go to sign in" opens the sign-in page, and
  // accepting a good one signs the student in, at home on the dashboard.
  {
    const invitee = await account('student', satify, 'Jordan Park');
    const page = await open();
    await page.goto(`${origin}/?invite=not-a-real-invite`);
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await page.locator('input[type=email]').waitFor();
    if (new URL(page.url()).pathname !== '/sign-in') problems.push(`invite: "Go to sign in" opened ${page.url()}`);
    await page.goto(`${origin}/?invite=${encodeURIComponent(signInvite({ userId: invitee.id, email: invitee.email }))}`);
    const fresh = crypto.randomBytes(12).toString('base64url');
    await page.getByLabel('New password').fill(fresh);
    await page.getByLabel('Confirm password').fill(fresh);
    await page.getByRole('button', { name: /Set password/ }).click();
    await page.getByRole('heading', { name: 'Take a practice test' }).waitFor();
    if (page.url() !== `${origin}/`) problems.push(`invite: signed in at ${page.url()}, not home`);
    await page.context().close();
  }

  // ---- Student
  let page = await open();
  await signIn(page, learner);
  await page.getByRole('heading', { name: 'Start with a diagnostic test' }).waitFor();
  await capture(page, 'student-dashboard-desktop');
  await page.setViewportSize(PHONE);
  await capture(page, 'student-dashboard-phone');
  await page.setViewportSize(DESKTOP);

  // The account menu: who is signed in, account settings (a new password).
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).waitFor();
  await capture(page, 'account-menu-desktop', { full: false });
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Account settings' });
  const renewed = crypto.randomBytes(12).toString('base64url');
  await settings.getByLabel('Current password', { exact: true }).fill(learner.password);
  await settings.getByLabel('New password', { exact: true }).fill(renewed);
  await settings.getByLabel('Confirm new password', { exact: true }).fill(renewed);
  await settings.getByRole('button', { name: 'Change password' }).click();
  await settings.getByText('Your password was changed.').waitFor();
  learner.password = renewed;
  await capture(page, 'account-settings-desktop', { full: false });
  await settings.getByRole('button', { name: 'Close', exact: true }).first().click();
  await settings.waitFor({ state: 'detached' });
  // The page still answers after the dialog: the menu opens again.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).waitFor();
  await page.keyboard.press('Escape');

  // A practice set of one RW and one math skill: the runner in both layouts.
  const profile = await api(page, '/api/student/profile');
  const pick = (section) => profile.skills.find((s) => s.section === section && s.ready > 0)?.skill;
  const set = await api(page, '/api/student/practice', 'POST', { mode: 'skills', skills: [pick('rw'), pick('math')] });
  await page.reload();
  await page.getByRole('button', { name: /Resume/ }).first().click();
  await page.getByRole('heading', { name: set.form.sections[0].name, exact: true }).waitFor();
  await capture(page, 'module-intro-desktop');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const first = set.form.sections[0];
  const count = first.modules[0].questions.length;
  await page.getByRole('button', { name: `Question 1 of ${count}`, exact: true }).waitFor();
  await page.locator('button:has(> span:text-is("B"))').first().click();
  await page.getByRole('button', { name: /Mark for review/ }).click();
  await capture(page, 'runner-reading-desktop', { full: false });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByTitle("Cross out choices you've ruled out").click();
  await page.locator('button:has(> span:text-is("C"))').first().click();
  await capture(page, 'runner-cross-out-desktop', { full: false });
  await page.getByRole('button', { name: `Question 2 of ${count}`, exact: true }).click();
  await capture(page, 'runner-navigator-desktop', { full: false });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `Question 2 of ${count}`, exact: true }).click({ trial: true }).catch(() => {});
  await page.setViewportSize(PHONE);
  await capture(page, 'runner-reading-phone');
  await page.setViewportSize(DESKTOP);
  // Close the navigator if still open, then run to the end of the module.
  if (await page.getByText('Question navigator').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: `Question 2 of ${count}`, exact: true }).click();
  }
  for (let i = 2; i < count; i += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  await page.getByRole('heading', { name: set.form.sections[1].name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const second = set.form.sections[1];
  const mathCount = second.modules[0].questions.length;
  await page.getByRole('button', { name: `Question 1 of ${mathCount}`, exact: true }).waitFor();
  await capture(page, 'runner-math-desktop', { full: false });
  await page.getByRole('button', { name: 'Calculator' }).click();
  await capture(page, 'runner-calculator-desktop', { full: false });
  await page.getByRole('button', { name: 'Reference' }).click();
  await capture(page, 'runner-reference-desktop', { full: false });
  // The window drags by its title bar off what it covers, and however far it
  // is dragged it stays inside the test area, 16px from its edges, also after
  // a resize. (The question may be a grid-in, without choices to cross out,
  // so this looks at whatever was under the window.)
  const titleBar = page.getByText('Reference sheet', { exact: true });
  const dragBy = async (dx, dy) => {
    const at = await titleBar.boundingBox();
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x + at.width / 2 + dx, at.y + at.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
  };
  const before = await titleBar.boundingBox();
  await dragBy(-120, 120);
  const after = await titleBar.boundingBox();
  const moved = [Math.round(after.x - before.x), Math.round(after.y - before.y)];
  if (moved[0] !== -120 || moved[1] !== 120) problems.push(`runner: dragged by (-120, 120), the reference sheet moved (${moved})`);
  const covered = await titleBar.evaluate((el, at) => (
    el.closest('[style]').contains(document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2))
  ), before);
  if (covered) problems.push('runner: dragged away, the reference sheet still covers where it was');
  await dragBy(-3000, 3000);
  const outside = () => titleBar.evaluate((el) => {
    const win = el.closest('[style]');
    const box = win.firstElementChild.getBoundingClientRect();
    const area = win.offsetParent?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    return box.left < area.left + 15.5 || box.right > area.right - 15.5 || box.top < area.top + 15.5 || box.bottom > area.bottom - 15.5;
  });
  if (await outside()) problems.push('runner: a dragged tool window left the test area');
  await capture(page, 'runner-reference-dragged-desktop', { full: false });
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(100);
  if (await outside()) problems.push('runner: after a resize, a dragged tool window is outside the screen');
  await capture(page, 'runner-math-phone');
  await page.setViewportSize(DESKTOP);
  for (let i = 1; i < mathCount; i += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit module', exact: true }).click();
  await page.getByText('Click any question to see what went wrong.').waitFor();
  await capture(page, 'results-desktop');
  await page.setViewportSize(PHONE);
  await capture(page, 'results-phone');
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: '1', exact: true }).first().click();
  await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
  await capture(page, 'review-desktop', { full: false });
  await page.setViewportSize(PHONE);
  await capture(page, 'review-phone', { full: false });
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'insat home', exact: true }).click();
  await page.getByRole('heading', { name: 'Take a practice test' }).waitFor();
  // A set left in progress, to show Resume and Discard.
  await api(page, '/api/student/practice', 'POST', { mode: 'skills', skills: [pick('math')] });
  await page.reload();
  await page.getByRole('button', { name: /Discard/ }).first().waitFor();
  await capture(page, 'student-dashboard-history-desktop');
  await page.getByRole('button', { name: /Discard/ }).first().click();
  await page.getByText('Discard this practice?').waitFor();
  await capture(page, 'confirm-dialog-desktop', { full: false });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Discarding a finished set takes it off the list but not out of the skill
  // profile; discarding an unfinished one deletes it.
  const cards = (action) => page.locator('[data-slot="card"]').filter({ has: page.getByRole('button', { name: action, exact: true }) });
  const discard = async (card, note) => {
    await card.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByText(note).waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  };
  const answered = (profile) => profile.skills.reduce((n, k) => n + k.answered, 0);
  /** How many there are once the list has caught up with `want` (2s at most). */
  const settled = async (locator, want) => {
    for (let i = 0; i < 20 && await locator.count() !== want; i += 1) await page.waitForTimeout(100);
    return locator.count();
  };
  const counted = answered(await api(page, '/api/student/profile'));
  const finished = await cards('Review').count();
  await discard(cards('Review').first(), 'Its results still count toward your skill map');
  if (await settled(cards('Review'), finished - 1) !== finished - 1) problems.push('discard: a finished practice set stayed on the list');
  if (answered(await api(page, '/api/student/profile')) !== counted) problems.push('discard: a discarded finished set stopped counting in the skill profile');
  const unfinished = await cards('Resume').count();
  await discard(cards('Resume').first(), 'and the answers in it will be removed');
  if (await settled(cards('Resume'), unfinished - 1) !== unfinished - 1) problems.push('discard: an unfinished practice set stayed on the list');
  if ((await api(page, '/api/student/practice')).practice.length !== 0) problems.push('discard: the practice list still has discarded sets');
  // A malformed id is a bad request, not a server error (asked from here, so
  // the expected 400 is not counted as a failed call of the page).
  const token = await page.evaluate(() => localStorage.getItem('satify_token'));
  const malformed = await fetch(`${apiOrigin}/api/student/practice/not-an-id`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (malformed.status !== 400) problems.push(`api: a malformed id answered ${malformed.status}, not 400`);
  // Signing out from the menu lands on sign-in; back in with the password
  // changed above.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  if (new URL(page.url()).pathname !== '/sign-in') problems.push(`account menu: signing out landed on ${page.url()}`);
  await signIn(page, learner);
  await page.getByRole('heading', { name: 'Take a practice test' }).waitFor();
  await page.context().close();

  // ---- Admin
  page = await open();
  await signIn(page, admin);
  await page.getByRole('button', { name: /Add student/ }).waitFor();
  await capture(page, 'admin-students-desktop');
  await page.getByRole('button', { name: /Morgan Admin/ }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).waitFor();
  await capture(page, 'admin-account-menu-desktop', { full: false });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Add student/ }).click();
  await page.getByText('Add a student').waitFor();
  await capture(page, 'admin-add-student-desktop', { full: false });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Progress' }).first().click();
  await page.getByText('Riley Chen').first().waitFor();
  await capture(page, 'admin-progress-desktop');
  // The completed set (the in-progress one does not open).
  await page.locator('div').filter({ hasText: 'Riley Chen' }).filter({ hasText: /Completed/ }).last().click();
  await page.getByRole('button', { name: 'Close', exact: true }).first().waitFor();
  await page.waitForTimeout(400);
  await capture(page, 'admin-result-detail-desktop', { full: false });
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByText('Branding').first().waitFor();
  // A self-guided institution serves insat's pool alone: it has no AI to set up.
  if (await page.getByText('AI provider').count()) problems.push('admin: a self-guided institution shows AI settings');
  await capture(page, 'admin-settings-desktop');
  await page.setViewportSize(PHONE);
  await page.getByRole('link', { name: 'insat home', exact: true }).click();
  await page.getByRole('button', { name: /Add student/ }).waitFor();
  await capture(page, 'admin-students-phone');
  await page.context().close();

  // ---- Platform owner
  page = await open();
  await signIn(page, owner);
  await page.getByRole('button', { name: /New institution/ }).waitFor();
  await capture(page, 'super-institutions-desktop');
  await page.getByRole('button', { name: /New institution/ }).click();
  await page.getByText(/Creates the academy/).waitFor();
  await capture(page, 'super-new-institution-desktop', { full: false });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize(PHONE);
  await capture(page, 'super-institutions-phone');
  await page.context().close();

  fs.writeFileSync(path.join(output, 'problems.json'), JSON.stringify(problems, null, 2) + '\n');
  console.log(`${shot} screens in ${output}`);
  console.log(problems.length ? `${problems.length} problems:\n  ${problems.join('\n  ')}` : 'no page errors, failed calls or overflow');
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  const file = path.join(output, 'failure.png');
  await current?.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.error(`stopped: ${e.message.split('\n')[0]}\n  at ${current?.url()}, photographed in ${file}`);
  if (problems.length) console.error(`problems so far:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const id of users) {
    await query('DELETE FROM pa_sessions WHERE user_id=$1', [id]).catch(() => {});
    await query('DELETE FROM pa_users WHERE id=$1', [id]);
  }
  await pool.end();
}
