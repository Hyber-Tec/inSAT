// Official questions (the College Board question bank and the practice tests,
// transcribed by tools/sat-extract) served to students. Their explanations
// come as one text that names choices by letter: "Choice B is correct. ...",
// "Choice A is incorrect and may result from ...". Choices are shuffled for
// every student, so a letter would name the wrong choice; the bank keeps an
// explanation for the right answer and one for each wrong choice instead,
// keyed by letter in the stored order and shown beside the choice it is about.
//
// officialRationale() puts an explanation in that shape: the right answer's
// paragraph (with any lead-in before it and alternate approaches after it),
// and each wrong choice's ("This choice is incorrect and ..."), a reason given
// for several choices at once going to each. An explanation that still names a
// choice by letter, or does not follow the official shape, is not converted:
// its question stays reference material, never served with a wrong letter.
//
// Not every practice test is the College Board's own. The transcribed tests
// are its practice tests, whose questions it also publishes in the question
// bank, and third-party "Digital SAT" series written to imitate them. A test
// most of whose questions the bank holds word for word is the College Board's
// (in the transcribed set, tests 8-13 and 17 hold 92-98% of theirs there, the
// others 0-17%). Its questions are the current exam's own and read most like
// it (realism 5); a third-party test's read like a good imitation (4).

const LETTERS = ['A', 'B', 'C', 'D'];

// How a question reads when telling whether two transcriptions are the same
// question: case, spacing and punctuation aside.
const plain = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
const sameQuestion = (q) => [q.question, ...(q.choices || []), q.section === 'rw' ? q.passage : ''].map(plain).join('|');

/**
 * The practice tests that are the College Board's own: those most of whose
 * questions (`tests`, each with its `test` number) the question bank (`bank`)
 * holds word for word.
 */
export function collegeBoardTests(tests, bank) {
  const inBank = new Set(bank.map(sameQuestion));
  const share = new Map();
  for (const q of tests) {
    const s = share.get(q.test) || { all: 0, inBank: 0 };
    s.all += 1;
    if (inBank.has(sameQuestion(q))) s.inBank += 1;
    share.set(q.test, s);
  }
  return new Set([...share].filter(([, s]) => s.inBank / s.all > 0.5).map(([test]) => test));
}

/** How much a question from the bank (`cb`) or a practice test (`dsat`) reads like the current exam. */
export const officialRealism = (collection, q, ownTests) => (collection === 'cb' || ownTests.has(q.test) ? 5 : 4);

// A choice named by its letter: "choice B", "Choices A and C", "option D", "(B)".
export const LETTER_REF = /\b(?:[Cc]hoices?|[Oo]ptions?|[Aa]nswers?)\s*\(?[A-D]\b|\([A-D]\)/;

// Where a choice's own explanation starts: "Choice B is ...", "Choices A, C,
// and D are ...", "Choice B. This ...".
const CHOICE_START = /(?=\bChoices? [A-D](?:(?:,| and|, and) [A-D])*(?: is| are|\.\s+This))/g;
const CORRECT = [
  /^Choice ([A-D]) is (?:the )?(?:correct|best)(?: answer| choice)?\b[.,]?\s*/,
  /^Choice ([A-D])\.\s*This is the (?:best|correct) (?:choice|answer)\.?\s*/,
];
const WRONG = [/^Choice ([A-D]) is incorrect\b\s*/, /^Choice ([A-D])\.\s*This choice\b\s*/];
// A reason shared by several wrong choices, which reads the same of each alone.
const SHARED = /^Choices ([A-D](?:(?:,| and|, and) [A-D])+) are incorrect( and (?:may|likely|might) (?:result|be the result) (?:from|of) [^.]*\.)\s*$/;

const firstMatch = (patterns, text) => patterns.map((p) => p.exec(text)).find(Boolean) || null;
const lettersIn = (s) => [...s.matchAll(/\b([A-D])\b/g)].map((m) => m[1]);
const join = (...parts) => parts.filter(Boolean).join('\n\n');

/**
 * An official question's explanation ({ answer_type, answer, rationale }) in
 * the bank's shape: { rationale: { correct, A?, B?, C?, D? } } (no entry for
 * the right answer's letter), or { why } it cannot be put in it.
 */
export function officialRationale(q) {
  const text = String(q.rationale || '').replace(/\r/g, '').trim();
  if (!text) return { why: 'no explanation' };
  if (q.answer_type === 'grid-in') {
    // "The correct answer is 7/6. ..." names no choice, unless it slips one in.
    return LETTER_REF.test(text) ? { why: 'explanation names a choice by letter' } : { rationale: { correct: text } };
  }
  const key = String(q.answer || '').trim();
  if (!LETTERS.includes(key)) return { why: 'no answer key' };

  const pieces = text.replace(/\b(?:Key|Distractor) Explanations?:\s*/gi, '\n\n')
    .split(/\n\s*\n/)
    .flatMap((p) => p.split(CHOICE_START))
    .map((p) => p.trim())
    .filter(Boolean);
  const out = {};
  const leadIn = [];
  for (const piece of pieces) {
    let m;
    if ((m = firstMatch(CORRECT, piece))) {
      if (m[1] !== key) return { why: 'explanation calls another choice correct' };
      let rest = piece.slice(m[0].length);
      if (/^because\b/.test(rest)) rest = `This is the best answer ${rest}`;
      out.correct = join(out.correct, rest);
    } else if ((m = firstMatch(WRONG, piece))) {
      if (m[1] === key) return { why: 'explanation calls the key incorrect' };
      const lead = m[0].includes('incorrect') ? 'This choice is incorrect ' : 'This choice ';
      out[m[1]] = [out[m[1]], `${lead}${piece.slice(m[0].length)}`.replace(/ ([.,])/, '$1').trim()].filter(Boolean).join(' ');
    } else if ((m = SHARED.exec(piece))) {
      for (const letter of lettersIn(m[1])) {
        if (letter === key) return { why: 'explanation calls the key incorrect' };
        out[letter] = [out[letter], `This choice is incorrect${m[2]}`].filter(Boolean).join(' ');
      }
    } else if (/^Choices? [A-D]/.test(piece)) {
      return { why: 'explanation of a choice in another shape' };
    } else if (out.correct) {
      out.correct = join(out.correct, piece); // more on the right answer: an alternate approach
    } else {
      leadIn.push(piece); // what the question asks, ahead of the answer
    }
  }
  if (!out.correct) return { why: 'explanation of the right answer not found' };
  out.correct = join(...leadIn, out.correct);
  if (Object.values(out).some((v) => LETTER_REF.test(v))) return { why: 'explanation names a choice by letter' };
  return { rationale: out };
}
