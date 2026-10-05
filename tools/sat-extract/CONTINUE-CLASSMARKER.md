# Continue the ClassMarker import (for any AI coding agent)

This guide lets any AI coding agent (Claude Code, Cursor, Cline, a Grok-based
agent, and so on) carry on turning an academy's own ClassMarker question pool
into checked, explained SAT practice questions in insat's question bank.

The work is cut into job files. Your part is to do the jobs. A script does
everything else: it picks the questions, checks every result you write, drops
anything that fails, and imports the finished questions into the bank.

## What you need

- To run on the Mac that has the data. The repo is at
  `/Users/br0k3r/workspace/vantedge/satify`. The data is at
  `private-data/SAT/extracted/classmarker/` in the repo (git ignores it): the questions, about 11,000
  images, the job files and the results written so far.
- A shell (to run `node`), file read and write, and the ability to look at
  PNG images. If your tool cannot look at images, see "Without images" below.
- The app's database: the Firebase emulators running (`./start.sh` from the
  repo root starts them with the whole app) and `FIRESTORE_EMULATOR_HOST`,
  `FIREBASE_AUTH_EMULATOR_HOST` and `FIREBASE_STORAGE_EMULATOR_HOST` set as in
  `functions/.env.example`; or production, with Application Default
  Credentials (README, "Admin scripts and their target").
- The API's packages installed: `cd functions && npm install`, once.

## The loop

1. From `functions/`, run the cut command:

   ```
   node --env-file-if-exists=.env.local scripts/import-classmarker.js ../private-data/SAT/extracted/classmarker/questions.jsonl --institution satify --jobs --limit 100 --job-size 20 --skip-categories 211,226,212,229,238,228,231,225,215,237,230,219,234,135,233,218,232,217,166,222,209,207,240,0
   ```

   It takes in every finished job's results, imports every question that is
   now complete, prints what it kept and dropped, and writes the next job
   files. Their paths are listed under "jobs cut for agents".
2. Do every job it listed, as described below.
3. Run the cut command again. Repeat until it cuts no new jobs.

The category list keeps this to math first. It leaves out the academy's
Reading and Writing categories, its basic-drill categories (166, 222, 209,
207, 240) and uncategorized questions (0). When math is done, change the list to
`166,222,209,207,240` to do Reading and Writing and uncategorized questions
next. The drill categories can stay skipped: nearly all of them fail the
SAT-likeness check anyway.

## Doing a job

A job file (`jobs/transcribe-NNN.json`, `jobs/blind-NNN.json` or
`jobs/keyed-NNN.json`) holds everything the job needs:

- `instructions`: what to produce for each entry in `questions`, and the rules.
  They are the same instructions the API version of this import uses. Follow
  them exactly: field names, allowed values, math in LaTeX inside `\( \)`.
- `images`: image files to look at before answering, each after its label.
  Look at all of them in one step if your tool allows it.
- `out`: the results file to write. One JSON object per line, one line per
  question, in the order given, and nothing else. Where the instructions say to
  return a JSON array, write its objects one per line to this file instead.

There are three kinds of job:

- **transcribe**: turn each image of math or a table into text, and keep at
  most one real figure (a graph, a diagram) as a picture. Do not solve.
- **blind**: solve each question without its answer key, rate how much it reads
  like a real SAT question, and sort it into a skill and difficulty.
- **keyed**: with the key given, lay the question out and write an explanation
  for the right answer and for each wrong choice.

## Rules that matter

- **Work only from the job file and its images.** Never open `questions.jsonl`,
  the `stage*` results files or other jobs yourself (the cut command reads
  them, which is fine). They contain the answer keys, and
  a blind job only counts as a check if it is solved without the key.
- **Never change a question's wording, numbers or choices.** Only lay them
  out. The script compares your text with the original and rejects changes.
- **In explanations, never refer to a choice by its letter or position**
  ("choice B", "the second option"). Choices are shuffled for each student.
  Say what the choice claims. Write no em dashes in explanations.
- **Write the results file once, when the job is done.** A job counts as done
  as soon as its results file exists. A question missing from that file goes
  into a later job.
- **Do not edit any other file**, do not commit or push, and do not change
  the script's checks or thresholds to let more questions through.
- **Never log in to ClassMarker.** Everything needed is already on disk, and
  nothing there may be edited or deleted.

## Without images

If your tool cannot look at image files, add `--no-images` to the cut command.
Questions that show images then wait for a tool that can look at them.

## Keeping cost down

Agents spend most of their tokens rereading context. Read the job file once,
look at its images in one step, and write the results file in one step. Bigger
jobs (`--job-size`) spread that overhead over more questions.

## Reading the output

The cut command prints the usable questions, how many are transcribed, solved
and explained so far, what was dropped and why, and a line starting `ready`
with how many questions were imported. Dropping is normal. Drills, questions
with no single right answer, College Board copies and any result that changed
a question's text are left out on purpose.

## If something goes wrong

- The script says it writes to production when you meant the emulators: set
  the three emulator variables (above), or put them in `functions/.env.local`.
- `ECONNREFUSED` on port 8090: the Firestore emulator is not running. Start it
  as above.
- A job keeps coming back: its results file was never written. Do it again. To
  have a job cut afresh instead, delete its job file.

## Where things stand

As of 2026-09-25, a pilot of 60 math questions ran through all three kinds of
job and imported 49 of them, with no answer key disagreements. About 7,300
math questions remain, and about 19,000 in all.
