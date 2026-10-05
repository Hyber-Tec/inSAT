// One-time bank bootstrap for the DEMO (default) institution. Seeds a small set
// of original Reading & Writing exemplars across all four R&W domains so the
// demo has questions out of the box. Optional: every institution can also just
// generate from an empty bank (generation is zero-shot when the bank is empty).
//
//   npm run seed:bank        (from functions/)

import { query } from '../lib/db.js';
import { contentHash, importRows } from '../lib/items.js';
import { globalPoolId } from '../lib/pool.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const mc = (A, B, C, D) => ({ A, B, C, D });

// R&W domain label -> our taxonomy id.
const DOMAIN_MAP = {
  'Information and Ideas': 'info-ideas',
  'Craft and Structure': 'craft-structure',
  'Expression of Ideas': 'expression',
  'Standard English Conventions': 'conventions',
};

// Two original exemplars per R&W domain (text-only). These seed the demo bank
// and double as style references the generator can learn each domain's shape from.
const ENGLISH_EXEMPLARS = [
  {
    id: 'seed-info-1', section: 'English', domain: 'Information and Ideas',
    skill_tag: 'Central Ideas and Details', difficulty: 'medium',
    stimulus: 'When archaeologist Saoirse Whelan first proposed that a series of 30,000-year-old engravings in a network of caves were intentional notational systems-rudimentary calendars marking lunar phases-her colleagues were skeptical. Decades later, however, similar patterns documented across nine geographically isolated sites have lent her hypothesis considerable weight. While not yet universally accepted, the convergence of evidence is shifting the consensus in her favor.',
    stem: 'Which choice best states the main idea of the text?',
    choices: mc(
      "Whelan's calendar hypothesis is now universally accepted by archaeologists.",
      'The cave engravings remain the most important record of prehistoric astronomy.',
      "Initially dismissed, Whelan's hypothesis has gained credibility as similar evidence has accumulated elsewhere.",
      'Archaeologists have abandoned earlier theories about the engravings entirely.',
    ),
    answer: 'C',
    rationale: { correct: 'The text traces a shift from skepticism to growing support as corroborating evidence accumulated.' },
  },
  {
    id: 'seed-info-2', section: 'English', domain: 'Information and Ideas',
    skill_tag: 'Inferences', difficulty: 'medium',
    stimulus: 'A 12-year study of urban songbirds found that individuals living near constant traffic noise sang at a higher pitch than those in quieter parks. When the same birds were recorded in sound-isolated aviaries, the pitch difference largely disappeared within weeks.',
    stem: 'Which choice best states a conclusion supported by the study?',
    choices: mc(
      'Traffic noise permanently alters the vocal anatomy of songbirds.',
      "The birds' song pitch was a flexible response to their noise environment rather than a fixed trait.",
      'Songbirds in quiet parks are unable to raise the pitch of their songs.',
      'Urban songbirds prefer higher-pitched songs regardless of their surroundings.',
    ),
    answer: 'B',
    rationale: { correct: 'The pitch difference reversed once noise was removed, indicating a flexible behavioral response.' },
  },
  {
    id: 'seed-craft-1', section: 'English', domain: 'Craft and Structure',
    skill_tag: 'Words in Context', difficulty: 'medium',
    stimulus: 'Despite his decades of experimentation, chemist Marcus Hellebrant maintained that scientific progress was rarely a matter of dramatic breakthrough. Instead, he insisted, real discovery was ______: small, accumulated insights, each one barely noteworthy on its own but collectively transformative over years of patient work.',
    stem: 'Which choice completes the text with the most logical and precise word?',
    choices: mc('instantaneous', 'incremental', 'inscrutable', 'inevitable'),
    answer: 'B',
    rationale: { correct: '"Incremental" matches the description of small, accumulated insights.' },
  },
  {
    id: 'seed-craft-2', section: 'English', domain: 'Craft and Structure',
    skill_tag: 'Text Structure and Purpose', difficulty: 'hard',
    stimulus: 'Most economists once believed that a country\'s growth depended primarily on the accumulation of physical capital-roads, factories, machinery. Newer research, however, has shifted attention to so-called "intangible" inputs: education, institutional trust, and information networks. Some economists argue this represents a wholesale revision of growth theory; others contend it is merely an extension of older models, with new variables added to familiar equations.',
    stem: 'What is the main purpose of the third sentence?',
    choices: mc(
      'To resolve an apparent contradiction between two schools of thought.',
      'To indicate that economists disagree about how to characterize a recent shift.',
      'To argue that intangible inputs are more important than physical capital.',
      "To provide an example of a particular economist's research.",
    ),
    answer: 'B',
    rationale: { correct: 'The sentence presents two opposing characterizations, signaling disagreement.' },
  },
  {
    id: 'seed-expr-1', section: 'English', domain: 'Expression of Ideas',
    skill_tag: 'Rhetorical Synthesis', difficulty: 'medium',
    stimulus: 'While researching a presentation, a student took the following notes:\n• The Antikythera mechanism is an ancient Greek device discovered in 1901.\n• It has been dated to approximately 100 BCE.\n• It is widely considered the world\'s first analog computer.\n• It used a complex system of bronze gears.\n• It predicted astronomical positions and eclipses decades in advance.\nThe student wants to emphasize the mechanism\'s technological significance.',
    stem: 'Which choice most effectively uses relevant information from the notes to accomplish this goal?',
    choices: mc(
      'The Antikythera mechanism was discovered in 1901 and is approximately 2,100 years old.',
      'Built around 100 BCE, the Antikythera mechanism contained bronze gears that have surprised modern researchers.',
      "Considered the world's first analog computer, the Antikythera mechanism used bronze gears to predict eclipses decades in advance.",
      'The Antikythera mechanism, an ancient Greek device, was discovered in 1901 and used bronze gears.',
    ),
    answer: 'C',
    rationale: { correct: 'It foregrounds the device\'s significance (first analog computer) and capability (predicting eclipses).' },
  },
  {
    id: 'seed-expr-2', section: 'English', domain: 'Expression of Ideas',
    skill_tag: 'Transitions', difficulty: 'medium',
    stimulus: 'Many cooperatives invest heavily in marketing their fair-trade certification to consumers in wealthier nations. ______, surveys consistently show that most shoppers cannot recall a single fair-trade brand they purchased within the past month.',
    stem: 'Which choice completes the text with the most logical transition?',
    choices: mc('Therefore', 'For example', 'However', 'Similarly'),
    answer: 'C',
    rationale: { correct: 'The second sentence contrasts the marketing investment with poor recall, so a contrast transition fits.' },
  },
  {
    id: 'seed-conv-1', section: 'English', domain: 'Standard English Conventions',
    skill_tag: 'Form, Structure, and Sense', difficulty: 'easy',
    stimulus: 'The collection of vintage photographs that Dr. Okafor donated to the museum ______ scenes from the construction of the Lagos–Ibadan Expressway in the 1970s.',
    stem: 'Which choice completes the text so that it conforms to the conventions of Standard English?',
    choices: mc('depict', 'depicts', 'are depicting', 'have depicted'),
    answer: 'B',
    rationale: { correct: 'The singular subject "collection" takes the singular verb "depicts."' },
  },
  {
    id: 'seed-conv-2', section: 'English', domain: 'Standard English Conventions',
    skill_tag: 'Boundaries', difficulty: 'medium',
    stimulus: 'The panel included three immunologists from across Asia______ Dr. Liu, who specialized in antibody research; Dr. Patel, whose lab studied viral mutations; and Dr. Reyes, an expert in epidemiology.',
    stem: 'Which choice completes the text so that it conforms to the conventions of Standard English?',
    choices: mc(',', ';', ':', '-'),
    answer: 'C',
    rationale: { correct: 'A colon introduces the list that elaborates on "three immunologists."' },
  },
];

// Convert a seed exemplar into a normalized pa_items row.
function toRow(ex) {
  const choices = LETTERS.map((L) => String(ex.choices[L] ?? '').trim());
  const correctIdx = Math.max(0, LETTERS.indexOf(ex.answer));
  const question = ex.stem;
  return {
    content_hash: contentHash({ section: 'rw', question, choices, passage: ex.stimulus || null }),
    section: 'rw',
    domain: DOMAIN_MAP[ex.domain] || '',
    skill: ex.skill_tag || '',
    difficulty: ['easy', 'medium', 'hard'].includes(ex.difficulty) ? ex.difficulty : 'medium',
    passage: ex.stimulus || null,
    question,
    choices,
    correct_idx: correctIdx,
    answer_type: 'multiple-choice',
    answer_text: null,
    rationale: { correct: ex.rationale?.correct || '' },
    figure: null,
    image_ref: null,
    source: 'manual',
    verified: true,
  };
}

async function main() {
  const { rows } = await query("SELECT id FROM pa_institutions WHERE slug = 'satify'");
  const instId = rows[0]?.id;
  if (!instId) {
    console.error('Default institution not found - start the API once first to seed it.');
    process.exit(1);
  }
  const seedRows = ENGLISH_EXEMPLARS.map(toRow);
  const imported = await importRows(seedRows, instId);
  console.log('[insat] seeded R&W exemplars into the default institution:', imported);
  const pooled = await importRows(seedRows, await globalPoolId());
  console.log('[insat] seeded R&W exemplars into the global pool:', pooled);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
