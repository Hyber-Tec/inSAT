import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATH_TEMPLATES, buildItem } from '../lib/templates/math.js';
import { verifyTemplateItem } from '../scripts/check-templates.js';

test('independent verification checks the actual rendered item before import', () => {
  const template = MATH_TEMPLATES.find((t) => t.id === 'alg-linear-solve');
  const item = buildItem(template, 1013);
  assert.equal(verifyTemplateItem(template, item).verified, true);
  const wrong = { ...item, correctIdx: (item.correctIdx + 1) % 4 };
  assert.equal(verifyTemplateItem(template, wrong).verified, false);
  assert.equal(verifyTemplateItem(template, { ...item, rationale: {} }).verified, false);
  assert.equal(verifyTemplateItem(template, item).verified, true, 'previous failures must not contaminate later checks');
});

test('missing independent solvers and noncanonical classifications fail closed', () => {
  const template = MATH_TEMPLATES.find((t) => t.id === 'alg-linear-solve');
  const item = buildItem(template, 1013);
  assert.equal(verifyTemplateItem({ ...template, id: 'unknown' }, item).verified, false);
  assert.equal(verifyTemplateItem({ ...template, skill: 'General Math' }, item).verified, false);
});
