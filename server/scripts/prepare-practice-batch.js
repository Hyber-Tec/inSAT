// Generate, independently solve, export, and optionally import a real math batch.
// node --env-file=.env scripts/prepare-practice-batch.js --institution satify --import
import fs from 'node:fs';
import path from 'node:path';
import { query, pool } from '../lib/db.js';
import { MATH_TEMPLATES } from '../lib/templates/math.js';
import { templateRows, importTemplateRows } from '../lib/templateItems.js';
import { verifyTemplateItem } from './check-templates.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const slug = arg('institution', 'satify');
const count = Number(arg('per-skill', '12'));
const output = path.resolve(arg('output', `../exports/verified-practice-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const shouldImport = process.argv.includes('--import');
const templateIds = ['alg-linear-solve', 'adv-equivalent', 'ps-mean-missing', 'geo-volume'];

try {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--per-skill must be an integer from 1 to 100');
  if (fs.existsSync(output)) throw new Error('Output directory already exists; choose a new --output path');
  const institution = (await query('SELECT id FROM pa_institutions WHERE slug=$1', [slug])).rows[0];
  if (!institution) throw new Error(`Unknown institution: ${slug}`);
  const existing = new Set((await query('SELECT content_hash FROM pa_items WHERE institution_id=$1', [institution.id])).rows.map((r) => r.content_hash));
  const rows = [], records = [], checks = [];
  const seed = Date.now() % 1000000;
  for (const templateId of templateIds) {
    const template = MATH_TEMPLATES.find((t) => t.id === templateId);
    let accepted = 0;
    for (let attempt = 0; accepted < count && attempt < count * 200; attempt++) {
      const [row] = templateRows({ domain: template.domain, difficulty: template.difficulty, need: 1, templateId, seed: seed + attempt * 104729 });
      if (!row || existing.has(row.content_hash)) continue;
      const { template: unusedTemplate, seed: itemSeed, ...rationale } = row.rationale;
      const item = { question: row.question, choices: row.choices, correctIdx: row.correct_idx, answerType: row.answer_type, answerText: row.answer_text, rationale, seed: itemSeed };
      const verdict = verifyTemplateItem(template, item);
      checks.push({ contentHash: row.content_hash, templateId, seed: itemSeed, ...verdict });
      if (!verdict.verified) throw new Error(`Independent verification failed: ${verdict.errors.join('; ')}`);
      existing.add(row.content_hash);
      rows.push(row);
      records.push({ id: `template:${row.content_hash}`, ...row, topicFilter: `${row.domain}:${row.skill}`, verification: { method: 'independent-stem-solver', templateId, seed: itemSeed } });
      accepted++;
    }
    if (accepted !== count) throw new Error(`Only ${accepted}/${count} unique questions for ${templateId}`);
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'questions.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(checks, null, 2) + '\n');
  const imported = shouldImport ? await importTemplateRows(rows, institution.id) : null;
  const bankIds = shouldImport ? (await query('SELECT id,content_hash FROM pa_items WHERE institution_id=$1 AND content_hash=ANY($2::text[])', [institution.id, rows.map((r) => r.content_hash)])).rows : [];
  const manifest = { generatedAt: new Date().toISOString(), institution: slug, generation: 'deterministic-math-templates', independentVerification: 'Answers re-derived from the exact rendered stems; classification checked against the canonical template taxonomy.', questions: rows.length, skills: templateIds.map((id) => { const t = MATH_TEMPLATES.find((t) => t.id === id); return { domain: t.domain, skill: t.skill, difficulty: t.difficulty, count }; }), imported, bankIds };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, questions: rows.length, imported, persisted: bankIds.length }));
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await pool.end(); }
