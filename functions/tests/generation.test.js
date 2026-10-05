import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.DATABASE_URL = 'postgres://unused@localhost/unused';
process.env.ANTHROPIC_API_KEY = 'test-only';
process.env.REQUIRE_INSTITUTION_KEY = 'false';
const { default: express } = await import('express');
const { pool } = await import('../lib/db.js');
const { default: bank } = await import('../routes/bank.js');
const { errorHandler } = await import('../lib/http.js');

const nativeFetch = globalThis.fetch;
const originalQuery = pool.query;
let server, endpoint, inserted, responses, prompts;
const draft = {
  question: 'What is 25 percent of 80?', answer_type: 'multiple-choice',
  choices: ['20', '25', '40', '60'], answer: 'A', skill: 'Percentages',
  rationale: { correct: 'Multiply 80 by 0.25 to get 20.', A: 'This is 0.25 times 80.', B: 'This repeats the percentage.', C: 'This is half of 80.', D: 'This is 75 percent of 80.' },
};
const verdict = { i: 0, answer: 'A', single_correct: true, domain: 'problem-solving', skill: 'Percentages' };

before(async () => {
  pool.query = async (sql, params) => {
    if (sql.includes('INSERT INTO pa_items')) { inserted.push(params); return { rows: [] }; }
    if (sql.includes('SELECT id FROM pa_institutions')) return { rows: [{ id: 'global-test' }] };
    if (sql.includes('FROM pa_items') || sql.includes('FROM pa_institutions')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    prompts.push(JSON.parse(options.body));
    assert.ok(responses.length, 'unexpected model call');
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(responses.shift()) }] }));
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { inst: 'test-school' }; next(); });
  app.use('/api/bank', bank);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/api/bank/generate`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  pool.query = originalQuery;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function generate(item, review, topic = 'Percentages') {
  inserted = []; prompts = []; responses = [[item], [review]];
  const response = await nativeFetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'math', domain: 'problem-solving', n: 1, topic }),
  });
  assert.equal(response.status, 200);
  return response.json();
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
  const params = inserted[0];
  assert.equal(params[0], 'test-school');
  assert.equal(params[3], 'problem-solving');
  assert.equal(params[4], 'Percentages');
  assert.equal(params[15], true);
  const blindPrompt = prompts[1].messages[0].content;
  assert.ok(!blindPrompt.includes(draft.rationale.correct));
  assert.ok(!blindPrompt.includes('Answer: A'));
  const { instanceFromRow } = await import('../lib/assembly.js');
  const { buildResults } = await import('../lib/session.js');
  const { skillsSpec } = await import('../lib/practice.js');
  const q = instanceFromRow({
    id: 'test-item', section: params[2], domain: params[3], skill: params[4], difficulty: params[5],
    question: params[7], choices: JSON.parse(params[8]), correct_idx: params[9], answer_type: params[10],
    rationale: JSON.parse(params[11]),
  });
  const form = { sections: [{ kind: 'math', modules: [{ ordinal: 1, questions: [q] }] }] };
  const results = buildResults(form, { answers: {} }, {});
  const skills = results.sections[0].skills;
  assert.deepEqual(skills, [{ skill: 'Percentages', domain: 'problem-solving', correct: 0, total: 1 }]);
  const spec = skillsSpec(['Percentages'], { skills: skills.map((s) => ({ ...s, answered: s.total })) });
  assert.equal(spec.sections[0].modules[0].skills.Percentages.difficulty, 'easy');
});
