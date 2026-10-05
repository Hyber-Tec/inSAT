"""Read Reading and Writing answer explanations straight from a born-digital
explanation PDF's text layer (the College Board's own "Answer Explanations"
for its practice tests), instead of through the vision pass.

Those files have a clean text layer and a fixed layout: a running header
naming the section and module, "QUESTION n" in bold, then paragraphs of
explanation ("Choice B is the best answer because..."). Prose comes through
exactly, which vision can only approximate, and a passage the explanation
quotes at length never has to pass through a model (the vision pass was
stopped by the content filter on exactly such a page). Math explanations are
left to the vision pass: their math does not survive in the text layer.

Records are written in the explanation-job format (SPEC.md), one file per
question, replacing any vision record of the same question.

Usage: python3 dsat_explain_text.py --tests 12   -> OUT/out/dsat/tNN/explain1-pPPP-qNN.json
"""

import argparse
import json
import re
from pathlib import Path

import pymupdf

from common import DSAT_ROOT, OUT, write_json
from cb_rw import clean
from dsat_sources import TESTS

HEADER = re.compile(r'(READING AND WRITING|MATH)\s*:\s*MODULE\s*([12])', re.I)
QUESTION = re.compile(r'^QUESTION\s+(\d+)$')
ANSWER = re.compile(r'\bChoice ([A-D]) is the best answer\b')
PARA_GAP = 15.5   # lines inside a paragraph are 12.6pt apart, paragraphs 18.6pt
MARGIN_Y = (60, 730)  # running header above, page number and footer below
BODY_MAX = 11.5   # body text is 9pt; module titles and their "(33 questions)" are 12pt and up
CLOSED = ('-', '\u2014', '\u2013')  # a line ending in a hyphen or dash runs straight on


def lines_of(page):
    """Body lines of one page, in reading order, with their position and size."""
    out = []
    for block in page.get_text('dict')['blocks']:
        for ln in block.get('lines', []):
            text = ''.join(s['text'] for s in ln['spans']).strip()
            if not text:
                continue
            x0, y0, x1, _ = ln['bbox']
            size = max(s['size'] for s in ln['spans'])
            out.append({'text': text, 'x0': x0, 'y0': y0, 'x1': x1, 'size': size})
    return sorted(out, key=lambda l: (round(l['y0'], 1), l['x0']))


def module_of(page):
    """(section, module) from the page's running header, or None."""
    m = HEADER.search(page.get_text())
    if not m:
        return None
    return ('rw' if m.group(1).lower().startswith('reading') else 'math', int(m.group(2)))


def questions(doc):
    """Yield one dict per question: section, module, number, page, paragraphs."""
    cur = None
    for pno, page in enumerate(doc, 1):
        where = module_of(page)
        prev_y = None
        for ln in lines_of(page):
            if not (MARGIN_Y[0] < ln['y0'] < MARGIN_Y[1]):
                continue
            q = QUESTION.match(ln['text'])
            if q and ln['size'] >= 12:
                if cur:
                    yield cur
                section, module = where or (None, None)
                cur = {'section': section, 'module': module, 'number': int(q.group(1)), 'page': pno, 'paras': []}
                prev_y = None
                continue
            if cur is None or ln['size'] > BODY_MAX:   # section and module titles
                continue
            # Prime marks stand in for a quote and an apostrophe in a few places;
            # this is prose, where a prime is never meant.
            text = clean(ln['text']).replace('\u2033', '"').replace('\u2032', "'")
            if not cur['paras'] or (prev_y is not None and ln['y0'] - prev_y > PARA_GAP):
                cur['paras'].append(text)
            else:
                # The source sets dashes closed ("India\u2014contrasts"), so a line
                # broken at a dash or a compound's hyphen joins without a space.
                last = cur['paras'][-1]
                joiner = '' if last.endswith(CLOSED) and not last.endswith((' -', ' \u2014', ' \u2013')) else ' '
                cur['paras'][-1] = last + joiner + text
            prev_y = ln['y0']
    if cur:
        yield cur


def existing_records(tdir):
    """Explanation records already written for a test, keyed by (section, module, number)."""
    found = {}
    for p in tdir.glob('explain1-p*-q*.json'):
        r = json.loads(p.read_text(encoding='utf8'))
        found.setdefault((r.get('section'), r.get('module'), r.get('number')), []).append(p)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tests', required=True)
    args = ap.parse_args()
    for test in (int(t) for t in args.tests.split(',') if t):
        rel = TESTS[test]['explain'][0]
        doc = pymupdf.open(DSAT_ROOT / rel)
        tdir = OUT / 'out' / 'dsat' / f't{test:02d}'
        tdir.mkdir(parents=True, exist_ok=True)
        before = existing_records(tdir)
        written, skipped = 0, []
        for q in questions(doc):
            if q['section'] != 'rw':
                continue
            rationale = '\n\n'.join(q['paras'])
            answer = ANSWER.search(q['paras'][0] if q['paras'] else '')
            if not answer or not q['module']:
                skipped.append(f"module {q['module']} q{q['number']} (p{q['page']}): no module header or no key sentence")
                continue
            name = f"explain1-p{q['page']:03d}-q{q['number']:02d}.json"
            for old in before.get(('rw', q['module'], q['number']), []):
                if old.name != name:
                    old.unlink()
            write_json(tdir / name, {
                'uid': f"dsat:t{test:02d}:explain1:p{q['page']:03d}:q{q['number']:02d}",
                'test': test, 'section': 'rw', 'module': q['module'], 'module_label': None,
                'number': q['number'], 'page': q['page'], 'answer': answer.group(1), 'accepted': [],
                'rationale': rationale, 'flags': [],
            })
            written += 1
        print(f't{test:02d}: {written} Reading and Writing explanations from the text layer')
        for s in skipped:
            print(f'  skipped {s}')


if __name__ == '__main__':
    main()
