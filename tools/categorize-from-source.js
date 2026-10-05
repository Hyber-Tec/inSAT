#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { domainForSkill } from '../server/lib/taxonomy.js';

const detectDomain = (question) => {
  const catStr = String(question.category || '0');
  
  // Clean category string - handle malformed values with newlines
  let num;
  try {
    num = parseInt(catStr.replace(/[^0-9]/g, ''), 10);
  } catch (e) { num = 0; }

  // Priority: Legacy reading codes per ClassMarker spec
  if ([1,2,3,4,5,6].includes(num)) return 'reading';
  
  // Geometry special cases
  if (num === 167 || num === 338) return 'geometry';
  
  // Main ranges from classifier
  if ((num >= 160) && (num <= 299)) return 'reading';
  if ([167, 168, 169].includes(num)) return 'problem-solving';
  if ((num >= 300) && (num <= 349)) return 'problem-solving';
  if ((num >= 350) && (num <= 399)) return 'algebra';
  if ((num >= 400)) return 'geometry';

  // Keyword fallback for unclassified
  const text = (question.question || '') + ' ' + (question.explanation || '').toLowerCase();
  if ((text.includes('linear') || text.includes('slope'])) return 'algebra';
  if ((text.includes('triangle') || text.includes('circle'))) return 'geometry';

  // Default low category numbers to problem-solving (math) if not reading/writing
  if (num > 0 && num < 160) return 'problem-solving';
  
  return null;
};

const main = async () => {
  console.log('=== Categorizing ClassMarker Questions ===\n');
  
  const sourcePath = process.argv[2] || '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  const sourceContent = fs.readFileSync(sourcePath).toString();
  const lines = sourceContent.trim().split('\n').filter(Boolean);
  
  const questions = [];
  for (const line of lines) {
    try {
      questions.push(JSON.parse(line));
    } catch (err) {
      // Skip malformed lines
      continue;
    }
  }

  const total = questions.length;
  console.log('Loaded ' + total + ' questions\n');

  const domainCounts = { reading: 0, geometry: 0, algebra: 0, problemSolving: 0, other: 0 };
  
  for (const q of questions) {
    if (!q.id) continue;
    
    const domain = detectDomain(q);
    q.domain = domain || 'other';
    
    if (domain === 'algebra') q.skill = 'Algebra';
    else if (domain === 'geometry') q.skill = 'Geometry/Trig';
    else if (domain === 'problem-solving') q.skill = 'Problem Solving';
    else if (domain === 'reading') q.skill = 'Reading/Writing';
    
    domainCounts[domain]++;
  }

  const classifiedCount = Object.values(domainCounts).reduce((a,b) => a+b, 0);
  
  console.log('=== Summary ===');
  console.log('Classified: ' + classifiedCount + '/' + total);
  for (const k in domainCounts) {
    if (domainCounts[k] > 0) console.log(k.padEnd(15) + ': ' + domainCounts[k]);
  }

  // Clean up artifact files from earlier runs
  const exportDir = './exports/classified-v3';
  for (const f of ['21373.jsonl', 'null.jsonl', 'problemSolving.jsonl']) {
    try { fs.unlinkSync(path.join(exportDir, f)); } catch(e) {}
  }

  const masterPath = path.join(exportDir, 'master.jsonl');
  const masterLines = questions.map(q => JSON.stringify({
    id: q.id || '',
    category: q.category || '',
    domain: q.domain,
    skill: q.skill,
    question: q.question || '',
    answer: q.answer || '',
    explanation: q.explanation || null,
  })).join('\n');
  
  fs.writeFileSync(masterPath, masterLines);
  console.log('\nMaster: ' + questions.length + ' questions -> master.jsonl\n');

  // Write domain files
  for (const [domain, count] of Object.entries(domainCounts)) {
    if (![null, 'other'].includes(domain) || count === undefined) continue;
    
    const filtered = questions.filter(q => q.domain === domain);
    if (filtered.length === 0) continue;
    
    const filepath = path.join(exportDir, domain + '.jsonl');
    fs.writeFileSync(filepath, filtered.map(q => JSON.stringify({
      ...q,
      topicFilter: domain,
    })).join('\n') || '');
    
    console.log(domain.padEnd(15) + ': ' + filtered.length + ' -> ' + filepath);
  }

  console.log('\n✅ Complete!');
};

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
