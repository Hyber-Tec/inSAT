/**
 * Generate classified question exports from source content
 * Produces per-domain JSONL files and enhanced master file
 */

import fs from 'fs';
import path from 'path';
import { loadJsonlFile } from './exact-jsonl-parser.js';
import { domainForSkill, SKILLS } from '../server/lib/taxonomy.js';

// Domain detection heuristics combining category ID and content analysis
const DETECT_DOMAIN = (category) => {
  if (!category) return null;
  
  const num = parseInt(category);
  if (isNaN(num)) return null;
  
  // Reading/Writing categories
  if ((num <= 10) || 
      (num >= 160 && num <= 199) || 
      (num >= 200 && num <= 299)) {
    return 'reading';
  }
  
  // Problem-Solving categories (often 3xx but can be lower codes)
  if ((num >= 167 && num <= 169) ||
      (num >= 300 && num <= 349)) {
    return 'problem-solving';
  }
  
  // Algebra categories
  if ((num >= 350 && num <= 399)) {
    return 'algebra';
  }
  
  // Geometry/Trig categories  (often 4xx)
  if (num > 400) {
    return 'geometry-trig';
  }
  
  // For very low category numbers (1-9), use content analysis
  if (num <= 10) return null;
  
  return null; // Will be assigned by content keywords below
};

const CONTENT_KEYWORDS = {
  reading: ['text', 'passage', 'reading', 'author', 'sentence structure', 'main idea'],
  writing: ['paragraph', 'essay', 'composition', 'writing prompt', 'conclusion'],
  algebra: ['linear', 'system of equations', 'inequality', 'slope-intercept', 'coefficient'],
  'advanced-math': ['quadratic', 'parabola', 'vertex', 'exponential', 'logarithm', 'combinatorics'],
  'problem-solving': ['ratio', 'percentage', 'probability', 'mean', 'median', 'sample space'],
  'geometry-trig': ['triangle', 'circle', 'area', 'volume', 'congruent', 'hypotenuse', 'pythagorean'],
};

function detectDomain(question) {
  const qText = (question.question || '') + ' ' + (question.explanation || '').toLowerCase();
  
  // First try category ID based classification
  const domain = DETECT_DOMAIN(String(question.category));
  if (domain && domain !== null) return domain;
  
  // Fallback to content keyword matching for low-category or unassigned questions
  for (const [domain, keywords] of Object.entries(CONTENT_KEYWORDS)) {
    const matches = keywords.filter(kw => qText.includes(kw)).length;
    if (matches >= 1) return domain;
  }
  
  return null;
}

function determineDifficulty(question) {
  // Simple heuristic based on question complexity indicators
  const qText = (question.question || '').toLowerCase();
  const difficultyHints = {
    'easy': ['select the', 'which of the following', '( )' ],
    'medium': ['solve for', 'find x', 'what is'],
    'hard': ['complex', 'challenging', 'difficult', 'multi-step equations', 'prove that'],
  };
  
  let score = 1; // default medium
  for (const [level, hints] of Object.entries(difficultyHints)) {
    if (hints.some(h => qText.includes(h))) score++;
  }
  
  const levels = ['easy', 'medium', 'hard'];
  return levels[Math.min(score - 1, 2)] || 'medium';
}

function extractTopic(question) {
  const skill = domainForSkill(detectDomain(question));
  
  // Generate more specific topic names from question content
  const qText = (question.question || '').toLowerCase();
  let topic = '';
  
  // Topic extraction based on keywords
  for (const [domain, keywords] of Object.entries(CONTENT_KEYWORDS)) {
    if (!skill && domainForSkill(domain) === skill) continue;
    
    for (const kw of keywords) {
      if (qText.includes(kw)) {
        // Convert keyword to readable topic name
        const topicName = kw.replace(/-/g, ' ');
        return `${domain}:${topicName.replace(/\s+/g, '-')}`;
      }
    }
  }
  
  // Default to domain name
  return skill || domain || 'unknown';
}

async function main() {
  console.log('\n=== Generating Classified Question Exports ===\n');
  
  const sourcePath = process.argv[2] || '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }
  
  const exportPath = process.argv[3] || './exports/classified-all-v2';
  fs.mkdirSync(exportPath, { recursive: true });
  const masterPath = path.join(exportPath, 'master.jsonl');
  
  console.log(`Source: ${sourcePath}`);
  console.log(`Output dir: ${exportPath}\n`);
  
  // Load all questions from source
  let questions;
  try {
    const records = loadJsonlFile(sourcePath);
    questions = Array.isArray(records) ? records : [];
    console.log(`Loaded ${questions.length} questions\n`);
  } catch (err) {
    console.error(`Error loading source: ${err.message}`);
    process.exit(1);
  }
  
  // Categorize each question
  const categorized = questions.map(q => {
    const domain = detectDomain(q);
    const skill = domain ? domainForSkill(domain) : null;
    return { ...q, domain, skill };
  });
  
  // Filter to only categorized questions (with valid domain)
  const hasDomain = categorized.filter(q => q.domain && q.skill).length;
  const totalQuestions = categorized.length;
  console.log(`Categorized ${hasDomain} with domain+skill, excluding ${totalQuestions - ((categorized.filter(q=>q.domain).length))} without skills (reading/writing often lack skill matches)\n`);
  
  // Group by domain (include all with valid domain)
  const byDomain = {};
  for (const q of categorized) {
    if (!q.domain) continue;
    
    if (!byDomain[q.domain]) byDomain[q.domain] = [];
    byDomain[q.domain].push(q);
  }
  
  // Write individual domain exports
  for (const [domain, questions] of Object.entries(byDomain)) {
    const filepath = path.join(exportPath, `${domain}.jsonl`);
    
    // Convert to proper JSONL format with skill metadata
    const lines = questions.map(q => 
      JSON.stringify({
        id: q.id || '',
        category: q.category || '',
        domain: q.domain,
        skill: q.skill,
        difficulty: determineDifficulty(q),
        topic: extractTopic(q),
        question: q.question || '',
        choices: q.choices || [],
        answer: q.answer || '',
        explanation: q.explanation || null,
        source: 'classmarker',
      })
    ).join('\n');
    
    fs.writeFileSync(filepath, lines);
    console.log(`  ${domain}: ${questions.length} → ${filepath}`);
  }
  
  // Write master file (all domains combined)
  const allLines = categorized.map(q => 
    JSON.stringify({
      id: q.id || '',
      category: q.category || '',
      domain: q.domain,
      skill: q.skill,
      difficulty: determineDifficulty(q),
      topic: extractTopic(q),
      question: q.question || '',
      choices: q.choices || [],
      answer: q.answer || '',
      explanation: q.explanation || null,
      source: 'classmarker',
    })
  ).join('\n');
  
  fs.writeFileSync(masterPath, allLines);
  console.log(`\nMaster file: ${hasDomain} lines → ${masterPath}`);
  
  // Output summary statistics
  console.log('\n=== Summary ===');
  for (const [domain, count] of Object.entries(byDomain)) {
    const pct = ((count / hasDomain) * 100).toFixed(1);
    console.log(`  ${domain}: ${count} (${pct})`);
  }
  
  // Skill breakdown within math domains
  console.log('\n=== Math Skills Breakdown ===');
  for (const domain of ['algebra', 'geometry-trig', 'advanced-math']) {
    const mathQs = byDomain[domain]?.map(q => q.skill) || [];
    const uniqueSkills = [...new Set(mathQs)];
    console.log(`  ${domain} has ${uniqueSkills.length} unique skills: ${uniqueSkills.join(', ')}`);
  }
  
  console.log('\n✅ Complete! All files regenerated.');
  console.log(`   Total questions processed: ${hasDomain}`);
  console.log(`   Files generated: ${Object.keys(byDomain).length + 1} (master.jsonl included)`);
  
  return categorized;
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
