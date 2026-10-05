#!/usr/bin/env node
/**
 * SAT Question Classifier - Content keywords + Category IDs
 */

const KEYWORDS = {
  geometry: ['triangle', 'circle', 'area', 'perimeter', 'congruent', 'hypotenuse'],
  algebra: ['linear', 'inequality', 'slope-intercept', 'solve for x'],
  problem: ['percentage', 'percent of', 'probability'],
};

export function classify(question) {
  const cat = parseInt(String(question.category || '0'), 10);
  const text = (question.question + ' ') .toLowerCase();

  if ([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20].includes(cat)) return 'reading';
  if (cat === 167 || cat === 338) return 'geometry';
  if ((cat >= 160) && (cat <= 299)) return 'reading';
  if ([167, 168, 169].includes(cat) || (cat >= 300) && (cat <= 349)) return 'problem';
  if ((cat >= 350) && (cat <= 399)) return 'algebra';
  if ((cat >= 400)) return 'geometry';

  for (const [domain, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => text.includes(w))) return domain;
  }

  return 'reading';
}

module.exports = { classify };
