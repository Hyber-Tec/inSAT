# sat-extract: SAT source material to structured questions

Turns the College Board question bank (fetched from the bank's own site, or
its PDF export) and the full-length practice tests (`DSAT/`) into one JSON
record per question, with math in LaTeX, underlines, tables and figures, and
the day each was published, ready for `functions/scripts/import-dataset.js`.

Everything this tooling reads and writes lives in the project's `private-data/`
folder, which git ignores, next to the sources (`SAT_SRC`, default
`private-data/SAT`; output in `SAT_OUT`, default `$SAT_SRC/extracted`). The
material is College Board and third-party content, so none of it, and nothing
derived from it, is committed.

Requirements: Python 3 with PyMuPDF (`pip install pymupdf`), Tesseract (DSAT
OCR only), Node (the KaTeX check uses `web/node_modules`).

## The bank from its own site

The College Board's question bank (satsuitequestionbank.collegeboard.org)
reads its questions from a public JSON API. `cb_api.py` fetches from there
what the PDF export cannot give: every SAT question's id, skill, current
difficulty and the day the College Board published it (`list.json`), and the
question itself as HTML, its math as MathML and its figures as SVG with the
bank's own description (`items/<id>.json`, kept as served under
`SAT_SRC/College Board Question Bank API/`). A rerun fetches only what the
bank changed since, so a bank update is `cb_api.py`, `build.py cb` and the
import.

`cb_html.py` reads that HTML into the record below, in the transcriptions'
conventions, exactly where the PDFs had to be transcribed: it is the text of
every bank question but the 459 of its first release that the bank serves
only as images of their math (those keep their transcription). Against the
2,804 questions both cover, it agrees on every key; where it differs, the
transcription had lost the grouping of the rationale math (266, the PDF's
defect below), or the College Board has rewritten the question or its
explanation since the export. A question the export also holds keeps the
figures cropped from it; a new one's figures are drawn from the HTML by
`render_figures.mjs` (Chromium: an SVG as served, a table from its cells,
math by KaTeX in the app's serif).

`cb_new.py` reports what the bank added since the PDF export, and which of it
was already in hand: the same question in the practice tests, the original
questions or the academy's ClassMarker pool (on 2026-10-26, 158 of 507, 151 of
them in the ClassMarker pool).

## Why two paths for the PDFs

Reading and Writing is prose. The PDF text layer holds all of it exactly, so
`cb_rw.py` parses it deterministically: paragraphs from line gaps, bullets from
the drawn bullet dots, underlines from the drawn strokes (`<u>...</u>`), verse
line breaks from short lines, isotope super/subscripts from their baselines.

Math is not recoverable from the text layer. In the College Board export, stem
and choice math is drawn as vector paths or pasted in as small images, and the
rationale math that is real text lost its parentheses and exponents when the
PDF was made (a page reads `3xx + 9 - 7x + 9` for `3x(x + 9) - 7(x + 9)`).
Ghostscript additionally mangles the non-BMP math-italic letters into
U+FFFD replacement characters, which is what the old importer stored. The practice tests are
mostly scans with no text layer at all. So those pages are read by a vision
pass: page images are rendered, split into job manifests, and transcribed by
Claude sub-agents following `SPEC.md`, one record per question, each answer
independently re-solved.

## Pipeline

| Step | Script | Output (under `SAT_OUT`) |
|---|---|---|
| Fetch the bank from its own site: the list (dates, current labels) and each question's HTML | `cb_api.py` | `SAT_SRC/College Board Question Bank API/` |
| Report what the bank added since the PDF export, and which of it was already in hand | `cb_new.py` | `reports/cb-new.md`, `reports/cb-new.json` |
| Index the bank: question ids, page regions, text-layer key and difficulty | `cb_index.py` | `cb/index.json` |
| Parse Reading and Writing from the text layer | `cb_rw.py` | `out/cb/<id>.json`, `cb/rw-needs-vision.json` |
| Render bank math pages, cropped to each question | `render_cb.py` | `cache/pages/cb/`, `cb/render.json` |
| Render every DSAT page (Word files laid out with `docx_render.py`) | `dsat_render.py` | `cache/pages/dsat/`, `dsat/render.json` |
| OCR the DSAT pages (module boundaries, validation) | `dsat_ocr.py` | `dsat/ocr/` |
| Cut vision jobs | `jobs_cb.py`, `jobs_dsat.py` | `jobs/*.json` |
| Transcribe (vision) | sub-agents, `SPEC.md` | `out/cb/`, `out/dsat/` |
| Read Reading and Writing explanations of born-digital College Board tests (10 to 13) from the text layer | `dsat_explain_text.py` | `out/dsat/tNN/explain1-*.json` |
| Track progress | `status.py` | |
| Validate against the text layer, KaTeX and the rules | `validate.py`, `katex_check.mjs` | `reports/` |
| Build the dataset: the bank's own questions (`cb_html.py`) or the transcriptions, labels and dates, normalized answers, figure crops and drawings (`render_figures.mjs`) | `build.py` | `dataset/*.jsonl`, `dataset/figures/` |
| Cut original-question jobs (questions students will see), and the blind checks of their output | `jobs_originals.py`, `jobs_verify_originals.py` | `jobs/originals-*.json`, `jobs/verify-originals-*.json` |
| Decode an academy's ClassMarker export (markup to the bank's conventions; flags for images, College Board text, CrackSAT and repeats) and, with `--fetch-images`, download the images it names; `functions/scripts/import-classmarker.js` transcribes, checks and imports it | `classmarker.py` | `classmarker/questions.jsonl`, `classmarker/images/` |
| Write and verify originals (a writer, a blind solver on a different model, an editor who applies its notes and promotes `.blind-NN` to `.verify-NN`) | sub-agents, `SPEC.md` | `out/original/<name>.jsonl`, `out/original/<name>.verify-NN.jsonl` |

`dsat_sources.py` is the one table that decides which files make up each test.
Where a source has a clean text layer, prose is read from it rather than
through vision: it is exact, and a passage an explanation quotes at length
never has to pass through a model (the vision pass was stopped by the API's
content filter on such pages, in the bank and in Tests 11 and 12).
`zoom.py` lets a reader re-render part of a page at higher resolution.

Raw transcription records are never edited by later steps; `build.py` derives
everything from them, so it can be re-run at any time.

## Record shape

See `SPEC.md` for the full rules. In short: `passage` (Reading and Writing
only), `question`, `answer_type` (`multiple-choice` | `grid-in`), `choices`
(four, no letter labels), `answer` (letter, or the grid-in value), `accepted`
(every grid-in form the source accepts), `rationale`, `figure` (kind, bbox,
description, structured `table` cells with spans), `check` (the reader's own
solution against the key) and `flags` (`source-error`, `restored-grouping`,
`key-mismatch`, `unreadable`, `figure-in-choices`).

The dataset adds `published_on` (the day the bank published the question,
or its practice test's `published` date in `dsat_sources.py`; undated for
the three scans that record none), `method` (`html`, `text` or `vision`) and,
for a bank question with figures, `figure_key`: a fingerprint of the figures
as the bank serves them, since the bank asks the same words of different
graphs and the import's content hash must tell them apart. A grid-in's
`accepted` holds the bank's own entries and the forms its explanation names,
each checked against the bank's values.
