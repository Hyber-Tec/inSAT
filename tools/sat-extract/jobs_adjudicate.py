"""Cut adjudication jobs for DSAT questions whose key disagrees with the
transcriber's own solution (see "Adjudication jobs" in SPEC.md).

Usage: python3 jobs_adjudicate.py [--size 15]   -> OUT/jobs/adjudicate-NNN.json
"""

import argparse
from pathlib import Path

from common import OUT, read_json, read_jsonl, write_json

TOOLS = Path(__file__).resolve().parent
FIELDS = ['passage', 'question', 'answer_type', 'choices', 'figures']


def safe(uid):
    return uid.replace(':', '_')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=15)
    args = ap.parse_args()
    rows = read_jsonl(OUT / 'dataset' / 'dsat.jsonl')
    render = read_json(OUT / 'dsat' / 'render.json')
    out_dir = OUT / 'out' / 'adjudicate'
    todo = [r for r in rows if r['check'].get('status') == 'disagree' and not (out_dir / f"{safe(r['uid'])}.json").exists()]

    def images(r):
        book = r['source']['record'].split(':')[2]
        page = int(r['source']['page'] or 0)
        out = []
        for p in (page - 1, page):
            for im in render.get(f"t{r['test']:02d}/{book}/p{p:03d}", []):
                out.append({'name': Path(im['path']).name, 'path': im['path'], 'width': im['width'],
                            'height': im['height'], 'page': p})
        return out

    def explanation(r):
        return r.get('rationale') or ''

    jobs = [todo[i:i + args.size] for i in range(0, len(todo), args.size)]
    for n, part in enumerate(jobs, 1):
        write_json(OUT / 'jobs' / f'adjudicate-{n:03d}.json', {
            'job': f'adjudicate-{n:03d}',
            'spec': str(TOOLS / 'SPEC.md'),
            'zoom': f"python3 {TOOLS / 'zoom.py'}",
            'collection': 'dsat',
            'mode': 'adjudicate',
            'questions': [{
                'uid': r['uid'],
                'out': str(out_dir / f"{safe(r['uid'])}.json"),
                'record': {k: r.get(k) for k in FIELDS},
                'key': r['check'].get('key'),
                'solved': r['check'].get('solved'),
                'flags': r.get('flags'),
                'explanation': explanation(r),
                'images': images(r),
            } for r in part],
        })
    print(f'{len(todo)} disagreements -> {len(jobs)} adjudication jobs')


if __name__ == '__main__':
    main()
