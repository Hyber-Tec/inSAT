# sat-extract: SAT source material to structured questions

Turns the College Board question bank PDFs and the full-length practice tests
(`DSAT/`) into one JSON record per question, with math in LaTeX, underlines,
tables and figures, ready for `functions/scripts/import-dataset.js`.

Everything this tooling reads and writes lives in the project's `private-data/`
folder, which git ignores, next to the sources (`SAT_SRC`, default
`private-data/SAT`; output in `SAT_OUT`, default `$SAT_SRC/extracted`). The
material is College Board and third-party content, so none of it, and nothing
derived from it, is committed.

Requirements: Python 3 with PyMuPDF (`pip install pymupdf`), Tesseract (DSAT
OCR only), Node (the KaTeX check uses `web/node_modules`).

## Why two paths

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
| Build the dataset: labels, normalized answers, figure crops | `build.py` | `dataset/*.jsonl`, `dataset/figures/` |
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
