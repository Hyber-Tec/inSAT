// Rewrites every bank item's skill to the College Board's name for it (see
// SKILLS / canonicalSkill in lib/taxonomy.js), so per-skill accuracy adds up
// across sources: the College Board bank's folder names, the practice tests,
// the older template labels and free-text skills from generation all become
// one of the 29 skills. Labels that name no skill are reported, not guessed.
//
// Idempotent; safe to run any time.
//   node --env-file-if-exists=.env.local scripts/normalize-skills.js [--dry-run]
// (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set, production otherwise)

import { target } from '../lib/firebase.js';
import { COL, col, writeAll } from '../lib/store.js';
import { touched } from '../lib/pool.js';
import { canonicalSkill } from '../lib/taxonomy.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const items = (await col(COL.items).select('domain', 'skill').get()).docs;
  const groups = new Map();
  for (const d of items) {
    const key = `${d.get('domain')}|${d.get('skill')}`;
    if (!groups.has(key)) groups.set(key, { domain: d.get('domain'), skill: d.get('skill'), n: 0, refs: [] });
    const g = groups.get(key);
    g.n += 1;
    g.refs.push(d.ref);
  }
  const rows = [...groups.values()].sort((a, b) => (a.domain + '|' + a.skill < b.domain + '|' + b.skill ? -1 : 1));
  if (!dryRun) console.log(`writing to ${target()}\n`);
  let changed = 0;
  const unknown = [];
  for (const r of rows) {
    const skill = canonicalSkill(r.domain, r.skill);
    if (!skill) {
      if (r.skill) unknown.push(r);
      continue;
    }
    if (skill === r.skill) continue;
    console.log(`${String(r.n).padStart(5)}  ${r.domain}: "${r.skill}" -> "${skill}"`);
    if (!dryRun) await writeAll(r.refs.map((ref) => ['update', ref, { skill, ...touched() }]));
    changed += r.n;
  }
  console.log(`\n${changed} items ${dryRun ? 'would be' : ''} relabelled`);
  for (const r of unknown) console.log(`  unrecognized: ${r.domain}: "${r.skill}" (${r.n} items)`);
}

main()
  .catch((err) => { console.error(`Failed: ${err.message}`); process.exitCode = 1; });
