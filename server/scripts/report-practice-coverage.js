// Inventory of the actual student pool, including deficits at each difficulty.
import fs from 'node:fs';
import path from 'node:path';
import { query, pool } from '../lib/db.js';
import { DOMAINS, SKILLS } from '../lib/taxonomy.js';
import { hasTemplates } from '../lib/templateItems.js';
const slug = process.argv[2] || 'satify';
const output = path.resolve(process.argv[3] || '../stats/practice-coverage');
const target = 20;
try {
  const { rows } = await query(`SELECT section, domain, skill, difficulty, verified, count(*)::int AS n
    FROM pa_items WHERE institution_id=(SELECT id FROM pa_institutions WHERE slug=$1)
    AND retired_at IS NULL AND source <> 'reference' GROUP BY section,domain,skill,difficulty,verified`, [slug]);
  const cells = Object.entries(DOMAINS).flatMap(([section, domains]) => domains.flatMap((domain) => SKILLS[domain].flatMap((skill) => ['easy', 'medium', 'hard'].map((difficulty) => {
    const matching = rows.filter((r) => r.section === section && r.domain === domain && r.skill === skill && r.difficulty === difficulty);
    const count = matching.reduce((n, r) => n + r.n, 0);
    return { section, domain, skill, difficulty, count, verified: matching.filter((r) => r.verified).reduce((n, r) => n + r.n, 0), deficit: Math.max(0, target - count), canGenerateFromTemplate: hasTemplates(domain, skill, difficulty) };
  }))));
  const report = { generatedAt: new Date().toISOString(), institution: slug, targetPerSkillDifficulty: target, total: rows.reduce((n, r) => n + r.n, 0), coveredSkills: new Set(cells.filter((c) => c.count).map((c) => c.skill)).size, totalSkills: 29, cellsBelowTarget: cells.filter((c) => c.deficit).length, emptyCells: cells.filter((c) => !c.count).length, cells };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Practice pool coverage', '', `Institution: ${slug}. Active questions: ${report.total}. Skills with questions: ${report.coveredSkills}/29.`, '', `Target: ${target} questions per skill and difficulty (two ten-question sets). ${report.cellsBelowTarget}/87 cells are below target; ${report.emptyCells} have no stored questions. Template availability is reported separately from stored inventory.`, '', 'These counts describe supply, not a new independent audit of previously imported questions.', '', '| Skill | Easy | Medium | Hard | Below target |', '| --- | ---: | ---: | ---: | ---: |'];
  for (const skill of new Set(cells.map((c) => c.skill))) {
    const group = cells.filter((c) => c.skill === skill);
    lines.push(`| ${skill} | ${group[0].count} | ${group[1].count} | ${group[2].count} | ${group.reduce((n, c) => n + c.deficit, 0)} |`);
  }
  fs.writeFileSync(`${output}.md`, lines.join('\n') + '\n');
  console.log(JSON.stringify({ total: report.total, coveredSkills: report.coveredSkills, cellsBelowTarget: report.cellsBelowTarget, emptyCells: report.emptyCells, output }));
} finally { await pool.end(); }
