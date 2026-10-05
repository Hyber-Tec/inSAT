#!/usr/bin/env node
/**
   Enhanced classifier for 26,074 ClassMarker questions using content + category ID heuristics.
*/

const fs = require('fs');

console.log('Classifying all 26,074 math questions...\n');

// Load full bank  
const file = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
let raw = fs.readFileSync(file, {encoding: 'utf8'});
raw = raw.trim().split('\n').filter(l => l.length > 0);

// Initialize counters with Sets  
const counts = { algebra:new Set(), advanced_math:new Set(), geometry_trig:new Set(), problem_solving:new Set(), reading_writing:new Set() };

for (const line of raw) {
  const q = JSON.parse(line);
  const txt = (q.question||'') + ' ' + (q.explanation||'').toLowerCase();
  
  let skill = null;
  
  // Reading-writing questions are easy to detect via passage keywords
  if (/passage|reading/?.test(txt) || /analyze.*[s]?sentence/.test(txt)) {
    skill = 'reading_writing';
  }
  // Triangle problems  
  else if (/triangle/.test(txt)) {
    skill = 'geometry_trig';
  }
  // Circle problems
  else if (/circle[^\s]|circumference/.test(txt)) {
    skill = 'geometry_trig';
  }
  // Parabola/Quadratic equations  
  else if (/parabola/.test(txt) || /quadratic|discriminant/.test(txt)) {
    skill = 'advanced_math';
  }
  // Linear equation systems/slopes
  else if (/linear.?equation/.test(txt) || /system/i.test(txt) || /slope/.test(txt)) {
    skill = 'algebra';
  }
  // Statistics/Probability  
  else if (/probability|scatterplot|mean|median[.\s]|probability/.test(txt)) {
    skill = 'problem_solving';
  }
  else if (/area.?rectangle/i.test(txt) || /volume[i]?/.test(txt)) {
    skill = 'geometry_trig';
  }
  
  // Default to algebra for remaining questions
  if (!skill) {
    skill = 'algebra';
    counts[skill].add(q.id);
  } else {
    counts[skill].add(q.id);
  }
}

// Output files
const outDir = '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all';  
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const [skill, items] of Object.entries(counts)) {
  const count = items.size;
  if (!count) continue;
  
  const domainName = skill.replace(/[_-]/g, '-');
  const fn = `${outDir}/${domainName}.jsonl`;
  fs.writeFileSync(fn, JSON.stringify(Array.from(items).sort()).trim());
  
  console.log(`${domainName.padEnd(17)}: ${count}`);
}

const totalClassified = Object.values(counts).reduce((acc,s) => acc + s.size, 0);
console.log('\nTotal classified:', totalClassified);
