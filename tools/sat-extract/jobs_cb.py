"""Split the College Board questions that need the vision pass into job manifests.

A job is a run of consecutive questions from the same skill file, small enough
that one reader keeps every image of the job in view without its context
growing past the point where early pages get summarized away.

Usage: python3 jobs_cb.py [--section math] [--size 30] [--only id1,id2] [--name pilot]
        -> OUT/jobs/cb-<section>-NNN.json
"""

import argparse
from pathlib import Path

from common import OUT, read_json, write_json

TOOLS = Path(__file__).resolve().parent
FIELDS = ['uid', 'passage', 'question', 'answer_type', 'choices', 'answer', 'accepted',
          'rationale', 'figure', 'check', 'flags']

NOTES = """College Board question bank export. Each question begins at its dark "ID: <id>" banner
and ends after the "Question Difficulty" line. Everything between the "ID: <id>" banner and the
"ID: <id> Answer" banner is the question the student sees; the answer banner is followed by
"Correct Answer:" (sometimes missing, then the answer is stated in the rationale), "Rationale",
and the difficulty. Math here is typeset (sometimes as small images); read it from the picture,
never guess. The difficulty bar and header table are not in the images and not needed."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--section', default='math')
    ap.add_argument('--size', type=int, default=30)
    ap.add_argument('--only', default='')
    ap.add_argument('--name', default='')
    ap.add_argument('--mode', default='full', choices=['full', 'figure'])
    args = ap.parse_args()
    figure_only = args.mode == 'figure'

    index = read_json(OUT / 'cb' / 'index.json')
    render = read_json(OUT / 'cb' / 'render.json')
    only = set(filter(None, args.only.split(',')))
    out_dir = OUT / 'out' / ('cb-fig' if figure_only else 'cb')
    done = {p.stem for p in out_dir.glob('*.json')}
    todo = [q for q in index if q['section'] == args.section and (not only or q['id'] in only)
            and q['id'] not in done]

    jobs = []
    current = []
    last_file = None
    for q in todo:
        if current and (len(current) >= args.size or (q['file'] != last_file and len(current) >= args.size * 0.6)):
            jobs.append(current)
            current = []
        current.append(q)
        last_file = q['file']
    if current:
        jobs.append(current)

    for n, qs in enumerate(jobs, 1):
        name = f"cb-{args.section}-{'fig-' if figure_only else ''}{args.name or ''}{n:03d}"
        manifest = {
            'job': name,
            'spec': str(TOOLS / 'SPEC.md'),
            'zoom': f"python3 {TOOLS / 'zoom.py'}",
            'collection': 'cb-bank',
            'section': args.section,
            'mode': args.mode,
            'fields': ['uid', 'figure', 'flags'] if figure_only else FIELDS,
            'notes': NOTES,
            'questions': [{
                'uid': f"cb:{q['id']}",
                'out': str(out_dir / f"{q['id']}.json"),
                'skill': q['skill'],
                'text_layer_answer': q['correct_answer_text'],
                'images': [{'name': Path(im['path']).name, 'path': im['path'],
                            'width': im['width'], 'height': im['height']} for im in render[q['id']]],
            } for q in qs],
        }
        write_json(OUT / 'jobs' / f'{name}.json', manifest)
    print(f'{len(todo)} questions -> {len(jobs)} jobs '
          f'(sizes {min(map(len, jobs))}-{max(map(len, jobs))})')


if __name__ == '__main__':
    main()
