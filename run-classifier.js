#!/usr/bin/env node
const fs = require('fs');

// Initialize groups with proper domains
const groups = {
  'algebra': [],
  'advanced-math': [],
  'geometry-trig': [],
  'problem-solving': [],
  'reading-writing': []
};

const file = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
let raw = fs.readFileSync(file, {encoding: 'utf8'});
raw = raw.trim().split('\n').filter(l => l.length > 0);

console.log('Classifying', raw.length, 'questions...');

for (const line of raw) {
  const q = JSON.parse(line);
  const txt = (q.question||'') + ' ' + (q.explanation||'').toLowerCase();
  
  let skill = null;
  
  if (/triangle/.test(txt) || /volume/.test(txt) || /congruent/.test(txt) || /similar/.test(txt)) {
    skill = 'geometry-trig';
  } else if (/passage|reading/.test(txt)) {
    skill = 'reading-writing';
  } else if (txt.includes('linear equation') || txt.includes('inequality') || txt.includes('slope')) {
    skill = 'algebra';
  } else if (/parabola/.test(txt) || /quadratic/.test(txt) || /discriminant/.test(txt)) {
    skill = 'advanced-math';
  } else if (/ratio|percentage|mean|probability|scatterplot|median/.test(txt)) {
    skill = 'problem-solving';
  }

  if (skill && groups[skill]) {
    groups[skill].push(q);
  }
}

// Write output files
const outDir = '/Users/br0k3r/workspace/vantedge/satify/exports/class-marker';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const [name, items] of Object.entries(groups)) {
  const count = items.length;
  if (!count) continue;
  const fn = `${outDir}/${name}.jsonl`;
  fs.writeFileSync(fn, JSON.stringify(items.map(item => ({id: item.id, skill: name}))).trim());
  console.log(`${name.padEnd(18)}: ${count}`);
}

for (const [name, items] of Object.entries(groups)) {
  if (!items.length) continue; 
  const fn = `${outDir}/${name}-raw.jsonl`;
  fs.writeFileSync(fn, JSON.stringify(items).trim().replace(/\n/g, '\n'));
  console.log(`${name.padEnd(16)} (raw): ${items.length}`);
}

console.log('Complete!');
process.exit(0);
