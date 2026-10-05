import * as taxonomy from './server/lib/taxonomy.js';

/**
 * Map ClassMarker numeric category ID to SAT domain/skill.
 * Uses pattern matching on: category string + content keywords + numeric ID ranges
 */
export function categorizeQuestion(question) { 
  const cat = String(question.category || '').split()[0] || '';
  
  // Helper: normalize for comparison
  const norm = (s) => String(s || '').toLowerCase().trim();
  const catNorm = norm(cat);

  // Reading/Writing categories (~numeric IDs in 211-240 range per earlier summary)  
  if (/^(rw|reading|writing|ideeas)/.test(catNorm)) {
    // Try to match reading/writing sub-skills from category text
    const skill = taxonomy.canonicalSkill('rw', question.text || catNorm);
    if (skill) return { domain: 'rw', skill };
    return { domain: 'rw', skill: null };
  }

  // Math categories - pattern match on content keywords
  for (const [domain, skills] of Object.entries(taxonomy.SKILLS.math)) {
    for (const skill of skills) {
      const sk = norm(skill);
      
      if (catNorm.includes('algebra') && sk.includes('linear')) return { domain, skill };
      if (catNorm.includes('quadratic')) return { domain: 'advanced-math', skill: 'Nonlinear equations in one variable and systems of equations in two variables' };
      if (catNorm.includes('exponential')) return { domain: 'advanced-math', skill: 'Nonlinear functions' };
      if (catNorm.includes('percent')) return { domain: 'problem-solving', skill: 'Percentages' };
      if (catNorm.includes('ratio') || catNorm.includes('probability') || catNorm.includes('statistic')) return { domain: 'problem-solving', skill: '' };  // needs more context
      if (catNorm.includes('triangle') || catNorm.includes('trigonometry')) return { domain: 'geometry-trig', skill: 'Right triangles and trigonometry' };
      if (sk) return { domain, skill };
    }
  }

  // Fallback: try to extract from category ID numeric pattern
  const parts = cat.split(/[\s\.\-]/);
  if (parts[0] && !isNaN(parseInt(parts[0]))) { 
    const numID = parseInt(parts[0]); 
    // ClassMarker convention: different numeric ranges for RW vs Math
    if (numID >= 211 && numID < 300) {
      // Rough mapping based on typical ID patterns  
      return { domain: 'rw', skill: null }; 
    } else {
      return { domain: 'math', skill: null };  // need content keywords for math
    }
  }

  return { domain: '', skill: '' };
}

/** Batch categorize a file, returning stats */
export async function batchCategorize(filePath) {
  const fs = await import('fs');
  
  let questionCount = 0;
  const stats = { total: 0, domains: {}, skills: {} };

  for (const line of fs.readFileSync(filePath).toString().trim().split('\n')) {
    if (!line) continue;
    
    const q = JSON.parse(line);
    const catResult = categorizeQuestion(q);
    
    stats.total++;
    questionCount++;
    
    if (!catResult.domain) continue;
    
    if (!stats.domains[catResult.domain]) stats.domains[catResult.domain] = 0;
    stats.domains[catResult.domain]++; 
    
    // Track skill too  
  }

  return stats;
}

export default { categorizeQuestion, batchCategorize };
