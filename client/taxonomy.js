// College-Board-aligned content taxonomy for Digital SAT-style questions.
//
// Each question carries a `category` and `subcategory` so the admin can
// browse, filter, and assemble tests by skill — the same way College Board
// reports break out performance.
//
// Keep these arrays in display order: that's the order the dropdowns and
// list filters render.

export const TAXONOMY = {
  rw: [
    {
      id: 'info-ideas',
      name: 'Information and Ideas',
      subcategories: [
        'Central Ideas and Details',
        'Inferences',
        'Command of Evidence (Textual)',
        'Command of Evidence (Quantitative)',
      ],
    },
    {
      id: 'craft-structure',
      name: 'Craft and Structure',
      subcategories: [
        'Words in Context',
        'Text Structure and Purpose',
        'Cross-Text Connections',
      ],
    },
    {
      id: 'expression',
      name: 'Expression of Ideas',
      subcategories: [
        'Rhetorical Synthesis',
        'Transitions',
      ],
    },
    {
      id: 'conventions',
      name: 'Standard English Conventions',
      subcategories: [
        'Boundaries',
        'Form, Structure, and Sense',
      ],
    },
  ],
  math: [
    {
      id: 'algebra',
      name: 'Algebra',
      subcategories: [
        'Linear equations in one variable',
        'Linear equations in two variables',
        'Linear functions',
        'Systems of two linear equations',
        'Linear inequalities',
      ],
    },
    {
      id: 'advanced-math',
      name: 'Advanced Math',
      subcategories: [
        'Equivalent expressions',
        'Nonlinear equations in one variable and systems',
        'Nonlinear functions',
      ],
    },
    {
      id: 'problem-solving',
      name: 'Problem-Solving and Data Analysis',
      subcategories: [
        'Ratios, rates, proportional relationships, and units',
        'Percentages',
        'One-variable data: distributions, center, and spread',
        'Two-variable data: models and scatterplots',
        'Probability and conditional probability',
        'Inference from sample statistics and margin of error',
        'Evaluating statistical claims',
      ],
    },
    {
      id: 'geometry-trig',
      name: 'Geometry and Trigonometry',
      subcategories: [
        'Area and volume',
        'Lines, angles, and triangles',
        'Right triangles and trigonometry',
        'Circles',
      ],
    },
  ],
};

export const UNCATEGORIZED = '__uncategorized__';

/** Return the categories that apply to a given section ('rw' | 'math'). */
export function categoriesForSection(section) {
  return TAXONOMY[section] || [];
}

/** Look up a category record by section + category id. */
export function findCategory(section, categoryId) {
  return categoriesForSection(section).find((c) => c.id === categoryId) || null;
}

/** Subcategories for a (section, category) pair — empty array if unknown. */
export function subcategoriesFor(section, categoryId) {
  return findCategory(section, categoryId)?.subcategories || [];
}

/** Human label for a category id, falling back to "Uncategorized". */
export function categoryLabel(section, categoryId) {
  if (!categoryId || categoryId === UNCATEGORIZED) return 'Uncategorized';
  return findCategory(section, categoryId)?.name || 'Uncategorized';
}

/** Build options for a <Select> of categories. */
export function categoryOptions(section) {
  return [
    { value: UNCATEGORIZED, label: 'Uncategorized' },
    ...categoriesForSection(section).map((c) => ({ value: c.id, label: c.name })),
  ];
}

/** Build options for a <Select> of subcategories given the chosen category. */
export function subcategoryOptions(section, categoryId) {
  const subs = subcategoriesFor(section, categoryId);
  return [
    { value: '', label: subs.length ? 'Choose a subcategory' : 'No subcategories' },
    ...subs.map((s) => ({ value: s, label: s })),
  ];
}
