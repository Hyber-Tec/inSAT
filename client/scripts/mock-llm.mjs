// A stand-in for the AI provider, for check-authoring.mjs only. Loaded into a
// throwaway API process (node --import), it answers that process's calls to
// Anthropic's Messages API the way a model would, so making tests from uploads
// and with AI runs end to end without a key or a bill. It tells the three jobs
// apart by their prompts (server/lib/ingest.js, server/lib/generate.js):
// reading questions out of a file, writing questions, and solving them again
// to check each answer. Every third question it writes is solved to a
// different answer, so a draft that fails the check is seen to be left out.
// Any other request goes out as usual.

import { DOMAIN_LABEL, SKILLS } from '../../server/lib/taxonomy.js';

const MESSAGES_API = 'https://api.anthropic.com/v1/messages';
const LETTERS = ['A', 'B', 'C', 'D'];
const DOMAIN_BY_LABEL = Object.fromEntries(Object.entries(DOMAIN_LABEL).map(([id, label]) => [label, id]));

// What each written question's check should say, by question text.
const verdicts = new Map();
let serial = 0;

/** Four choices with the right one at `at`. */
const place = (right, wrong, at) => {
  const choices = [...wrong];
  choices.splice(at, 0, right);
  return choices;
};

function mathItem() {
  serial += 1;
  const a = 3 + (serial % 6);
  const b = 2 + (serial % 7);
  const x = 4 + (serial % 9);
  const at = serial % 4;
  const choices = place(String(x), [String(x + 1), String(x - 1), String(x + 2)], at);
  return {
    passage: null,
    question: `If \\(${a}x + ${b} = ${a * x + b}\\), what is the value of \\(x\\)? (No. ${serial})`,
    choices,
    letter: LETTERS[at],
    why: `Subtracting ${b} from both sides gives \\(${a}x = ${a * x}\\), and dividing both sides by ${a} gives \\(x = ${x}\\).`,
  };
}

const WORDS = [
  ['corroborate', ['obscure', 'neglect', 'dismiss']],
  ['illuminate', ['conceal', 'overlook', 'forgo']],
  ['undermine', ['affirm', 'echo', 'certify']],
  ['refine', ['abandon', 'disregard', 'distort']],
];

function rwItem() {
  serial += 1;
  const [right, wrong] = WORDS[serial % WORDS.length];
  const at = (serial + 1) % 4;
  return {
    passage: `Field ecologists tracking river otters for ${serial + 2} seasons found that the animals returned to the same dens each spring. The new tracking data ______ an earlier claim that the otters wander widely between rivers.`,
    question: `Which choice completes the text with the most logical and precise word or phrase? (No. ${serial})`,
    choices: place(right, wrong, at),
    letter: LETTERS[at],
    why: `The data show the otters staying put, which works against the earlier claim, so the word must mean to weaken it: "${right}".`,
  };
}

/** A written question in the shape lib/generate.js asks for. */
function written(section, domain, skill, index) {
  const item = section === 'math' ? mathItem() : rwItem();
  const rationale = { correct: item.why };
  item.choices.forEach((c, i) => {
    rationale[LETTERS[i]] = LETTERS[i] === item.letter ? `${c} is right: ${item.why}` : `${c} does not fit what the text or the equation says.`;
  });
  // Every third draft is solved to another answer when it is checked.
  const fails = index % 3 === 2;
  const other = LETTERS[(LETTERS.indexOf(item.letter) + 1) % 4];
  verdicts.set(item.question, { answer: fails ? other : item.letter, domain, skill });
  return {
    passage: item.passage, question: item.question, answer_type: 'multiple-choice', choices: item.choices,
    answer: item.letter, figure: null, skill, rationale,
  };
}

function write(prompt) {
  const n = Number(/Write (\d+) original/.exec(prompt)?.[1] || 1);
  const section = /digital SAT Math questions/.test(prompt) ? 'math' : 'rw';
  const domain = DOMAIN_BY_LABEL[/Domain: (.+?)\. Difficulty:/.exec(prompt)?.[1]];
  const skill = /Every question must test this skill: (.+?)\.(\s|$)/.exec(prompt)?.[1] || SKILLS[domain][serial % SKILLS[domain].length];
  return Array.from({ length: n }, (_, i) => written(section, domain, skill, i));
}

function check(prompt) {
  const out = [];
  for (const block of prompt.split(/^#(?=\d+$)/m).slice(1)) {
    const i = Number(block.split('\n')[0]);
    const question = /^Question: (.*)$/m.exec(block)?.[1];
    const v = verdicts.get(question);
    if (v) out.push({ i, answer: v.answer, single_correct: true, domain: v.domain, skill: v.skill });
  }
  return out;
}

/** What a file holds, as lib/ingest.js asks for it: the hinted section(s), across two modules. */
function read(prompt) {
  const sections = /These are Math questions/.test(prompt) ? ['math']
    : /These are Reading & Writing questions/.test(prompt) ? ['rw'] : ['rw', 'math'];
  const rows = [];
  for (const section of sections) {
    const domain = section === 'math' ? 'algebra' : 'craft-structure';
    const skill = section === 'math' ? 'Linear equations in one variable' : 'Words in Context';
    for (const module of [1, 1, 2]) {
      const item = section === 'math' ? mathItem() : rwItem();
      rows.push({
        section, module, domain, difficulty: 'medium', passage: item.passage, question: item.question,
        answer_type: 'multiple-choice', choices: item.choices, answer: item.letter, skill, rationale: item.why,
      });
    }
    if (section === 'math') {
      serial += 1;
      rows.push({
        section, module: 2, domain: 'algebra', difficulty: 'hard', passage: null,
        question: `What value of \\(t\\) satisfies \\(4t - 3 = ${4 * (serial % 5 + 2) - 3}\\)? (No. ${serial})`,
        answer_type: 'grid-in', choices: [], answer: String(serial % 5 + 2), skill, rationale: 'Add 3 to both sides, then divide by 4.',
      });
    }
  }
  return rows;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== MESSAGES_API) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const content = body.messages[0].content;
  const prompt = typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const answer = /Extract EVERY complete SAT question/.test(prompt) ? read(prompt)
    : /^Write \d+ original/.test(prompt) ? write(prompt)
      : /Solve each SAT question below yourself/.test(prompt) ? check(prompt)
        : null;
  if (!answer) return new Response(JSON.stringify({ error: { message: 'mock: unknown prompt' } }), { status: 400 });
  return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(answer) }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
