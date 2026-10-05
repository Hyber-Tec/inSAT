// Server-side mirror of the client content taxonomy. Used by question
// generation, upload extraction, the exam assembly engine, and the student
// skill profile.

export const DOMAINS = {
  rw: ['info-ideas', 'craft-structure', 'expression', 'conventions'],
  math: ['algebra', 'advanced-math', 'problem-solving', 'geometry-trig'],
};

export const DOMAIN_LABEL = {
  'info-ideas': 'Information and Ideas',
  'craft-structure': 'Craft and Structure',
  'expression': 'Expression of Ideas',
  'conventions': 'Standard English Conventions',
  'algebra': 'Algebra',
  'advanced-math': 'Advanced Math',
  'problem-solving': 'Problem-Solving and Data Analysis',
  'geometry-trig': 'Geometry and Trigonometry',
};

// The College Board's skills, per domain, in its own wording. Every item in
// the bank carries one of these (see canonicalSkill), so a student's accuracy
// can be measured per skill no matter where the item came from: the College
// Board bank, a practice test, a template, or generation.
export const SKILLS = {
  'info-ideas': ['Central Ideas and Details', 'Command of Evidence', 'Inferences'],
  'craft-structure': ['Words in Context', 'Text Structure and Purpose', 'Cross-Text Connections'],
  'expression': ['Rhetorical Synthesis', 'Transitions'],
  'conventions': ['Boundaries', 'Form, Structure, and Sense'],
  'algebra': [
    'Linear equations in one variable',
    'Linear functions',
    'Linear equations in two variables',
    'Systems of two linear equations in two variables',
    'Linear inequalities in one or two variables',
  ],
  'advanced-math': [
    'Nonlinear functions',
    'Nonlinear equations in one variable and systems of equations in two variables',
    'Equivalent expressions',
  ],
  'problem-solving': [
    'Ratios, rates, proportional relationships, and units',
    'Percentages',
    'One-variable data: Distributions and measures of center and spread',
    'Two-variable data: Models and scatterplots',
    'Probability and conditional probability',
    'Inference from sample statistics and margin of error',
    'Evaluating statistical claims: Observational studies and experiments',
  ],
  'geometry-trig': [
    'Area and volume',
    'Lines, angles, and triangles',
    'Right triangles and trigonometry',
    'Circles',
  ],
};

// Other names the same skills arrive under: the folder names of the College
// Board bank (a colon cannot be in a file name), the older labels of the math
// templates, and the textual/quantitative split some sources make.
const ALIASES = {
  'command of evidence (textual)': 'Command of Evidence',
  'command of evidence (quantitative)': 'Command of Evidence',
  'systems of two linear equations': 'Systems of two linear equations in two variables',
  'linear inequalities': 'Linear inequalities in one or two variables',
  'nonlinear equations in one variable and systems': 'Nonlinear equations in one variable and systems of equations in two variables',
  // math templates (lib/templates/math.js) before they used these names
  'slope of a line through two points': 'Linear equations in two variables',
  'linear functions in context': 'Linear functions',
  'systems with no solution': 'Systems of two linear equations in two variables',
  'solving quadratic equations': 'Nonlinear equations in one variable and systems of equations in two variables',
  'discriminant and repeated roots': 'Nonlinear equations in one variable and systems of equations in two variables',
  'vertex form of a parabola': 'Nonlinear functions',
  'exponential growth and decay': 'Nonlinear functions',
  'function notation and composition': 'Nonlinear functions',
  'percent change': 'Percentages',
  'ratios, rates, and proportions': 'Ratios, rates, proportional relationships, and units',
  'mean of a data set': 'One-variable data: Distributions and measures of center and spread',
  'weighted averages': 'One-variable data: Distributions and measures of center and spread',
  'probability from a sample': 'Probability and conditional probability',
  'right triangles and the pythagorean theorem': 'Right triangles and trigonometry',
  'right triangle trigonometry': 'Right triangles and trigonometry',
  'circles: area and circumference': 'Circles',
  'equation of a circle': 'Circles',
  'similar triangles': 'Lines, angles, and triangles',
  'volume of solids': 'Area and volume',
};

// Older labels join a skill's two parts with a dash of either kind instead of a colon.
const norm = (s) => String(s || '').toLowerCase().replace(/\s+[-—]\s+/g, ': ').replace(/\s+/g, ' ').trim();

/** The canonical skill for a label, or '' when it names none of the domain's skills. */
export function canonicalSkill(domain, label) {
  const want = norm(label);
  if (!want) return '';
  const skills = SKILLS[domain] || Object.values(SKILLS).flat();
  const exact = skills.find((s) => norm(s) === want);
  if (exact) return exact;
  const alias = ALIASES[want];
  if (alias && skills.includes(alias)) return alias;
  return '';
}

/** Which domain a canonical skill belongs to. */
export function domainForSkill(skill) {
  return Object.keys(SKILLS).find((d) => SKILLS[d].includes(skill)) || null;
}

export const sectionForDomain = (domainId) =>
  DOMAINS.math.includes(domainId) ? 'math' : 'rw';

export const isValidDomain = (kind, domainId) => (DOMAINS[kind] || []).includes(domainId);

/** Sections, their domains and each domain's skills, for an admin's pickers. */
export const taxonomyTree = () => Object.fromEntries(Object.entries(DOMAINS).map(([kind, ids]) => [
  kind, ids.map((id) => ({ id, label: DOMAIN_LABEL[id], skills: SKILLS[id] })),
]));
