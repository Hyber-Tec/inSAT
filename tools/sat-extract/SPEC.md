# Transcription spec: SAT page images to structured questions

You are turning page images of SAT questions into exact, machine-readable
records. The records are imported into a question bank and rendered to students
with KaTeX, so fidelity matters more than speed: a wrong digit, a dropped
exponent or a misread answer key makes a question wrong for every student who
sees it.

You are given a job manifest (JSON). It lists the questions (or pages) to
transcribe, the image files to read, and where to write each result. Read the
manifest first, then this whole spec, then work through the images in order.

## Working method

0. A previous run may already have written some records. List the job's
   `out` files that exist (one `ls` of the output folder) and skip those
   questions.
1. Read the images with the Read tool, several per turn (about 4 to 6).
2. For every question you finish, write its record with the Write tool to the
   exact path the manifest gives (one JSON object per file, pretty-printed or
   not, UTF-8). In each turn, send the Write calls for the questions you just
   read together with the Read calls for the next images, so no turn is spent
   only waiting.
3. If a question continues onto the next image, read that image before writing
   the record. Never write a record for a question you have not fully seen.
4. Do not skip questions. If something is truly unreadable, still write the
   record with your best reading and add a flag (see Flags).
5. When the job is done, reply with a short summary: how many records written,
   and every flag you raised, one line each. Nothing else.

Do not browse the web, do not run code that modifies the source files, and do
not write anywhere except the output paths in the manifest.

## Record format

```json
{
  "uid": "<from the manifest>",
  "passage": null,
  "question": "...",
  "answer_type": "multiple-choice",
  "choices": ["...", "...", "...", "..."],
  "answer": "B",
  "accepted": [],
  "rationale": "...",
  "figure": null,
  "check": {"status": "ok", "note": ""},
  "flags": []
}
```

Some jobs ask for extra fields (for example `section`, `module`, `number`,
`domain`); the manifest says which. Include exactly the fields listed there.

### Fields

- `passage`: Reading and Writing only. The text the question is about,
  everything above the question sentence. For math always `null`.
- `question`:
  - Reading and Writing: the question sentence(s) only, e.g. "Which choice
    completes the text with the most logical and precise word or phrase?" For
    Rhetorical Synthesis this includes the goal sentence ("The student wants to
    ... Which choice most effectively uses relevant information from the notes
    to accomplish this goal?").
  - Math: everything the student reads before the choices, in reading order:
    any stimulus text, displayed equations, and the question sentence. Put a
    displayed equation or expression on its own line as `\[ ... \]`.
    Separate paragraphs with `\n`.
- `answer_type`: `"multiple-choice"` (exactly four options A-D) or `"grid-in"`
  (student-produced response, no options).
- `choices`: the four option texts in order A, B, C, D, without the letter
  label. `[]` for grid-in.
- `answer`: the letter (`"A"`-`"D"`) for multiple choice. For grid-in, the
  value exactly as the source states it (`"6632"`, `"7/6"`, `"-4"`, `".8823"`).
  If the source has no explicit "Correct Answer" line, take the answer from the
  rationale ("The correct answer is 7/6").
- `accepted`: grid-in only. Every equivalent form the source lists as correct
  ("Note that 7/6, 1.166, and 1.167 are examples of ways to enter a correct
  answer" gives `["7/6", "1.166", "1.167"]`). Include the `answer` value itself.
  `[]` for multiple choice.
- `rationale`: the full explanation as printed, every paragraph (including the
  "Choice A is incorrect..." paragraphs), paragraphs separated by `\n\n`. If the
  source has no explanation for this question, `""`.
- `figure`: see Figures. `null` when there is none.
- `check`: your independent verification, see Verification.
- `flags`: see Flags.

## Text rules

- Transcribe exactly. Keep the source's wording, spelling, punctuation and
  numbers, including its mistakes (flag them instead of fixing them). Do not
  paraphrase, summarize or "improve" anything.
- One exception, for a known defect of the College Board export: its rationale
  math sometimes lost its grouping symbols when the PDF was made, so a page
  shows `3xx + 9 - 7x + 9` where the original was `3x(x + 9) - 7(x + 9)`, or
  `3-63` for `3(-63)`. When the missing parentheses, brackets or absolute-value
  bars are unambiguous from the surrounding math, restore them and add the flag
  `restored-grouping: <what you restored>`. When they are not unambiguous, keep
  what is printed and flag `source-error`. Never restore anything else.
- Straight quotes and apostrophes (`'` and `"`).
- Dashes exactly as printed: hyphen (U+002D), en dash (U+2013) and em dash
  (U+2014) are different characters and Standard English Conventions
  questions test the difference, so never substitute one for another. Inside
  math write `-` for minus (KaTeX renders it as a minus sign).
- Blanks to fill in: `______` (six underscores), whatever the source shows
  (a line, the word "blank", a box).
- Underlined text (the "underlined sentence/portion" questions): wrap it in
  `<u>` and `</u>`. This is the only markup allowed. Do not mark bold or
  italics, except that an italicized title stays plain text.
- Paragraph breaks: `\n` between paragraphs of a passage. Two texts ("Text 1",
  "Text 2"): keep the labels as their own lines: `Text 1\n...\nText 2\n...`.
- Bulleted notes (Rhetorical Synthesis): one bullet per line, each starting
  with `• `, the intro line ("While researching a topic, a student has taken
  the following notes:") on its own line before them.
- Poems or line-numbered verse: keep line breaks with `\n`.
- Leave out page furniture: running headers and footers, page numbers,
  "Mark for Review", "Continue", question-number boxes, directions
  boilerplate, the "ID: ..." banners, the "Question Difficulty" line.

## Math rules

- All mathematics goes in LaTeX: inline `\( ... \)`, displayed `\[ ... \]`.
  This includes lone variables in prose ("for all \(x\)", "where \(a\) and
  \(b\) are constants"), points and segment names ("triangle \(ABC\)",
  "\(\overline{AB}\)"), and signed or decimal numbers inside expressions.
  Plain numbers in prose may stay plain ("the perimeter of triangle \(ABC\) is
  20"). Dollar amounts stay as text: "$5.25".
- Standard commands only, all supported by KaTeX: `\frac{a}{b}`, `\sqrt{x}`,
  `\sqrt[3]{x}`, `x^{2}`, `x_{1}`, `\le`, `\ge`, `\ne`, `\pi`, `\theta`,
  `\angle`, `\triangle`, `\overline{AB}`, `\overleftrightarrow{AB}`,
  `\overrightarrow{AB}`, `\parallel`, `\perp`, `\circ` (degrees: `30^{\circ}`),
  `\cdot`, `\times`, `\div`, `\pm`, `|x|`, `\left( \right)`, `\text{...}`.
  Systems of equations: `\[ \begin{aligned} y &= 2x + 1 \\ y &= -x + 4 \end{aligned} \]`
  or one `\[ ... \]` per line.
- In JSON strings every backslash is doubled: `"\\(x^{2}\\)"`.
- Keep the source's form. Do not simplify, reorder terms or change `0.5` to
  `\frac{1}{2}`. A mixed number stays a mixed number.
- Function notation as printed: `\(f(x) = 3x^{2} - 5\)`.
- A choice that is only math is only math: `"\\(y = 2x^{2} - 11x + 20\\)"`.

## Figures

A figure is anything that is not running text: a table, a graph (coordinate
plane, scatterplot, bar chart, line graph, histogram, dot plot, box plot), a
geometric diagram, a number line, or any other picture.

```json
"figure": {
  "kind": "table" | "graph" | "diagram" | "image",
  "image": "<file name of the image it appears in, e.g. 82aaa0a1-1.png>",
  "bbox": [x0, y0, x1, y1],
  "description": "...",
  "table": null
}
```

- `bbox`: the figure's bounding box in pixels of that image, top-left origin,
  generous by a few pixels on every side, including the figure's own title,
  axis labels and key but none of the surrounding question text. The manifest
  gives each image's width and height.
- Small print or dense plots: zoom in before reading values. Run
  the manifest's `zoom` command: `<zoom> <image path> x0 y0 x1 y1`, with the image's full
  `path` from the manifest (region in that
  image's pixels); it prints the path of a sharper rendering, which you Read.
  Use it whenever a digit, exponent, tick label or plotted point is not
  perfectly clear at the normal size.
- `description`: a complete, precise description a student who cannot see the
  figure could use to answer the question: axes and their labels and scales,
  every labeled point with coordinates, every plotted point you can read,
  line or curve shape and key points, bar heights, side lengths, angle
  measures, marks for equal sides or right angles, and what is shaded. State
  only what the figure shows.
- `table`: for `kind: "table"`, the full table as data, otherwise `null`:

```json
"table": {
  "title": "Number of points per round" or null,
  "header_rows": 2,
  "rows": [
    [{"text": "Hours practiced", "rowspan": 2}, {"text": "Number of points per round", "colspan": 3}],
    ["6 to 13 points", "14 or more points", "Total"],
    ["3 to 5 hours", "6", "4", "10"],
    ["More than 5 hours", "4", "26", "30"],
    ["Total", "10", "30", "40"]
  ]
}
```

  A cell is a string, or an object with `text` plus `colspan` and/or `rowspan`
  when it spans. Cell text follows the text and math rules (math in `\( \)`).
  A table still gets a `bbox` and a short `description`.
- More than one figure (for example a table and a graph): make `figure` a list
  of figure objects in reading order.
- Figures as answer choices ("Which graph could represent ..."): give each
  choice a short text description of its figure (for example
  `"Graph of a line through \\((0, 2)\\) and \\((3, 0)\\)"`), make `figure` a
  list with one figure object per choice, each with an extra `"choice": "A"`
  (etc.), and add the flag `figure-in-choices`.

## Verification

After transcribing a question, solve it yourself from your transcription alone.

- `check.status`:
  - `"ok"`: your solution gives the stated answer.
  - `"mismatch"`: it does not. Before recording this, re-read the image
    carefully, because a mismatch usually means a misread digit or sign. If it
    still does not match, keep the source's answer in `answer`, write your
    reasoning in `check.note`, and add the flag `key-mismatch`.
  - `"unverifiable"`: the question cannot be solved from what is on the page
    (for example it depends on a figure you cannot read precisely). Say why in
    `check.note`.
- For Reading and Writing, "solving" means confirming the keyed choice is the
  best answer by the SAT's standard. Keep `check.note` short.

## Flags

Short machine-readable strings, each optionally followed by `: detail`:

- `key-mismatch: ...` the stated answer disagrees with your solution.
- `source-error: ...` the source itself is wrong (duplicate choices, missing
  option, obvious typo in a choice or number, question text cut off).
- `unreadable: ...` part of the image cannot be read with confidence; say
  which part and give your best reading in the record.
- `figure-in-choices` see Figures.
- `restored-grouping: ...` see Text rules.
- `continues-elsewhere` the question clearly continues on an image you were
  not given.
- `not-a-question: ...` the image is not a question (directions page, blank
  page, answer sheet); only in page-based jobs.
- `quote-elided` an explanation's long quotation of published literary text
  (more than one line of a poem, play or novel) is cut to its first words and
  " [...]". Only in explanation jobs, and only when the job says so: the API's
  content filter stops a transcription that reproduces such text in full.

## Example

Image `82aaa0a1-1.png` shows a scatterplot, the question "Of the following,
which is the best model for the data in the scatterplot?", four quadratic
choices, "Correct Answer: B" and a rationale. The record:

```json
{
  "uid": "cb:82aaa0a1",
  "passage": null,
  "question": "Of the following, which is the best model for the data in the scatterplot?",
  "answer_type": "multiple-choice",
  "choices": [
    "\\(y = 2x^{2} - 11x - 20\\)",
    "\\(y = 2x^{2} - 11x + 20\\)",
    "\\(y = 2x^{2} - 5x - 3\\)",
    "\\(y = 2x^{2} - 5x + 3\\)"
  ],
  "answer": "B",
  "accepted": [],
  "rationale": "Choice B is correct. The graphical model that most closely fits the data in the scatterplot is a model in which the number of data points above and below the model are approximately balanced. Fitting a graphical model to the data shown results in an upward-facing parabola with a \\(y\\)-intercept near \\((0, 20)\\) and a vertex with an approximate \\(x\\)-value of 2.5. Of the given choices, only choice B gives an equation of an upward-facing parabola with a \\(y\\)-intercept at \\((0, 20)\\). Furthermore, substituting 2.5 for \\(x\\) into the equation in choice B yields \\(y = 5\\). This is approximately the \\(y\\)-value of the vertex of the model.\n\nChoices A, C, and D are incorrect. These equations don't give a graphical model that best fits the data. At \\(x = 0\\), they have \\(y\\)-values of \\(-20\\), \\(-3\\), and 3, respectively. At \\(x = 2.5\\), they have \\(y\\)-values of \\(-35\\), \\(-3\\), and 3, respectively.",
  "figure": {
    "kind": "graph",
    "image": "82aaa0a1-1.png",
    "bbox": [33, 58, 238, 272],
    "description": "Scatterplot in the xy-plane. The x-axis runs from 0 to 6 with ticks every 1; the y-axis runs from 0 to 20 with ticks every 2. Twelve points: (0, 20), (0.5, 14), (1, 10), (1.5, 8), (2, 6), (2.5, 5), (3, 5), (3.5, 6), (4, 9), (4.5, 11), (5, 15), (5.5, 20). The points decrease and then increase, a U shape with its lowest points at x = 2.5 and x = 3.",
    "table": null
  },
  "check": {"status": "ok", "note": "Upward parabola with y-intercept 20 and vertex near x = 11/4; only B has intercept 20."},
  "flags": []
}
```

## Page-based jobs (full practice tests)

Jobs for the full-length practice tests (`"collection": "dsat"`) list page
images in book order instead of questions. The manifest's `mode` says which
kind of pages they are: `book`, `explain` or `key`.

The first and last image may be marked `"context": true`. They belong to the
neighboring jobs: use them only to complete a question that runs over the job
boundary, and do not write records for questions whose number label is on a
context page.

### `book` mode: the questions students see

- Write one record for every question whose number label (the boxed or
  underlined question number) appears on one of the job's own pages. A
  question's passage, table or graph may be printed above its number label or
  on the page before; include it. If the question starts on a page before the
  job's first page, it belongs to the previous job; skip it.
- Output path: `<out_dir>/<book>-p<page>-q<number>.json`, where `page` is the
  3-digit page number of the image with the number label (the manifest gives
  each image's page) and `number` is the printed question number. For example
  `.../book1-p007-q05.json`.
- Extra fields, in this order after `uid`:
  - `uid`: `"dsat:t<NN>:<book>:p<page>:q<number>"`, the same parts as the file name.
  - `test`: the test number from the manifest.
  - `section`: `"rw"` or `"math"`, from the content.
  - `module`: 1 or 2 when a heading on this or an earlier page of the job tells
    you ("Module 2", "Math Module 1"); the manifest's `start_context` gives the
    module the job starts in when it is known. `null` if you cannot tell.
  - `module_label`: any variant label printed with the module heading, such
    as `"Harder"` or `"Easier"`, else `null`.
  - `number`: the printed question number, an integer.
  - `page`: the page number, an integer.
  - `domain`, `skill`: classify the question with the taxonomy in the manifest
    (use the exact ids and skill names given).
  - `difficulty`: your estimate, `"easy"`, `"medium"` or `"hard"`, as the SAT
    would rate it.
  - `solved_answer`: your own answer: the letter, or the value for grid-in.
- `answer` is `null` and `rationale` is `""` unless the page itself prints
  them (the book usually does not). `check.status` is `"solved"` when you
  worked out `solved_answer`, `"unverifiable"` when you could not (say why).
- Choice labels come in several styles: `A)`, `A.`, circled letters. Transcribe
  only the option text.
- A student-produced response question has no options (the page may show an
  empty answer box): `answer_type` `"grid-in"`, `choices` `[]`.
- Pages that hold no question (directions, the math reference sheet, a module
  title page, a blank or "STOP" page) get no record; list them in your final
  summary as `not-a-question: page <n>, <what it is>`.
- Scans can be crooked, faint or cut at the edge. Zoom in before guessing, and
  flag `unreadable` with your best reading when a word or number stays
  uncertain.

### `explain` mode: answer explanations

- Explanations are grouped by section and module under headings ("Reading and
  Writing, Module 1", "Math Module 2"); track the current heading as you go,
  starting from the manifest's `start_context` when given.
- Write one record per explained question to
  `<out_dir>/<explain>-p<page>-q<number>.json` (page of the explanation's first
  line), with fields: `uid` (`"dsat:t<NN>:<explain>:p<page>:q<number>"`),
  `test`, `section`, `module` (or `null`), `module_label`, `number`, `page`,
  `answer` (as the explanation states it: letter, or value for grid-in),
  `accepted` (every correct grid-in form it lists), `rationale` (the full
  explanation, math in LaTeX, same text rules), `flags`.
- If the explanation reprints the question, do not copy the question into
  `rationale`; keep only the explanation.

### `key` mode: answer keys

- For each entry in the manifest's `keys` list, read its images and write one
  file, at that entry's `out` path, holding the test's whole key:

```json
{
  "test": 8,
  "modules": [
    {"section": "rw", "module": 1, "module_label": null,
     "answers": {"1": "A", "2": "C"}},
    {"section": "math", "module": 1, "module_label": null,
     "answers": {"6": ["3", "3/10"], "7": "C"}}
  ],
  "flags": []
}
```

- A grid-in with several accepted values is a list of every value printed.
- Keep the source's numbering and order. If a module's answers are printed
  without a module split (one continuous list), use one entry with
  `"module": null` and number the answers as printed.
- Check your reading: count the answers per module and compare with the
  highest question number; flag any gap or doubtful entry
  (`unreadable: rw module 2 question 14`).

## Figure-only jobs

Some Reading and Writing questions carry a table or chart. Their text comes
straight from the PDF text layer, which holds it exactly, so a job with
`"mode": "figure"` asks only for the figures.

- Write one record per question, to its `out` path, with exactly the fields
  `uid`, `figure` and `flags`.
- `figure` follows the Figures section in full: `kind`, `image`, `bbox`,
  `description`, and for tables the complete `table` with every cell. The
  `bbox` matters more than usual here: the text inside it is removed from the
  text-layer transcription, so it must cover the whole figure (title, axis
  titles and labels, legend, notes such as a source line printed under the
  figure) and nothing of the passage or the question.
- Do not transcribe the passage, question, choices or rationale.
- Use `flags` as usual for anything wrong or unreadable in the figure.

## Adjudication jobs

`"mode": "adjudicate"` jobs list questions whose answer key disagrees with the
transcriber's own solution. For each one the manifest gives the transcribed
record, the key, the transcriber's solution and note, the explanation text if
the source has one, and the page images.

1. Read the page images first, and compare them with the transcribed record
   word by word and symbol by symbol. A disagreement is often a misread digit,
   sign or choice, not a wrong key.
2. Solve the question yourself from the images, independently of both the key
   and the earlier solution.
3. Write one file per question to its `out` path:

```json
{
  "uid": "<from the manifest>",
  "verdict": "key-correct" | "key-wrong" | "ambiguous" | "transcription-error",
  "answer": "<the correct answer: letter, or grid-in value>",
  "accepted": ["<grid-in forms, if grid-in>"],
  "corrections": {"<field>": "<corrected value>"},
  "note": "one or two sentences: why"
}
```

- `key-correct`: the key is right; the earlier solution was wrong.
- `key-wrong`: the question is sound but the key is wrong; `answer` is right.
- `ambiguous`: the question as printed has no single defensible answer
  (missing information, two correct choices, a broken stem).
- `transcription-error`: the record misreads the page; give only the fields
  that need changing in `corrections` (same formats as the record), and in
  `answer` the answer to the question as it really reads.

## Explanation-writing jobs

`"mode": "write-explanations"` jobs list questions whose source printed no
explanation. For each one the manifest gives the finished record (passage,
question, choices, the verified answer and accepted forms, figure descriptions
and the figure image if there is one), plus two or three explanations from the
College Board's own bank for the same skill, as the style to write in.

1. Solve the question yourself first, from the record and the figure image,
   without looking at the answer. If your answer differs from the given one,
   write no explanation: set `agrees` to false and say why in `note`.
2. Otherwise write the explanation the way the College Board's do: why the
   correct choice is correct, in terms of the passage or the mathematics, then
   why each other choice is incorrect, one or two sentences each, referring to
   choices by their letters in the record's order. For a student-produced
   response, work the solution through to the value. Math goes in `\( \)`
   with the record's LaTeX conventions.
3. Write one file per question to its `out` path:

```json
{
  "uid": "<from the manifest>",
  "solved": "<your own answer>",
  "agrees": true,
  "rationale": "<the explanation, or null>",
  "note": "<only when agrees is false>"
}
```

## Original-question jobs

`"mode": "write-originals"` jobs ask for new, original questions in a skill,
written to the College Board's style: the manifest names the skill, the domain,
how many to write at each difficulty, and gives several of the bank's own
questions for that skill as models. These questions will be shown to students.

- Every passage is written fresh for the question. Nothing is adapted, quoted
  or closely paraphrased from a published work, a news article or an existing
  test question; invented studies, people and works are fine when the question
  does not turn on real-world facts. Any real fact used must be true.
- The question has exactly one defensible answer. Distractors are wrong for a
  reason a student could fall for, never merely silly.
- `rationale.correct` explains why the answer is right; `rationale.A` to
  `rationale.D` explain why each other choice is wrong. Explanations never
  refer to a choice by its letter (choices are shuffled per student); say what
  the choice claims instead.
- Difficulty follows the bank's calibration: an easy item is direct, a hard
  item needs a second inference or a subtler distinction.
- A passage has no figure. Quantitative evidence goes in a small table at the
  top of the passage: a title line, then one line per row with cells
  separated by ` | `, the header row first, then a blank line before the
  prose. The app sets it as a ruled table with the title above.
- A target's `avoid_topics` lists the opening words of every passage already
  written for that skill and for the other skills of its domain. Write on
  other subjects: no passage about the same study, work, person, place or
  phenomenon as one of those.

Write all questions to the manifest's `out` path as JSON lines, one object per
question:

```json
{"section": "rw", "domain": "<domain>", "skill": "<skill>", "difficulty": "easy|medium|hard",
 "passage": "...", "question": "...", "choices": ["...", "...", "...", "..."], "answer": "B",
 "rationale": {"correct": "...", "A": "...", "B": "", "C": "...", "D": "..."}}
```

A separate verification job then solves each question blind. Only questions
whose blind answer matches are kept, so an item you are unsure of is better
left out than included.

## Verification jobs

`"mode": "verify-originals"` jobs list original questions with their keys and
explanations removed. Solve each one cold, from the passage, question and
choices alone, the way a careful student would. Do not rewrite anything: the
job is a second, independent reading of each question.

Write one JSON line per question to the manifest's `out` path:

```json
{"index": 0, "answer": "B", "note": ""}
```

- `index` is the question's `index` in the manifest.
- `answer` is the letter of the one choice that is correct. When no single
  choice is defensible (two choices fit, none fits, the passage contradicts
  itself), `answer` is `null` and `note` says why.
- `note` is otherwise empty, or a short remark on a flaw a student would run
  into (a distractor that is also true, a real fact that is wrong).

Only a question whose blind answer matches the writer's key is kept
(`build.py original`); the rest are dropped with their notes in the report.

The `out` path may be a staging file, `<name>.blind-NN.jsonl`: an editor then
applies the fixes the notes call for (without changing any key), sets an
answer to null to drop a question that cannot be fixed, and renames the file
to `<name>.verify-NN.jsonl`. The build reads only `.verify-NN` files, so a
batch is never imported before its fixes.
