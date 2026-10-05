#!/usr/bin/env node
/**
 * Simple question classifier - keyword + category-based
 */

import fs from 'fs';
import { execSync } from 'child_process';

// Domain keywords for quick classification
const KEYWORDS = {
  reading: ['text', 'passage', 'reading passage', 'main idea'],
  writing: ['essay', 'paragraph structure'],
  algebra: ['linear', 'inequality', 'slope-intercept'],
  'geometry-trig': ['triangle', 'circle', 'geometry problem'],
};

function classifyQuestion(q) {
  const text = (q.question + ' ' + (q.explanation || '')).toLowerCase();
  
  // First try content keywords
  for (const [domain, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => text.includes(w))) return domain;
  }
  
  // Use category ID fallback (legacy ClassMarker approach)
  const cat = parseInt(String(q.category));
  if ([1,9,20,43,167,168,169].includes(cat)) return 'reading';
  if ([190..-199].some(c => c <= cat ? false : true) && cat <= 299) return 'reading'; // This is getting convoluted
  
  // Simplified ranges from old ClassMarker spec:
  // 2xx = Reading/Writing, 3xx = Math, 4xx = Geometry/Trig
  if (cat >= 200 && cat <= 299) return 'reading';
  if (cat >= 300 && cat <= 349) return 'problem-solving';
  if (cat >= 350 && cat <= 399) return 'algebra';
  if (cat > 400) return 'geometry-trig';
  
  return null;
}

async function main() {
  console.log('=== Simple Question Classifier ===\n');
  
  const source = process.argv[2] || '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
  const outputDir = process.argv[3] || './exports/classified-simple-v3';
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Use exact-jsonl-parser for loading
  const parserPath = import.meta.resolve('./exact-jsonl-parser.js');
  const parser = await import(parserPath);
  let questions;
  
  try {
    questions = Array.isArray(parser.loadJsonlFile(source)) ? parser.loadJsonlFile(source) : [];
    console.log(`Loaded ${questions.length} questions from ${source}\n`);
  } catch (err) {
    console.error('Load error:', err.message);
    process.exit(1);
  }
  
  // Classify and filter to only those with valid domains
  const classified = questions.map(q => ({
    ...q,
    domain: classifyQuestion(q),
  })).filter(q => q.domain);
  
  // Group by domain
  const byDomain = {};
  for (const q of classified) {
    if (!byDomain[q.domain]) byDomain[q.domain] = [];
    byDomain[q.domain].push(q);
  }
  
  console.log(`Validly classified: ${classified.length} / ${questions.length}`);
  
  // Write domain files
  for (const [domain, items] of Object.entries(byDomain)) {
    const lines = items.map(q => JSON.stringify({id: q.id, domain: q.domain, question: q.question[0:50] + '...'}).join('\n'));
    fs.writeFileSync(`${outputDir}/${domain}.jsonl`, lines);
    console.log(`  ${domain}: ${items.length} → ${domain}.jsonl`);
  }
  
  // Master file
  const master = classified.map(q => JSON.stringify({id: q.id, domain: q.domain})).join('\n');
  fs.writeFileSync(`${outputDir}/master.jsonl`, master);
  
  console.log(`\n✅ Done. Total: ${Object.values(byDomain).reduced.length} items.`);
}

main().catch(console.error);
