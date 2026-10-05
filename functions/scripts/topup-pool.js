// Fills a question bank up to a target depth, offline: by default the
// generation pool, whose questions shape AI generation (lib/pool.js).
//
// Nothing is waiting on this, so it takes the cheap route: math comes from
// templates (free and correct by construction) and Reading & Writing goes
// through the Batches API at half price. Everything still passes the same
// verification and duplicate gates before it lands in the bank.
//
// insat's question pool (--institution satify) serves only its originals,
// their variants and template questions, so model-written questions added to
// it are never served; fill it from the templates alone (--rw 0).
//
// Run:
//   node --env-file=.env functions/scripts/topup-pool.js --math 40 --rw 25
//   node --env-file=.env functions/scripts/topup-pool.js --rw 25 --dry-run
//
// Flags:
//   --math N        target items per math domain x difficulty   (default 30)
//   --math-model N  target model-written items per math skill x difficulty
//                   (default 0). Templates are correct but formulaic; these are
//                   written in the SAT's style from the real questions in the
//                   pool, verified like Reading & Writing, and served first.
//   --rw N          target items per R&W skill x difficulty     (default 20)
//   --institution S slug to fill (and whose API key to use); omit for the
//                   shared global pool and the platform key
//   --batch-size N  questions per model request                 (default 5)
//   --dry-run       report the deficit and stop, spending nothing
//
// Reading & Writing is filled per skill, not just per domain: practice aimed at
// a student's weakest skill needs items of that skill to draw from.

import { query, pool } from '../lib/db.js';
import { DOMAINS, SKILLS } from '../lib/taxonomy.js';
import { globalPoolId, ensureGlobalPool } from '../lib/pool.js';
import { MATH_TEMPLATES } from '../lib/templates/math.js';
import { templateRows, importTemplateRows } from '../lib/templateItems.js';
import { importRows } from '../lib/items.js';
import { GEN_SYSTEM, genPrompt, rowFromGenerated, usable, verifyBatch, exemplars, verifiedGenerated } from '../lib/generate.js';
import { getInstitutionCredentials } from '../lib/institutions.js';
import { batchSupported, runBatch } from '../lib/batch.js';
import { parseJson } from '../lib/llm.js';
import { config } from '../lib/config.js';

const DIFFICULTIES = ['easy', 'medium', 'hard'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const mathTarget = Number(arg('math', 30));
const mathModelTarget = Number(arg('math-model', 0));
const rwTarget = Number(arg('rw', 20));
const batchSize = Math.max(1, Number(arg('batch-size', 5)));
const dryRun = flag('dry-run');

async function targetInstitution() {
  const slug = arg('institution', '');
  if (!slug) { await ensureGlobalPool(); return { id: await globalPoolId(), label: 'global pool' }; }
  const { rows } = await query('SELECT id, name FROM pa_institutions WHERE slug = $1', [slug]);
  if (!rows[0]) throw new Error(`No institution with slug "${slug}"`);
  // The institution's own key when it has one (Settings), else the platform key.
  return { id: rows[0].id, label: rows[0].name };
}

async function counts(institutionId) {
  // Reference items are never served on an exam, so they must not count toward
  // the target -- otherwise an imported bank makes every cell look full while
  // the servable bank is still empty.
  const { rows } = await query(
    `SELECT section, domain, skill, difficulty, source <> 'template' AS written, COUNT(*)::int AS n
       FROM pa_items
      WHERE institution_id = $1 AND retired_at IS NULL AND source <> 'reference'
      GROUP BY section, domain, skill, difficulty, source <> 'template'`,
    [institutionId],
  );
  const map = new Map();
  const add = (key, n) => map.set(key, (map.get(key) || 0) + n);
  for (const r of rows) {
    add(`${r.section}|${r.domain}|${r.difficulty}`, r.n);
    add(`${r.section}|${r.domain}|${r.skill}|${r.difficulty}`, r.n);
    if (r.written) add(`${r.section}|${r.domain}|${r.skill}|${r.difficulty}|written`, r.n);
  }
  return map;
}

function deficits(have) {
  const out = [];
  for (const domain of DOMAINS.math) {
    for (const difficulty of DIFFICULTIES) {
      const n = have.get(`math|${domain}|${difficulty}`) || 0;
      if (n < mathTarget) out.push({ section: 'math', domain, difficulty, have: n, need: mathTarget - n });
    }
  }
  if (mathModelTarget > 0) {
    for (const domain of DOMAINS.math) {
      for (const skill of SKILLS[domain]) {
        for (const difficulty of DIFFICULTIES) {
          const n = have.get(`math|${domain}|${skill}|${difficulty}|written`) || 0;
          if (n < mathModelTarget) out.push({ section: 'math-model', domain, skill, difficulty, have: n, need: mathModelTarget - n });
        }
      }
    }
  }
  for (const domain of DOMAINS.rw) {
    for (const skill of SKILLS[domain]) {
      for (const difficulty of DIFFICULTIES) {
        const n = have.get(`rw|${domain}|${skill}|${difficulty}`) || 0;
        if (n < rwTarget) out.push({ section: 'rw', domain, skill, difficulty, have: n, need: rwTarget - n });
      }
    }
  }
  return out;
}

// --- model-written questions: batched model calls ----------------------------
async function buildModelRequests(cells, kind) {
  const items = [];
  for (const cell of cells) {
    const exRows = await exemplars(kind, cell.domain, 3, { difficulty: cell.difficulty, skill: cell.skill });
    let remaining = cell.need;
    let part = 0;
    while (remaining > 0) {
      const n = Math.min(batchSize, remaining);
      items.push({
        // custom_id allows [a-zA-Z0-9_-] only, so the skill goes by its index.
        customId: `${kind}__${cell.domain}__${SKILLS[cell.domain].indexOf(cell.skill)}__${cell.difficulty}__${part}`,
        system: GEN_SYSTEM,
        prompt: genPrompt({ kind, domain: cell.domain, difficulty: cell.difficulty, n, topic: cell.skill, exRows }),
        model: config.genModel,
        // Full per-choice explanations make each question several times longer.
        maxTokens: 16000,
        meta: { kind, domain: cell.domain, difficulty: cell.difficulty, skill: cell.skill },
      });
      remaining -= n;
      part += 1;
    }
  }
  return items;
}

function rowsFromBatch(results, requests) {
  const byId = new Map(requests.map((r) => [r.customId, r]));
  const rows = [];
  for (const [customId, res] of results) {
    const req = byId.get(customId);
    if (!req || res.error || !res.text) continue;
    let drafted = [];
    try {
      const parsed = parseJson(res.text);
      drafted = Array.isArray(parsed) ? parsed : parsed.questions || parsed.items || [];
    } catch { continue; }
    for (const g of Array.isArray(drafted) ? drafted : []) {
      const row = rowFromGenerated(g, { kind: req.meta.kind, domain: req.meta.domain, difficulty: req.meta.difficulty, topic: req.meta.skill });
      if (usable(row)) rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
async function main() {
  const { id: institutionId, label } = await targetInstitution();
  const creds = arg('institution', '') ? await getInstitutionCredentials(institutionId) : {};
  const have = await counts(institutionId);
  const gaps = deficits(have);

  const mathGaps = gaps.filter((g) => g.section === 'math');
  const modelGaps = gaps.filter((g) => g.section === 'math-model' || g.section === 'rw');
  const mathNeed = mathGaps.reduce((s, g) => s + g.need, 0);
  const modelNeed = modelGaps.reduce((s, g) => s + g.need, 0);

  console.log(`Filling: ${label}`);
  console.log(`Targets: math ${mathTarget}/cell from templates, math ${mathModelTarget}/skill x difficulty written by the model, reading & writing ${rwTarget}/cell`);
  console.log(`Short by: ${mathNeed} template math, ${modelNeed} model-written questions\n`);
  for (const g of gaps) {
    console.log(`  ${g.section.padEnd(10)} ${g.domain.padEnd(16)} ${(g.skill || '').padEnd(28).slice(0, 28)} ${g.difficulty.padEnd(6)} have ${String(g.have).padStart(3)}  need ${g.need}`);
  }

  if (dryRun) { console.log('\n--dry-run: nothing generated.'); return; }
  if (!gaps.length) { console.log('\nNothing to do.'); return; }

  // Math: free, instant, no model involved.
  let mathAdded = 0;
  let mathRejected = 0;
  const unservable = [];
  for (const g of mathGaps) {
    const rows = templateRows(g);
    if (!rows.length) { unservable.push(g); continue; }
    const r = await importTemplateRows(rows, institutionId);
    mathAdded += r.added;
    mathRejected += r.duplicates + (r.nearDuplicates || 0);
  }
  if (mathGaps.length) {
    console.log(`\nmath      +${mathAdded} added, ${mathRejected} rejected as duplicates (${MATH_TEMPLATES.length} templates, no model calls)`);
  }
  if (unservable.length) {
    console.log(`\n  No template covers these cells, so they stay short until one is written`);
    console.log('  (or generate them with the model instead):');
    for (const g of unservable) console.log(`    ${g.domain} / ${g.difficulty}  short ${g.need}`);
  }

  // Model-written questions (Reading & Writing, and math with --math-model):
  // batched at half price, then verified blind, then deduped.
  if (modelGaps.length) {
    if (!batchSupported(creds)) {
      console.log('\nmodel-written questions skipped: batches need an Anthropic key (Settings, or ANTHROPIC_API_KEY).');
    } else {
      const requests = [];
      for (const kind of ['rw', 'math']) {
        const cells = modelGaps.filter((g) => (kind === 'rw' ? g.section === 'rw' : g.section === 'math-model'));
        if (cells.length) requests.push(...await buildModelRequests(cells, kind));
      }
      console.log(`\nsubmitting ${requests.length} batch requests for ~${modelNeed} questions...`);
      const results = await runBatch(requests, {
        creds,
        onTick: (info) => info.batchId && console.log(`  batch ${info.batchId} submitted`),
      });
      const drafted = rowsFromBatch(results, requests);
      console.log(`  drafted ${drafted.length}`);

      // Same verification gate as the synchronous path: solve each item blind
      // and keep only the ones whose key survives.
      const verified = [];
      for (let i = 0; i < drafted.length; i += 20) {
        const slice = drafted.slice(i, i + 20);
        const verdicts = await verifyBatch(slice, { creds });
        slice.forEach((row, j) => { if (verifiedGenerated(row, verdicts[j])) verified.push({ ...row, verified: true }); });
      }
      const r = await importRows(verified, institutionId);
      console.log(`  verified ${verified.length}/${drafted.length}  ->  +${r.added} added, ${r.duplicates} duplicate, ${r.nearDuplicates || 0} near-duplicate`);
    }
  }

  const after = await counts(institutionId);
  const left = deficits(after);
  const blocked = new Set(unservable.map((g) => `${g.domain}|${g.difficulty}`));
  const fillable = left.filter((g) => !(g.section === 'math' && blocked.has(`${g.domain}|${g.difficulty}`)));
  const remaining = fillable.reduce((s, g) => s + g.need, 0);
  console.log(remaining
    ? `\nStill short by ${remaining} in fillable cells. Re-run to continue.`
    : '\nEvery fillable cell is at target.');
}

main()
  .catch((err) => { console.error(`\nFailed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end?.());
