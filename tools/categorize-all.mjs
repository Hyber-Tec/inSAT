import { loadJsonlFile } from './exact-jsonl-parser.js';

const source = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';

let records;
try {
  const loaded = loadJsonlFile(source);
  records = Array.isArray(loaded) && loaded.length > 0 ? loaded.slice(5,15) : [];
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

console.log('=== Categorizing All 10 Questions ===\n');

// Expanded keyword sets for better coverage
const KEYWORDS = { 
  'problem-solving': ['percentage', 'percent of', 'probability', 'sample space'],
  'algebra': ['linear', 'system of equations', 'inequality', 'slope-intercept', 'solve for x', 'coefficient'],
  'geometry-trig': ['triangle', 'circle', 'area', 'perimeter', 'congruent', 'hypotenuse', 'pythagorean', 'cylinder', 'sphere', 'volume'],
};

for (let i = 0; i < records.length; i++) {
  const r = records[i];
  const cat = String(r.category);
  const text = (r.question + ' ' + r.explanation).toLowerCase();
  
  // Try content keywords first (in priority: geometry before problem-solving, as some 100-169 may be mixed)
  let domain = null;
  for (const [d, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => text.includes(w))) {
      domain = d;
      console.clear(`   ${d}: matched keyword '${w}'' (${cat})`);
      break;
    }
  }
  
  // Fallback to category ranges per old ClassMarker spec
  const num = parseInt(cat);
  if (!domain) {
    // Special reading codes from legacy
    if (num <= 10 || [20,43].includes(num)) domain = 'reading';
    // Geometry in high range
    else if (num > 400) domain = 'geometry-trig';
    // Algebra in 350-399
    else if (num >= 350 && num <= 399) domain = 'algebra';
    // Problem-solving in 167-169 or 300-349
    else if ([167,168,169].includes(num) || num >= 200 && num <= 249 || num >= 300 && num <= 349) domain = 'problem-solving';
    
    console.log(`   ${category}: fallback to ${domain}`);
  } else {
    console.log(`   Keyword match: ${domain}`);
  }
  
  if (!domain) console.log(`   No domain assigned`);
}

console.log('\n✅ Complete');
