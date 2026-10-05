// Grow an institution's practice pool with verified variations of its own
// math questions (lib/variation).
//
//   node --env-file-if-exists=.env.local scripts/vary-bank.js --institution satify
//   node --env-file-if-exists=.env.local scripts/vary-bank.js --institution satify --import
//
// From functions/; the emulators when FIRESTORE_EMULATOR_HOST is set,
// production otherwise.
//
// Every original math question without a figure is read by the engine. It is
// used only when the engine understands it: every piece of math parses, the
// question matches a form the engine knows, and solving it exactly gives the
// source's own key. Each understood question yields up to --per-source
// variants: the same wording and structure with new numbers, re-solved,
// given wrong answers from named mistakes and a worked explanation, and then
// checked again independently from the rendered text. The batch is written
// out for review first:
//
//   questions.jsonl   the variants, with their source and classification
//   coverage.json/md  what the engine understood, by skill and by source
//   manifest.json     counts, and the bank ids once imported
//
// --import adds the batch to the bank as source 'variant', each row linked to
// its source (variant_of) and carrying its realism rating, so assembly never
// puts a question and its variant in one form. Re-running tops every source
// up to --per-source; --replace makes every source's full set again and
// syncs the bank to it: an identical question is kept (or brought back), one
// the engine no longer makes is retired (never deleted: a served question
// stays in its session).
//
// Options: --per-source N (3), --skill "<skill>", --limit N (sources),
// --min-realism N (3), --seed N, --output DIR, --import, --replace.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { target } from '../lib/firebase.js';
import { COL, col, getMany, queryRows, writeAll } from '../lib/store.js';
import { touched } from '../lib/pool.js';
import { contentHash, importRows } from '../lib/items.js';
import { domainForSkill } from '../lib/taxonomy.js';
import { understand, vary, ENGINE_VERSION } from '../lib/variation/engine.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const slug = arg('institution', 'satify');
const perSource = Number(arg('per-source', '3'));
const onlySkill = arg('skill', null);
const limit = Number(arg('limit', '0')) || Infinity;
const baseSeed = Number(arg('seed', '20260930'));
const output = path.resolve(arg('output', `../exports/variants-${new Date().toISOString().slice(0, 10)}`));
const shouldImport = flag('import');
// Questions rated 2 or lower for reading like the SAT (garbled or off-format
// sources) are not worth copying.
const minRealism = Number(arg('min-realism', '3'));
const replace = flag('replace');

/** A seed per source, so a rerun makes the same variants (and dedupes them). */
const seedFor = (id, round) => crypto.createHash('sha256').update(`${baseSeed}:${id}:${round}`).digest().readUInt32BE(0);

async function main() {
  if (!Number.isInteger(perSource) || perSource < 1 || perSource > 20) throw new Error('--per-source must be an integer from 1 to 20');
  const [institution] = await queryRows(col(COL.institutions).where('slug', '==', slug).limit(1));
  if (!institution) throw new Error(`Unknown institution: ${slug}`);
  const inst = institution.id;

  // The bank, read once: its original math questions are the sources, its
  // variants are what a rerun tops up or syncs, and every hash it holds is a
  // question not to make again.
  const bank = await queryRows(col(COL.items).where('institution_id', '==', inst).select(
    'section', 'source', 'variant_of', 'retired_at', 'asset_id', 'figure', 'domain', 'skill', 'difficulty',
    'question', 'choices', 'correct_idx', 'answer_type', 'answer_text', 'accepted', 'realism', 'rationale', 'content_hash',
  ));
  const dashes = /-{3,}/;
  const sources = bank
    .filter((r) => r.section === 'math' && r.source === 'original' && !r.variant_of && !r.retired_at && !r.asset_id && !r.figure
      && (onlySkill === null || r.skill === onlySkill) && (r.realism ?? 4) >= minRealism
      && !dashes.test(r.question) && !dashes.test(JSON.stringify(r.choices)))
    .sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // With --replace the batch is made whole (every source's full set) and the
  // bank is synced to it below; otherwise existing variants count toward
  // --per-source and only the shortfall is made.
  const variantHashes = new Map(bank.filter((r) => r.source === 'variant').map((r) => [r.content_hash, r]));
  const hashes = new Set(bank.map((r) => r.content_hash).filter((h) => !(replace && variantHashes.has(h))));
  const existing = new Map();
  if (!replace) {
    for (const r of bank) if (r.source === 'variant' && !r.retired_at) existing.set(r.variant_of, (existing.get(r.variant_of) || 0) + 1);
  }

  const rows = [];
  const records = [];
  const coverage = [];
  let considered = 0;
  for (const src of sources) {
    if (considered >= limit) break;
    considered += 1;
    const u = understand(src);
    const entry = { id: src.id, skill: src.skill, difficulty: src.difficulty, understood: u.ok, reason: u.ok ? null : u.reason, variants: 0, existing: existing.get(src.id) || 0 };
    coverage.push(entry);
    if (!u.ok) continue;
    entry.ask = u.kind === 'word' ? 'word' : u.model.ask.kind;
    const want = perSource - entry.existing;
    if (want <= 0) continue;
    // A couple of rounds, in case a draw repeats a question already banked.
    for (let round = 0; round < 3 && entry.variants < want; round += 1) {
      const out = vary(u, { count: want - entry.variants, seed: seedFor(src.id, round) });
      entry.classification = out.classification;
      if (!out.variants.length && round === 0) entry.reason = Object.entries(out.rejected).sort((a, b) => b[1] - a[1])[0]?.[0] || 'no variant';
      for (const v of out.variants) {
        const hash = contentHash({ section: 'math', question: v.question, choices: [...v.choices].sort(), passage: null });
        if (hashes.has(hash)) continue;
        hashes.add(hash);
        // A variant keeps its source's skill when the question's structure
        // supports it; otherwise it takes the structural classification.
        const skills = out.classification.skills;
        const skill = skills.includes(src.skill) ? src.skill : skills[0];
        const row = {
          content_hash: hash,
          section: 'math',
          domain: domainForSkill(skill),
          skill,
          difficulty: src.difficulty,
          passage: null,
          question: v.question,
          choices: v.choices,
          correct_idx: v.correctIdx,
          answer_type: v.answerType,
          answer_text: v.answerText || null,
          accepted: v.accepted || null,
          rationale: { ...v.rationale, variation: { of: src.id, engine: ENGINE_VERSION, params: v.params } },
          figure: null,
          svg: null,
          image_ref: null,
          source: 'variant',
          verified: true,
          realism: src.realism ?? null,
          variant_of: src.id,
        };
        rows.push(row);
        records.push({
          ...row,
          sourceSkill: src.skill,
          reclassified: skill !== src.skill ? { from: src.skill, to: skill } : null,
          verification: v.verification,
        });
        entry.variants += 1;
        if (entry.variants >= want) break;
      }
    }
  }

  const summary = summarize(coverage, rows);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'questions.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  fs.writeFileSync(path.join(output, 'coverage.json'), JSON.stringify({ summary, sources: coverage }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'coverage.md'), coverageMarkdown(summary));

  let imported = null;
  let bankIds = [];
  if (shouldImport && (rows.length || replace)) {
    console.log(`writing to ${target()}`);
    let restored = 0;
    let retired = 0;
    const fresh = rows.filter((r) => !variantHashes.has(r.content_hash));
    if (replace) {
      // Sync: the same question comes back, a dropped one is retired (never
      // deleted: a served question stays in its session).
      const keep = new Set(rows.map((r) => r.content_hash));
      const writes = [];
      for (const [hash, v] of variantHashes) {
        if (keep.has(hash) && v.retired_at) { writes.push(['update', col(COL.items).doc(v.id), { retired_at: null, ...touched() }]); restored += 1; }
        if (!keep.has(hash) && !v.retired_at) { writes.push(['update', col(COL.items).doc(v.id), { retired_at: new Date(), ...touched() }]); retired += 1; }
      }
      await writeAll(writes);
    }
    imported = { ...(await importRows(fresh, inst, { nearDuplicates: 'allow' })), restored, retired };
    const locks = await getMany(COL.itemHashes, rows.map((r) => `${inst}_${r.content_hash}`));
    bankIds = [...locks.values()].map((lock) => ({ id: lock.item_id, content_hash: lock.id.slice(inst.length + 1) }));
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    institution: slug,
    engine: ENGINE_VERSION,
    method: 'Each source is solved exactly and must reproduce its own key; each variant is re-read from its rendered text and solved again numerically before it is kept.',
    perSource,
    seed: baseSeed,
    sources: summary.sources,
    understood: summary.understood,
    varied: summary.varied,
    variants: rows.length,
    imported,
    bankIds,
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, sources: summary.sources, understood: summary.understood, varied: summary.varied, variants: rows.length, imported }));
}

function summarize(coverage, rows) {
  const bySkill = {};
  for (const c of coverage) {
    const s = (bySkill[c.skill] ||= { sources: 0, understood: 0, varied: 0, variants: 0 });
    s.sources += 1;
    if (c.understood) s.understood += 1;
    if (c.variants || c.existing) s.varied += 1;
  }
  for (const r of rows) (bySkill[r.skill] ||= { sources: 0, understood: 0, varied: 0, variants: 0 }).variants += 1;
  const reasons = {};
  for (const c of coverage) if (c.reason) reasons[c.reason] = (reasons[c.reason] || 0) + 1;
  return {
    sources: coverage.length,
    understood: coverage.filter((c) => c.understood).length,
    varied: coverage.filter((c) => c.variants || c.existing).length,
    variants: rows.length,
    reclassified: rows.filter((r) => r.variant_of && r.skill !== coverage.find((c) => c.id === r.variant_of)?.skill).length,
    bySkill,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 25),
  };
}

function coverageMarkdown(s) {
  const lines = [
    '# Variation coverage',
    '',
    `${s.sources} source questions read; ${s.understood} understood (the engine's own solution reproduces the key); ${s.varied} with at least one verified variant; ${s.variants} variants in this batch${s.reclassified ? `, ${s.reclassified} filed under a different skill than their source` : ''}.`,
    '',
    '| Skill | Sources | Understood | Varied | Variants |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(s.bySkill).sort((a, b) => a[0].localeCompare(b[0])).map(([skill, v]) => `| ${skill} | ${v.sources} | ${v.understood} | ${v.varied} | ${v.variants} |`),
    '',
    '## Why questions were left alone',
    '',
    '| Reason | Questions |',
    '| --- | ---: |',
    ...s.reasons.map(([why, n]) => `| ${why.replace(/\|/g, '\\|')} | ${n} |`),
    '',
  ];
  return lines.join('\n');
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
