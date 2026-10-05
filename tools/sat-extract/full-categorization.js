/**
   Full Question Bank Categorization
   Maps ClassMarker Category IDs (from extracted questions) to:
   1. The College Board official topic (e.g., "Linear equations in one variable")
   2. The insat domain/skill
   
   Usage: node full-categorization.js /path/to/questions.jsonl > categorization-results.jsonl
*/

import fs from 'fs';
import * as taxonomy from '../../server/lib/taxonomy.js';

// ClassMarker Category ID patterns → College Board official skill names
const CATEGORY_ID_TO_CB_SKILL = {
  // Algebra topics (0-400 range mostly)
  "2": "Linear equations in one variable",  
  "8": "Linear equations in two variables",
  "172": "Linear functions",
  "209": "Linear inequalities",
  "321": "Systems of two linear equations in two variables",
  
  // Advanced Math - nonlinear functions/exponentials
  "4": "Nonlinear functions (exponential decay)",
  "6": "Nonlinear equations in one variable and systems...",
  "92": "Nonlinear functions",
  
  // Problem-solving / Data analysis - percentages, statistics
  "120": "Percentages",
  "122": "One-variable data: Distributions and measures of center and spread",
  "265": "Ratios, rates, proportional relationships, and units",
  
  // Geometry/Trig topics 
  "338": "Lines, angles, and triangles (congruency)",
  "219": "Right triangles and trigonometry",
  "167": "Area and volume",
};

/**
   Analyze a question's text to determine its College Board skill.
   Uses keyword matching against official SAT skill lists from taxonomy.js.
*/
function identifySkill(question) { 
  const text = (question.question || '') + " " + (question.explanation || '').toLowerCase();
  
  // Try all math domains' official skills as keywords
  for (const domain of ['algebra', 'advanced-math', 'problem-solving', 'geometry-trig']) { 
    for (const skill of taxonomy.SKILLS[domain]) {
      const normalizedSkill = skill.toLowerCase().replace(/[-./]/g, ': ').trim();
      
      // Check if skill keywords appear in question text  
      // For advanced-math skills with colons: "Exponential growth and decay" → check for "exponential", "growth", "decay"
      const subskills = normalizedSkill.split(': ');
      const foundKeyword = subskills.reduce((found, part) => {
        // Remove 'and'/'or' which are often in skill names but not in questions  
        return found || [part.trim().replace(/\s+and+/g, '').replace(/\s+or+/g, '').replace(/\s+/g, '')].filter(kw => kw && text.includes(kw) && foundKeyword === '' )[0]; 
      }, '');
      
      if (foundKeyword && text.includes(foundKeyword.replace(/[-]/g, ''))) {
        return taxonomy.canonicalSkill(domain, skill);
      }
    }
  }

  // Fallback: try College Board folder names as keyword matches  
  const cbFolders = [
    'Linear', 'equation', 'in one variable', 
    'Quadratic', 'Nonlinear', 'Function', 
    'Percent', 'Ratios', 'Mean', 'Median', 'Probability', 
    'Triangle', 'Right', 'Congruent', 'Circle'
  ];

  for (const kw of cbFolders) {
    if (text.includes(kw.toLowerCase())) {
      // Match to most specific skill
      for (const domain of ['advanced-math', 'geometry-trig']) {
        const matches = taxonomy.SKILLS[domain].filter(s => s.toLowerCase().includes(kw.toLowerCase()));
        if (matches.length > 0) return matches[0];
      }
    }
  }

  return null;
}

/**
   Main function: categorize an array of questions from your bank
*/
export async function categorizeBatch(jsonlPath) { 
  if (!fs.existsSync(jsonlPath)) {
    throw new Error(`File not found: ${jsonlPath}`);
  }
  
  const questions = JSON.parse(fs.readFileSync(jsonlPath).toString().trim());
  const results = [];
  
  for (const q of questions) {
    // Get ClassMarker category ID as numeric string
    const catRaw = String(q.category || '').split(' ')?.[0] || ''; 
    const catNumId = parseInt(catRaw);
    
    // Direct lookup if we have it  
    let directMatch = CATEGORY_ID_TO_CB_SKILL[catRaw];
    let skillDomain, canonicalSkill;
    
    if (directMatch) {
      ({ domain: skillDomain, skill: canonicalSkill } = taxonomy.canonicalSkill(domainForSkill(directMatch), directMatch));
    } else {
      // Content-based analysis  
      const cbSkill = identifySkill(q);
      if (cbSkill) {
        const domain = Object.keys(taxonomy.SKILLS).find(d => { 
          return taxonomy.SKILLS[d].some(s => s.includes(cbSkill.substring(0, 3)));
        });  // Rough heuristic, will refine  
        directMatch = cbSkill;
        canonicalSkill = cbSkill; 
        skillDomain = domain || 'math';
      } else {
        continue;  // Skip uncategorizable for now 
      }
    }
    
    results.push({
      ...q,
      categoryId: catRaw,
      classMarkerNumericId: catNumId,
      collegeBoardSkill: canonicalSkill,  
      domain: skillDomain || (taxonomy.isValidDomain('math', skillDomain) ? 'math' : 'rw'),
      rawCategoryText: q.category.split('').join('')?.trim(),  // Store original for debugging
    });
  }

  return results;
}

export default { categorizeBatch, identifySkill };
