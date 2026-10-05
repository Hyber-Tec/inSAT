// The generation route against the Firestore emulator, with the AI provider
// mocked: what reaches a bank, and what each model call is shown. Run it with
// `npm run check:generation`, which starts the emulators, or against running
// ones with FIRESTORE_EMULATOR_HOST set.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

// Never against production: every write below goes to the emulator.
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Run against the Firestore emulator (npm run check:generation).');
// Off Google Cloud there is no metadata server to wait for.
process.env.METADATA_SERVER_DETECTION ||= 'none';
process.env.ANTHROPIC_API_KEY = 'test-only';
process.env.REQUIRE_INSTITUTION_KEY = 'false';
const { default: express } = await import('express');
const { default: bank } = await import('../routes/bank.js');
const { errorHandler } = await import('../lib/http.js');
const { COL, col, queryRows, writeAll } = await import('../lib/store.js');
const { hashRef } = await import('../lib/items.js');

const MESSAGES_API = 'https://api.anthropic.com/v1/messages';
// A bank of its own, so the test sees only what it added.
const SCHOOL = `test-school-${randomUUID()}`;
const nativeFetch = globalThis.fetch;
let server, endpoint, inserted, responses, prompts;
const draft = {
  question: 'What is 25 percent of 80?', answer_type: 'multiple-choice',
  choices: ['20', '25', '40', '60'], answer: 'A', skill: 'Percentages',
  rationale: { correct: 'Multiply 80 by 0.25 to get 20.', A: 'This is 0.25 times 80.', B: 'This repeats the percentage.', C: 'This is half of 80.', D: 'This is 75 percent of 80.' },
};
const verdict = { i: 0, answer: 'A', single_correct: true, domain: 'problem-solving', skill: 'Percentages' };

/** The questions in the test's bank. */
const bankItems = () => queryRows(col(COL.items).where('institution_id', '==', SCHOOL));

before(async () => {
  // Model calls are answered from `responses`; anything else (the emulators) goes out.
  globalThis.fetch = async (url, options) => {
    if (String(url) !== MESSAGES_API) return nativeFetch(url, options);
    prompts.push(JSON.parse(options.body));
    assert.ok(responses.length, 'unexpected model call');
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(responses.shift()) }] }));
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { inst: SCHOOL }; next(); });
  app.use('/api/bank', bank);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/api/bank/generate`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => server.close(resolve));
  const items = await bankItems();
  await writeAll(items.flatMap((i) => [['delete', col(COL.items).doc(i.id)], ['delete', hashRef(SCHOOL, i.content_hash)]]));
});

async function generate(item, review, topic = 'Percentages') {
  prompts = []; responses = [[item], [review]];
  const had = new Set((await bankItems()).map((i) => i.id));
  const response = await nativeFetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'math', domain: 'problem-solving', n: 1, topic }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  inserted = (await bankItems()).filter((i) => !had.has(i.id));
  return result;
}

test('generation endpoint rejects an answer agreement with a conflicting skill', async () => {
  const result = await generate(draft, { ...verdict, domain: 'algebra', skill: 'Linear equations in one variable' });
  assert.equal(result.verified, 0);
  assert.equal(result.added, 0);
  assert.equal(inserted.length, 0);
});

test('generation endpoint requires explicit confirmation of a unique answer', async () => {
  const { single_correct, ...incomplete } = verdict;
  const result = await generate(draft, incomplete);
  assert.equal(result.verified, 0);
  assert.equal(inserted.length, 0);
});

test('generation rejects missing classification, wrong keys, and ambiguous answers', async () => {
  for (const review of [
    { i: 0, answer: 'A', single_correct: true },
    { ...verdict, answer: 'B' },
    { ...verdict, single_correct: false },
    { ...verdict, single_correct: 'true' },
    { ...verdict, skill: 'General Math' },
    { ...verdict, i: 1 },
    null,
  ]) {
    const result = await generate(draft, review);
    assert.equal(result.verified, 0);
    assert.equal(inserted.length, 0);
  }
});

test('malformed or untargeted drafts cannot reach the pool', async () => {
  for (const item of [
    { ...draft, answer: '' },
    { ...draft, choices: [...draft.choices, '80'] },
    { ...draft, choices: ['20', '20', '40', '60'] },
    { ...draft, choices: 'malformed' },
    { ...draft, skill: 'Unclassified' },
    { ...draft, skill: 'Probability and conditional probability' },
    { ...draft, rationale: {} },
    null,
  ]) {
    const result = await generate(item, verdict);
    assert.equal(result.verified, 0);
    assert.equal(inserted.length, 0);
    assert.equal(prompts.length, 1, 'invalid drafts should not incur verification calls');
  }
});

test('batch verification rejects duplicate indices and does not expose draft labels', async () => {
  const { rowFromGenerated, verifyBatch, verifiedGenerated } = await import('../lib/generate.js');
  const row = rowFromGenerated(draft, { kind: 'math', domain: 'problem-solving', difficulty: 'easy' });
  assert.equal(row.verified, false);
  responses = [[verdict, verdict]];
  prompts = [];
  const [review] = await verifyBatch([row], { creds: {} });
  assert.equal(review, null);
  assert.equal(verifiedGenerated(row, review), false);
  const questionBody = prompts[0].messages[0].content.split('#0')[1];
  assert.ok(!questionBody.includes('Percentages'));
  assert.ok(!questionBody.includes('problem-solving'));
  assert.equal(verifiedGenerated(row, verdict), true);
});

test('verified questions preserve classification through bank, session results and practice', async () => {
  const result = await generate(draft, verdict);
  assert.equal(result.verified, 1);
  assert.equal(result.added, 1);
  assert.equal(inserted.length, 1);
  const item = inserted[0];
  assert.equal(item.institution_id, SCHOOL);
  assert.equal(item.domain, 'problem-solving');
  assert.equal(item.skill, 'Percentages');
  assert.equal(item.verified, true);
  const blindPrompt = prompts[1].messages[0].content;
  assert.ok(!blindPrompt.includes(draft.rationale.correct));
  assert.ok(!blindPrompt.includes('Answer: A'));
  const { instanceFromRow } = await import('../lib/assembly.js');
  const { buildResults } = await import('../lib/session.js');
  const { skillsSpec } = await import('../lib/practice.js');
  const q = instanceFromRow({
    id: 'test-item', section: item.section, domain: item.domain, skill: item.skill, difficulty: item.difficulty,
    question: item.question, choices: item.choices, correct_idx: item.correct_idx, answer_type: item.answer_type,
    rationale: item.rationale,
  });
  const form = { sections: [{ kind: 'math', modules: [{ ordinal: 1, questions: [q] }] }] };
  const results = buildResults(form, { answers: {} }, {});
  const skills = results.sections[0].skills;
  assert.deepEqual(skills, [{ skill: 'Percentages', domain: 'problem-solving', correct: 0, total: 1 }]);
  const spec = skillsSpec(['Percentages'], { skills: skills.map((s) => ({ ...s, answered: s.total })) });
  assert.equal(spec.sections[0].modules[0].skills.Percentages.difficulty, 'easy');
});
