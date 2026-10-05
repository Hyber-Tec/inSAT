export const meta = {
  name: 'classmarker-import',
  description: "Transcribe, blind-check, explain and import the academy's ClassMarker questions with Claude Code agents instead of an API key, a round at a time",
  phases: [
    { title: 'Cut', detail: "the import script takes in the last round's results, imports what is finished and cuts the next jobs", model: 'haiku' },
    { title: 'Work', detail: 'one agent per job: turn images into text, solve blind, or write explanations', model: 'sonnet' },
  ],
}

// args: {
//   skip:     ClassMarker categories to leave out, comma-separated (e.g. the drill categories)
//   perPass:  questions each pass takes per round (default 300)
//   jobSize:  questions per job (default 20)
//   rounds:   stop after this many rounds (default 40)
// }
// Each round is: cut (one command), then every job in parallel. A round waits
// for all its jobs because the next cut needs their results: a question moves
// from transcription to the blind check to explanations one round at a time.

const SERVER = '/Users/br0k3r/workspace/vantedge/satify/server'
const INPUT = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl'
const A = args || {}
const PER_PASS = A.perPass || 300
const JOB_SIZE = A.jobSize || 20
const ROUNDS = A.rounds || 40
const SKIP = A.skip ? ` --skip-categories ${A.skip}` : ''
const CUT = `cd ${SERVER} && node --env-file=.env scripts/import-classmarker.js ${INPUT} --institution satify --jobs --limit ${PER_PASS} --job-size ${JOB_SIZE}${SKIP}`
const CUT_SCHEMA = {
  type: 'object',
  properties: {
    jobs: { type: 'array', items: { type: 'string' }, description: 'every path listed under "jobs cut for agents", in order; empty if that section is missing' },
    ready: { type: 'string', description: 'the full output line that starts with "ready"' },
  },
  required: ['jobs', 'ready'],
}

const work = (job) => `Do the job in ${job}. Read that file first: its "how" field says how to work and where to write, and its "instructions" field says what to produce. Look at every image it lists with the Read tool (you can read several in one step). Write the results file it names, then reply with only "done" and the number of lines you wrote. Do not edit or create any other file.`

let jobsDone = 0
for (let round = 1; round <= ROUNDS; round += 1) {
  const cut = await agent(
    `Run this command exactly as written, once, and wait for it to finish:\n\n${CUT}\n\nThen report what it printed, as asked.`,
    { phase: 'Cut', label: `cut ${round}`, model: 'haiku', schema: CUT_SCHEMA },
  )
  if (!cut) { log(`round ${round}: the cut step failed, stopping`); break }
  log(`round ${round}: ${cut.ready}; ${cut.jobs.length} new jobs`)
  if (!cut.jobs.length) break
  await parallel(cut.jobs.map((job) => async () => {
    const label = job.split('/').pop().replace(/\.json$/, '')
    // One retry: a job left without results would hold its questions back.
    const done = await agent(work(job), { phase: 'Work', label, model: 'sonnet' })
      || await agent(work(job), { phase: 'Work', label: `${label} again`, model: 'sonnet' })
    if (done) jobsDone += 1
    return done
  }))
}
return { jobsDone }
