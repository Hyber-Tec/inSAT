"""Split the DSAT practice tests into page-range jobs for the vision pass.

Book and explanation files are cut into runs of pages sized by their image
cost, each with one context page on either side so a question straddling a
boundary is still read whole by the job that owns its number label. Answer
keys are small, so several tests share one job.

Usage: python3 jobs_dsat.py [--tests 1,2] [--budget 36000] [--max-pages 40]
        -> OUT/jobs/dsat-*.json
"""

import argparse
import re
from pathlib import Path

from common import OUT, read_json, write_json
from dsat_sources import TESTS

TOOLS = Path(__file__).resolve().parent

TAXONOMY = {
    'rw': {
        'info-ideas': ['Central Ideas and Details', 'Command of Evidence', 'Inferences'],
        'craft-structure': ['Words in Context', 'Text Structure and Purpose', 'Cross-Text Connections'],
        'expression': ['Rhetorical Synthesis', 'Transitions'],
        'conventions': ['Boundaries', 'Form, Structure, and Sense'],
    },
    'math': {
        'algebra': ['Linear equations in one variable', 'Linear functions', 'Linear equations in two variables',
                    'Systems of two linear equations in two variables', 'Linear inequalities in one or two variables'],
        'advanced-math': ['Nonlinear functions',
                          'Nonlinear equations in one variable and systems of equations in two variables',
                          'Equivalent expressions'],
        'problem-solving': ['Ratios, rates, proportional relationships, and units', 'Percentages',
                            'One-variable data - Distributions and measures of center and spread',
                            'Two-variable data - Models and scatterplots', 'Probability and conditional probability',
                            'Inference from sample statistics and margin of error',
                            'Evaluating statistical claims - Observational studies and experiments'],
        'geometry-trig': ['Area and volume', 'Lines, angles, and triangles', 'Right triangles and trigonometry',
                          'Circles'],
    },
}

BOOK_FIELDS = ['uid', 'test', 'section', 'module', 'module_label', 'number', 'page', 'passage', 'question',
               'answer_type', 'choices', 'answer', 'accepted', 'rationale', 'figure', 'domain', 'skill',
               'difficulty', 'solved_answer', 'check', 'flags']
EXPLAIN_FIELDS = ['uid', 'test', 'section', 'module', 'module_label', 'number', 'page', 'answer', 'accepted',
                  'rationale', 'flags']

TITLE = re.compile(r'(reading and writing|reading|math)\W{0,40}module\s*([12])|module\s*([12])\W{0,40}(reading and writing|reading|math)',
                   re.I)


def ocr_text(im):
    p = Path(im['path'])
    f = OUT / 'dsat' / 'ocr' / f'{p.parent.name}-{p.stem}.txt'
    return f.read_text(encoding='utf8') if f.exists() else ''


def module_titles(pages):
    """page number -> 'Reading and Writing Module 2' for pages that look like a
    module title (short page, heading text). A hint for readers, nothing more."""
    out = {}
    for pno, ims in pages:
        text = ' '.join(ocr_text(im) for im in ims)
        flat = ' '.join(text.split())
        if len(flat) > 900:
            continue
        m = TITLE.search(flat)
        if m:
            sec = (m.group(1) or m.group(4)).lower()
            mod = m.group(2) or m.group(3)
            out[pno] = f"{'Math' if sec == 'math' else 'Reading and Writing'} Module {mod}"
    return out


def chunks(pages, budget, max_pages):
    cur, cost = [], 0
    for pno, ims in pages:
        c = sum(im['width'] * im['height'] for im in ims) / 750
        if cur and (cost + c > budget or len(cur) >= max_pages):
            yield cur
            cur, cost = [], 0
        cur.append((pno, ims))
        cost += c
    if cur:
        yield cur


def image_entries(ims, pno, context=False):
    return [{'name': Path(im['path']).name, 'path': im['path'], 'width': im['width'], 'height': im['height'],
             'page': pno, **({'context': True} if context else {})} for im in ims]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tests', default='')
    ap.add_argument('--budget', type=int, default=36000)
    ap.add_argument('--max-pages', type=int, default=40)
    args = ap.parse_args()
    only = {int(t) for t in args.tests.split(',') if t}
    render = read_json(OUT / 'dsat' / 'render.json')
    made = []

    for test, spec in TESTS.items():
        if (only and test not in only) or spec.get('duplicate_of'):
            continue
        for mode in ('book', 'explain'):
            for n, rel in enumerate(spec.get(mode, []), 1):
                name = f'{mode}{n}'
                keys = sorted(k for k in render if k.startswith(f't{test:02d}/{name}/'))
                pages = [(int(k.rsplit('/p', 1)[1]), render[k]) for k in keys if render[k]]
                titles = module_titles(pages) if mode == 'book' else {}
                parts = list(chunks(pages, args.budget, args.max_pages))
                for j, part in enumerate(parts, 1):
                    first, last = part[0][0], part[-1][0]
                    idx = [p for p, _ in pages]
                    before = pages[idx.index(first) - 1] if idx.index(first) > 0 else None
                    after = pages[idx.index(last) + 1] if idx.index(last) + 1 < len(pages) else None
                    images = []
                    if before:
                        images += image_entries(before[1], before[0], context=True)
                    for pno, ims in part:
                        images += image_entries(ims, pno)
                    if after:
                        images += image_entries(after[1], after[0], context=True)
                    known = [t for p, t in titles.items() if p <= first]
                    start = ('start of the book' if j == 1 else
                             (f'{known[-1]} (last module title seen before page {first})' if known else None))
                    job = f't{test:02d}-{name}-{j:02d}'
                    manifest = {
                        'job': f'dsat-{job}',
                        'spec': str(TOOLS / 'SPEC.md'),
                        'zoom': f"python3 {TOOLS / 'zoom.py'}",
                        'collection': 'dsat',
                        'mode': mode,
                        'test': test,
                        mode: name,
                        'source_file': rel,
                        'test_format': spec.get('format'),
                        'test_note': spec.get('note', ''),
                        'pages': f'{first}-{last}',
                        'start_context': start,
                        'module_titles_seen_by_ocr': {str(k): v for k, v in sorted(titles.items())} or None,
                        'fields': BOOK_FIELDS if mode == 'book' else EXPLAIN_FIELDS,
                        'taxonomy': TAXONOMY if mode == 'book' else None,
                        'out_dir': str(OUT / 'out' / 'dsat' / f't{test:02d}'),
                        'images': images,
                    }
                    write_json(OUT / 'jobs' / f'dsat-{job}.json', manifest)
                    made.append(job)

    # Answer keys: a handful of tests per job, one output file per test.
    keys = []
    for test, spec in TESTS.items():
        if (only and test not in only) or spec.get('duplicate_of') or not spec.get('key'):
            continue
        images = []
        for n in range(1, len(spec['key']) + 1):
            for k in sorted(k for k in render if k.startswith(f't{test:02d}/key{n}/')):
                images += image_entries(render[k], int(k.rsplit('/p', 1)[1]))
        keys.append({'test': test, 'test_format': spec.get('format'), 'files': spec['key'],
                     'out': str(OUT / 'out' / 'dsat' / 'keys' / f't{test:02d}.json'), 'images': images})
    # Cutting jobs for a few tests adds key jobs after the existing ones instead
    # of renumbering over them (a finished job's manifest is its record).
    existing = [int(p.stem.rsplit('-', 1)[1]) for p in (OUT / 'jobs').glob('dsat-keys-*.json')]
    group, cost, j = [], 0, max(existing, default=0) if only else 0
    for k in keys + [None]:
        c = sum(im['width'] * im['height'] for im in k['images']) / 750 if k else 0
        if group and (k is None or cost + c > args.budget):
            j += 1
            write_json(OUT / 'jobs' / f'dsat-keys-{j:02d}.json', {
                'job': f'dsat-keys-{j:02d}', 'spec': str(TOOLS / 'SPEC.md'), 'zoom': f"python3 {TOOLS / 'zoom.py'}",
                'collection': 'dsat', 'mode': 'key',
                'note': 'For each entry in `keys`, read its images and write that test\'s key to its `out` path.',
                'keys': group})
            made.append(f'keys-{j:02d}')
            group, cost = [], 0
        if k:
            group.append(k)
            cost += c
    print(f'{len(made)} jobs:', ', '.join(made))


if __name__ == '__main__':
    main()
