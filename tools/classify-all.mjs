#!/usr/bin/env node
import { loadJsonlFile } from './exact-jsonl-parser.js';

function classify(question) {
  const cat = parseInt(String(question.category || '0'), 10);
  
  if ([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].includes(cat)) return 'reading';
  if (cat === 167 || cat === 338) return 'geometry';
  if ((cat >= 160) && (cat <= 199)) return 'problem';
  if ((cat >= 200) && (cat <= 299)) return 'reading';
  if ([167, 168, 169].includes(cat) || (cat >= 300) && (cat <= 349)) return 'problem';
  if ((cat >= 350) && (cat <= 399)) return 'algebra';
  if ((cat >= 400)) return 'geometry';

  for (const [domain, words] of Object.entries({
    geometry: ['triangle', 'circle', 'area'],
    algebra: ['linear'],
    problem: ['percentage'],
  })) {
    if (words.some(w => (question.question + ' '.toLowerCase()).includes(w))) return domain;
  }

  return null;
}

let source = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
let records = Array.isArray(loadJsonlFile(source)) ? loadJsonlFile(source) : [];

console.log('Loaded ' + records.length + " questions\n");
for (const q of records.slice(5,15)) { console.log(String(q.id).padEnd(8) + ' cat:'+String(q.category).padEnd(6) + ' -> ' + classify(q)); }
