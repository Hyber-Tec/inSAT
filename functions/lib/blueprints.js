// Default College-Board-aligned blueprints. The `spec` shape is consumed by
// lib/assembly.js. Counts per module follow the digital SAT structure
// (RW 54 = 27 + 27, Math 44 = 22 + 22); domain splits approximate the published
// College Board weightings and are editable per blueprint in the admin UI.
//
// Per module: `count` total questions, distributed across `domains` (taxonomy
// id -> count, summing to count). Module 1 is mixed difficulty; Module 2 is
// adaptive (its difficulty is chosen at runtime from Module 1 performance).

export const FULL_SAT_SPEC = {
  routing: { thresholdFraction: 0.6 },
  sections: [
    {
      kind: 'rw',
      name: 'Reading and Writing',
      timeLimitSec: 32 * 60,
      modules: [
        {
          ordinal: 1, adaptive: false, count: 27, difficulty: 'mixed',
          domains: { 'info-ideas': 8, 'craft-structure': 7, 'conventions': 7, 'expression': 5 },
        },
        {
          ordinal: 2, adaptive: true, count: 27,
          domains: { 'info-ideas': 8, 'craft-structure': 7, 'conventions': 7, 'expression': 5 },
        },
      ],
    },
    {
      kind: 'math',
      name: 'Math',
      timeLimitSec: 35 * 60,
      modules: [
        {
          ordinal: 1, adaptive: false, count: 22, difficulty: 'mixed',
          domains: { 'algebra': 8, 'advanced-math': 8, 'problem-solving': 3, 'geometry-trig': 3 },
        },
        {
          ordinal: 2, adaptive: true, count: 22,
          domains: { 'algebra': 8, 'advanced-math': 8, 'problem-solving': 3, 'geometry-trig': 3 },
        },
      ],
    },
  ],
};

// Small blueprint for quick walkthroughs / E2E (8 questions total).
export const DEMO_SPEC = {
  routing: { thresholdFraction: 0.6 },
  sections: [
    {
      kind: 'rw', name: 'Reading and Writing', timeLimitSec: 5 * 60,
      modules: [
        { ordinal: 1, adaptive: false, count: 2, difficulty: 'mixed',
          domains: { 'info-ideas': 1, 'conventions': 1 } },
        { ordinal: 2, adaptive: true, count: 2,
          domains: { 'info-ideas': 1, 'conventions': 1 } },
      ],
    },
    {
      kind: 'math', name: 'Math', timeLimitSec: 5 * 60,
      modules: [
        { ordinal: 1, adaptive: false, count: 2, difficulty: 'mixed',
          domains: { 'algebra': 1, 'advanced-math': 1 } },
        { ordinal: 2, adaptive: true, count: 2,
          domains: { 'algebra': 1, 'advanced-math': 1 } },
      ],
    },
  ],
};

export const DEFAULT_BLUEPRINTS = [
  {
    name: 'Full SAT',
    description: 'Full-length digital SAT: Reading & Writing 54 + Math 44, adaptive Module 2.',
    spec: FULL_SAT_SPEC,
    is_default: true,
  },
  {
    name: 'Demo SAT',
    description: 'Short 8-question demo for quick walkthroughs.',
    spec: DEMO_SPEC,
    is_default: false,
  },
];
