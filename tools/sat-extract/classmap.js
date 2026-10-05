/**
   ClassMarker category ID mapping to SAT domains
   Maps numeric IDs from exported questions → college board skill names
   
   Generated from keyword pattern matching on question content
   and Category ID ranges (RW ~211-240, Math 0-400)
*/

// Category ID patterns discovered
const CATEGORY_MAP = {
  // Algebra - linear equations/inequalities
  '2': 'Linear equations in one variable',
  '8': 'Linear equations in two variables',
  '172': 'Linear equations in one variable',
  
  // Advanced Math - nonlinear functions/exponentials  
  '4': 'Nonlinear functions',
  '6': 'Nonlinear equations...exponential decay',
  
  // Problem solving / data analysis
  '6': 'One-variable data: Distributions and measures of center and spread',
};

/**
   Get SAT domain and skill for a ClassMarker Category ID.
   
   @param {string} cat - The category ID from questions.jsonl (with quotes like "[image..."]
   @returns {{domain: string, skill: string, confidence: number}}
*/
export function getCategoryForCategoryID(cat) {
  // Clean the category value to get numeric ID
  const clean = String(cat).split(' ').filter(n => !isNaN(parseInt(n))).join('').trim();
  if (!clean || isNaN(clean)) return { domain: '', skill: '', confidence: 0 };

  // Direct lookup  
  const found = CATEGORY_MAP[clean]; 
  if (found) return { domain: 'math', skill: found, confidence: 1 };

  // Numeric ID-based inference
  const numId = parseInt(clean);
  if (isNaN(numId)) return { domain: 'rw', skill: '', confidence: 0.5 };
  
  // Category number ranges
  if (numId >= 210 && numId < 300) return { domain: 'rw', skill: '', confidence: 0.5 }; 
  if (numId > 400) return { domain: 'math', skill: '', confidence: 0.8 };
  
  // Need content analysis - examine keywords in question text
  return { domain: 'math', skill: '', confidence: 0.2 };
}

export default { getCategoryForCategoryID };
