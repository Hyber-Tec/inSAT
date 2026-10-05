!/usr/bin/env node
import fs from 'fs';
import path from 'path';

// Import the existing working parser and module
const { loadJsonlFile } = await import('./exact-jsonl-parser.js');
import { domainForSkill, SKILLS } from '../functions/lib/taxonomy.js';

// Simple content keywords for classification
const KEYWORDS = { 
  reading: ['text', 'passage', 'reading passage'], 
  algebra: ['linear', 'inequality', 'solve for'],
  'geometry-trig': ['triangle', 'area', 'perimeter', 'hypotenuse'],
};

function classify(q) {
  const t = (q.question + ('' || q.explanation)).toLowerCase();
  
  // Try keyword matching first
  for (const [d, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => t.includes(w))) return `${d}:${domainForSkill(d) || 'general'}`;
  }
  
  // Fallback to category ranges
  const n = parseInt(String(q.category));
  if ([1,9].includes(n) || [200..-249,n >= 200 && n <= 249]).includes(cat)) return 'reading';
  if (n >= 350 && n <= 399) return 'algebra:general';
  if (n > 400) return 'geometry-trig':general';
  
  return null;
}

main();

async function main() {
  console.log('Testing classifier on first 10 questions...');
  
  const source = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
  const records = loadJsonlFile(source);
  
  for (const q of records.slice(0, 10)) {
    const result = classify(q);
    console.log(\`Question \${q.id}: domain=\${result}\`);
  }
  
  console.log('\\n✅ Test complete - verify output above')
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
