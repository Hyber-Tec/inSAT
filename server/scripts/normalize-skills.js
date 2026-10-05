// Rewrites every bank item's skill to the College Board's name for it (see
// SKILLS / canonicalSkill in lib/taxonomy.js), so per-skill accuracy adds up
// across sources: the College Board bank's folder names, the practice tests,
// the older template labels and free-text skills from generation all become
// one of the 29 skills. Labels that name no skill are reported, not guessed.
//
// Idempotent; safe to run any time.
//   node --env-file=.env scripts/normalize-skills.js [--dry-run]

import { pool, query } from '../lib/db.js';
import { canonicalSkill } from '../lib/taxonomy.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { rows } = await query(
    'SELECT domain, skill, count(*)::int AS n FROM pa_items GROUP BY domain, skill ORDER BY domain, skill',
  );
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
    if (!dryRun) {
      await query('UPDATE pa_items SET skill = $1 WHERE domain = $2 AND skill = $3', [skill, r.domain, r.skill]);
    }
    changed += r.n;
  }
  console.log(`\n${changed} items ${dryRun ? 'would be' : ''} relabelled`);
  for (const r of unknown) console.log(`  unrecognized: ${r.domain}: "${r.skill}" (${r.n} items)`);
}

main()
  .catch((err) => { console.error(`Failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end?.());
