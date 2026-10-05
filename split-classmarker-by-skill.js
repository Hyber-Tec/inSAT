/**
   Split ClassMarker bank into specific SAT skill files by exact College Board topics
   from taxonomy.js and your College Board Question Bank folders.
   
   Maps broad ClassMarker category IDs to fine-grained skills like:
   - "Linear equations in one variable" vs just "algebra"
   - "Right triangles and trigonometry" vs just "geometry-trig"
*/
import fs from 'fs';

// Your official SAT skill list from taxonomy.js  
const SAT_SKILLS = {
  algebra: [
    "Linear equations in one variable",
    "Linear equations in two variables",
    "Systems of two linear equations in two variables",  
    "Solving for an algebraic expression",
    "Absolute value equations and inequalities",
    "Exponents and radical expressions",
    "Equivalent expressions",
  ],
  'advanced-math': [
    "Quadratic functions and inequalities",
    "Nonlinear equations in one variable",  
    "Nonlinear functions (exponential growth and decay)",
    "Logarithmic functions",
    "Polynomial functions of degree three or higher",
    "Equivalent expressions",
  ],
  'geometry-trig': [
    "Lines, angles, and triangles (congruency)",
    "Right triangles and trigonometry",  
    "Area and volume",
    "Similarity in two-dimensional geometry",
    "Congruent geometric figures",
    "Circles and other curved shapes",
    "Pythagorean theorem and its applications",
  ],
  'problem-solving': [
    "Ratios, rates, proportional relationships, and units",
    "One-variable data: Distributions and measures of center and spread",  
    "Two-variable data: Linear models and interpretations", 
    "Scatterplots and trends",
    "Probability, expectation, standard deviation",
  ],
};

function getSkillFromText(text) {
  const lowercase = text.toLowerCase();
  
  // Match reading/writing first - check for passage analysis keywords
  if (/interacts/i.test(lowercase) && /underlined.*sentence/i.test(lowercase)) {
    return "RW-writing";
  } 

  // Math domain keyword checks
  for (const [domain, skills] of Object.entries(SAT_SKILLS)) {
    
    // Advanced-math patterns
    if (['quadratic', 'parabola', 'discriminant'].some(kw => lowercase.includes(kw))) {
      return "advanced-math";
    }
    
    // Geometry-trig patterns  
    if (['triangle', 'congruent', 'similar', 'circle', 'volume'].some(kw => lowercase.includes(kw))) {
      return "geometry-trig";
    }

    // Algebra patterns
    if (['linear equation', 'inequality', 'system', 'slope', 'absolute value'].some(kw => lowercase.includes(kw))) {
      return "algebra";
    }

    // Problem-solving / data analysis patterns
    if (['ratio', 'percentage', 'mean', 'median', 'probability', 'scatterplot'
    ].some(kw => lowercase.includes(kw))) {
      return "problem-solving";
    }
  }

  return null;
}

export function splitBank(jsonlPath) { 
  // Read question bank  
  const questions = JSON.parse(fs.readFileSync(jsonlPath).toString().trim());
  
  console.log(`\nProcessing ${questions.length} ClassMarker questions...\n`);
  
  const categories = {}; 

  for (const q of questions) {
    const skill = getSkillFromText((q.question || '') + " " + (q.explanation || ''));
    
    if (!skill) continue; // Skip uncategorizable
    
    if (!categories[skill]) {
      categories[skill] = [];
    }
    
    categories[skill].push(q); 
  }

  // Output as JSONL files per skill
  for (const [name, qs] of Object.entries(categories)) {
    const path = `/Users/br0k3r/workspace/vantedge/satify/exports/classmarker-by-skill/${name.substring(0,1).toLowerCase()}+${name.substring(1)}.jsonl`;;
    fs.writeFileSync(path, qs.map(q => JSON.stringify(q)).join('\n'));  
    console.log(`  ✓ Wrote ${qs.length} questions to ${path}`); 
  }

  return categories;
}

export default { splitBank, SAT_SKILLS };
