export const meta = {
  name: 'rw-originals-to-3000',
  description: 'Write, blind-verify, fix and import original Reading and Writing questions, 30 per batch, until every skill reaches about 300',
  phases: [
    { title: 'Write', detail: 'one 30-question batch per skill at a time, each batch avoiding the topics already used in its domain' },
    { title: 'Verify', detail: 'an independent model solves each batch blind', model: 'sonnet' },
    { title: 'Fix and import', detail: 'apply the verifier notes, promote the blind answers, build, import into the insat bank' },
  ],
}

const TOOLS = '/Users/br0k3r/workspace/vantedge/satify/tools/sat-extract'
const SERVER = '/Users/br0k3r/workspace/vantedge/satify/server'
const DATA = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted'
const OUT = `${DATA}/out/original`
const JOBS = `${DATA}/jobs`

const FOCUS = {
  'boundaries': 'the full range of conventions the bank tests for this skill (sentence boundaries, comma splices and run-ons, supplementary elements set off on both sides, colons, semicolons, dashes, restrictive versus nonrestrictive elements, series), not one rule thirty times',
  'form-structure-and-sense': 'the full range of conventions the bank tests for this skill (subject-verb agreement across intervening phrases, pronoun-antecedent agreement, verb tense and form, finite versus nonfinite verbs, modifier placement, parallel structure, possessive versus plural), not one rule thirty times',
  'cross-text-connections': 'the full range of relationships between the two texts (agreement with different emphasis, disagreement, qualification, a finding applied to a claim, a concession), with varied stems; every argument a text makes must be consistent with the facts it cites',
  'text-structure-and-purpose': 'different text types including literary excerpts from invented works, and the full range of question forms (main purpose, overall structure, function of an underlined sentence marked with <u> and </u>)',
  'words-in-context': 'different text types including literary excerpts from invented works, and both question forms (the fill-in-the-blank "most logical and precise word or phrase" form, and the "as used in the text, what does the underlined word most nearly mean" form with the word or phrase wrapped in <u> and </u>); use target words different from the bank models and from each other',
  'rhetorical-synthesis': 'the full range of rhetorical goals (emphasize a similarity or a difference, introduce something to an unfamiliar audience, present a study and its finding, indicate a size, a time or a sequence, make a comparison, make and support a generalization), not one goal thirty times',
  'transitions': 'the full range of logical relationships (contrast, cause and effect, example, addition, sequence, restatement, concession, emphasis), not one relationship thirty times',
  'central-ideas-and-details': 'different text types including literary excerpts from invented works, and both question forms (main idea of the text; "according to the text" detail questions)',
  'command-of-evidence': 'the forms the bank uses for this skill (which finding would support or weaken a claim; which quotation from an invented work best illustrates a claim; quantitative evidence in a small text table as the spec describes); every distractor must be a plausible misreading, never self-contradictory, and a choice may refer to "the study" only if the passage describes one',
  'inferences': "different reasoning patterns (a conclusion from two linked facts, a prediction, an explanation of an observation, an implication of a limitation or a confound); a passage's reasoning must be consistent with the science it cites",
}

const SOLVE = {
  'boundaries': 'These test Standard English sentence boundaries and punctuation, so apply the conventions strictly.',
  'form-structure-and-sense': 'These test Standard English form, structure and sense (agreement, verb tense and form, possessives versus plurals, modifier placement), so apply the conventions strictly.',
  'cross-text-connections': "The right choice is the one both texts' stated positions support, with nothing added.",
  'text-structure-and-purpose': 'Main purpose, overall structure, or the function of the underlined part (marked with <u> and </u>) in the text as a whole.',
  'words-in-context': 'The right word or meaning is the one the context requires, not merely one that could fit.',
  'rhetorical-synthesis': 'The right choice is the one that accomplishes exactly the stated goal using the notes.',
  'transitions': 'The right transition matches the logical relationship between the sentences.',
  'central-ideas-and-details': 'The main idea is what the whole text is about, and a detail answer must be stated in the text, not merely plausible.',
  'command-of-evidence': 'Some passages begin with a small table written as lines of cells separated by " | " (header row first); read the numbers carefully.',
  'inferences': "The right completion is the one the passage's own facts support, without outside assumptions.",
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: { easy: { type: 'integer' }, medium: { type: 'integer' }, hard: { type: 'integer' } },
  required: ['easy', 'medium', 'hard'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: { answered: { type: 'integer' }, nulls: { type: 'integer' }, flagged: { type: 'array', items: { type: 'integer' } } },
  required: ['answered', 'nulls', 'flagged'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    buildLine: { type: 'string' },
    kept: { type: 'integer' },
    dropped: { type: 'integer' },
    edited: { type: 'array', items: { type: 'integer' } },
    droppedByEditor: { type: 'array', items: { type: 'integer' } },
  },
  required: ['buildLine', 'kept', 'dropped', 'edited', 'droppedByEditor'],
}

// A small priority limiter: finishing a batch (verify, fix, import) goes ahead
// of starting a new one, so the bank grows steadily.
function makeLimiter(n) {
  let active = 0
  const queues = { high: [], low: [] }
  const pump = () => {
    while (active < n && (queues.high.length || queues.low.length)) {
      const job = queues.high.length ? queues.high.shift() : queues.low.shift()
      active += 1
      job()
    }
  }
  return (priority, fn) => new Promise((resolve) => {
    queues[priority].push(() => {
      Promise.resolve().then(fn).then(resolve, () => resolve(null)).finally(() => { active -= 1; pump() })
    })
    pump()
  })
}
const limit = makeLimiter(args.concurrency || 6)
const run = (priority, prompt, opts) => limit(priority, () => agent(prompt, { agentType: 'general-purpose', ...opts }))
const pad = (w) => String(w).padStart(3, '0')

function writerPrompt(s, step, name) {
  const manifest = `${JOBS}/originals-${name}.json`
  const dash = s.slug === 'boundaries'
    ? 'No em dashes except in a question that itself tests dash punctuation.'
    : 'No em dashes anywhere: use a comma or a plain hyphen instead.'
  const start = step.state === 'complete'
    ? `1. Your job manifest already exists: ${manifest}. An earlier run was interrupted after writing part of this batch, so the manifest's \`out\` file already holds some questions. Keep every existing question that meets the spec (fix any that do not), and write only as many new ones at each difficulty as are still missing. Do not repeat the topics of the questions already in the file either.`
    : `1. Cut your job manifest (it gathers model questions from the bank and the topics already used in this skill's domain):\n   cd ${TOOLS} && python3 jobs_originals.py --name ${name} --section rw --skill "${s.skill}" --easy 10 --medium 10 --hard 10 --models 6 --seed ${20 + step.wave}\n   It writes ${manifest}.`
  return `You are writing original SAT Reading and Writing questions that students will practice on: batch ${name}, skill "${s.skill}".

${start}
2. Read the manifest, then the spec it names (the \`spec\` path), the whole file, and follow its section "Original-question jobs" exactly: record shape, originality, one defensible answer, explanations that never name a choice letter, the table convention where it applies, and the \`avoid_topics\` rule (no passage on a subject already listed there).
3. Write the questions the manifest asks for to its \`out\` path as JSON lines, one object per line, in the exact shape the spec gives. Save the easy questions to the file as soon as they are drafted, then append the medium ones, then the hard ones, so an interruption loses little. Vary the set the way the College Board bank does: different subject areas, different text types, and ${FOCUS[s.slug]}. No two passages on the same topic. Spread the correct answers across A, B, C and D.
4. Every real fact must be true and not overstated. Do not retell a specific real published study or experiment under invented names; when in doubt, invent the study, person, organism or work outright. ${dash}
5. Solve each question yourself from the passage alone, and fix or drop any whose answer is not the only defensible one.
6. Return the counts written per difficulty (do not repeat the questions).`
}

function verifyPrompt(s, name) {
  return `You are the independent verifier for a batch of original SAT Reading and Writing questions (${s.skill}). You solve them cold: you do not know the intended answers, and you must not open the file named in the manifest's \`source\` field, which holds the keys.

1. Cut your manifest (the command prints only a count):
   cd ${TOOLS} && python3 jobs_verify_originals.py --name ${name} --size 30 --staged
   Then read ${JOBS}/verify-originals-${name}-01.json and the spec it names (the \`spec\` path), the whole file, and follow its section "Verification jobs" exactly.
2. Solve each question from the passage, question and choices alone, the way a careful, strong student would. ${SOLVE[s.slug]} Where two choices seem defensible, decide whether one is clearly best; if not, \`answer\` is null with the reason in \`note\`.
3. Use \`note\` to flag, briefly, anything a student could be misled by: a stated fact that is false or overstated, wording that is off, a distractor that contradicts itself or is also defensible, or a passage that retells a specific real published study under invented names. Leave \`note\` empty when there is nothing to flag.
4. Write one JSON line per question to the manifest's \`out\` path, in the spec's format, once you have solved them all. Write nothing else anywhere.
5. Return the counts and the indices you flagged.`
}

function fixPrompt(s, name) {
  const dash = s.slug === 'boundaries' ? 'no em dashes except in a question that tests dash punctuation' : 'no em dashes'
  return `You are the editor for batch ${name} of original SAT Reading and Writing questions (${s.skill}). An independent verifier has solved the batch blind.

Files:
- Questions: ${OUT}/${name}.jsonl (one JSON object per line; line i is question index i)
- Blind answers: ${OUT}/${name}.blind-01.jsonl (lines of {"index", "answer", "note"})
- Rules every question must meet: ${TOOLS}/SPEC.md, section "Original-question jobs"

0. If the blind-answers file is missing, or does not have one line per question, change nothing and return buildLine "blind answers missing", kept 0, dropped 0.
1. Where a blind answer differs from the question's \`answer\`, change nothing: the build drops that question.
2. For each question the verifier agreed with but left a note on, decide:
   - Harmless (a style preference, or a caveat no student would be misled by): leave it.
   - A fact is false or overstated, wording is off, or a distractor is flawed: make the smallest edit to the passage, choices or explanations that fixes it. Keep the same correct choice, keep every explanation consistent with the edited text, and follow the rules (explanations never name a choice letter; ${dash}).
   - It cannot be fixed without rewriting the question (for example, it retells a real published study): drop it by setting that index's \`answer\` to null in the blind-answers file, with the note "dropped by editor: <reason>".
   Never add, remove or reorder lines in either file. Write a changed file atomically: a temporary file in the same folder, then rename it over the original.
3. Promote the blind answers so the build reads them:
   mv ${OUT}/${name}.blind-01.jsonl ${OUT}/${name}.verify-01.jsonl
4. Build and import:
   cd ${TOOLS} && python3 build.py original
   cd ${SERVER} && node --env-file=.env scripts/import-dataset.js ${DATA}/dataset original --institution satify
   The build prints a line for ${name} and, under it, each dropped question with its reason. A question dropped as malformed means an edit broke it: fix it and run both commands again.
5. Return the build line for ${name}, the kept and dropped counts from it, the indices you edited and the indices you dropped.`
}

async function fix(s, name, v) {
  const f = await run('high', fixPrompt(s, name), { label: `fix ${name}`, phase: 'Fix and import', effort: 'medium', schema: FIX_SCHEMA })
  if (!f) { log(`${name}: fix and import did not finish`); return { name, status: 'fix-failed', verify: v } }
  log(`${name}: kept ${f.kept}, dropped ${f.dropped}${f.edited.length ? `, edited ${f.edited.length}` : ''}`)
  return { name, status: f.buildLine === 'blind answers missing' ? 'fix-failed' : 'imported', verify: v, fix: f }
}

async function finish(s, name) {
  const v = await run('high', verifyPrompt(s, name), { label: `verify ${name}`, phase: 'Verify', model: 'sonnet', effort: 'high', schema: VERIFY_SCHEMA })
  if (!v) { log(`${name}: verification did not finish`); return { name, status: 'verify-failed' } }
  return fix(s, name, v)
}

async function runSkill(s) {
  const results = []
  const tails = []
  for (const step of s.steps) {
    const name = `rw-${pad(step.wave)}-${s.slug}`
    if (step.state === 'fix') { tails.push(fix(s, name, null)); continue }
    if (step.state === 'write' || step.state === 'complete') {
      const w = await run('low', writerPrompt(s, step, name), { label: `write ${name}`, phase: 'Write', effort: 'high', schema: WRITE_SCHEMA })
      if (!w || w.easy + w.medium + w.hard < 1) {
        log(`${name}: writer did not finish; ${s.skill} stops here`)
        results.push({ name, status: 'write-failed' })
        break
      }
      log(`${name}: written ${w.easy + w.medium + w.hard}`)
    }
    // Verification and fixing overlap the next batch's writing.
    tails.push(finish(s, name))
  }
  results.push(...(await Promise.all(tails)))
  return { skill: s.skill, results }
}

phase('Write')
const bySkill = (await parallel(args.plan.map((s) => () => runSkill(s)))).filter(Boolean)
const all = bySkill.flatMap((r) => r.results)
const imported = all.filter((r) => r.status === 'imported')
const kept = imported.reduce((n, r) => n + (r.fix ? r.fix.kept : 0), 0)
const unfinished = all.filter((r) => r.status !== 'imported')
log(`done: ${imported.length} batches imported, ${kept} questions kept, ${unfinished.length} batches unfinished`)
return {
  kept,
  imported: imported.map((r) => ({ name: r.name, kept: r.fix.kept, dropped: r.fix.dropped, edited: r.fix.edited, droppedByEditor: r.fix.droppedByEditor })),
  unfinished: unfinished.map((r) => ({ name: r.name, status: r.status })),
}
