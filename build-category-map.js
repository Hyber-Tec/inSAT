/**
 * Build Category ID → SAT Domain/Skill mapping table from your question bank
 * Usage: node build-category-map.js /Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl
 */
import fs from 'fs';

const SAMPLES = 1000;  // Read first N questions to build lookup

const QUESTION_CONTENT_KEYWORDS = {
  algebra: ['linear', 'solve for x', 'inequality', 'system of equations', 'slope', 'y-intercept'],
  'advanced-math': ['quadratic', 'parabola', 'vertex', 'exponential', 'logarithm', 'composition', 'discriminant'],  
  'problem-solving': ['ratio', 'percentage', 'probability', 'mean', 'median', 'mode', 'data set', 'sample space'],
  'geometry-trig': ['triangle', 'circle', 'area', 'volume', 'congruent', 'angles degrees', 'pythagorean'],
};

function analyzeQuestion(question) { 
  const text = (question.question || '') + " " + (question.explanation || '').toLowerCase();
  const catNumStr = String(question.category).split(' ').filter(n => !isNaN(parseInt(n))).join('');
  
  // Check each skill/domain for keywords
  for (const [domain, skills] of Object.entries(QUESTION_CONTENT_KEYWORDS)) {
    const match = skills.find(kw => text.includes(kw));
    if (match) return domain;
  }

  return null;
}

// Read and build mapping table
const jsonlPath = process.argv[2] || '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
let categoryMap = {};

if (!fs.existsSync(jsonlPath)) {
  console.error('Error: JSONL file not found');
  process.exit(1);
}

const text = fs.readFileSync(jsonlPath).toString();
const questions = text.trim().split('\n').map(line => JSON.parse(line)).slice(SAMPLES); // Skip first SAMPLES

console.log(`\nBuild Category ID → Domain mapping (${SAMPLES}+ questions)...\n`);

// Process and deduplicate
questions.forEach(q => { 
  const catNum = String(q.category)?.split(' ').filter(n => !isNaN(parseInt(n))).join('') || '0';
  const domain = analyzeQuestion(q);
  
  if (domain && !categoryMap[catNum]) {
    categoryMap[catNum] = { domain, skill: '' };
  }
});

// Output mapping table
console.log('# ClassMarker Category ID → SAT Domain Mapping');  
console.log('Format: CATEGORY_ID | DOMAIN | SKILL\n');

Object.entries(categoryMap).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([id, info]) => {  
  console.log(`"${id}" | "${info.domain}" | ${info.skill || '(pending skill lookup)'});`); 
});

console.log(`\n✅ Mapped ${Object.keys(categoryMap).length} unique Category IDs`);  
