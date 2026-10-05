"""Cut explanation-writing jobs for practice-test questions whose source printed
no explanation (see "Explanation-writing jobs" in SPEC.md).

Each job carries the finished records, the figure image path where there is
one, and a few of the College Board bank's own explanations for the same skill
as the style to write in.

Usage: python3 jobs_write_explanations.py [--size 15]   -> OUT/jobs/write-explanations-NNN.json
"""

import argparse
import random
import re
from pathlib import Path

from common import OUT, read_jsonl, write_json

TOOLS = Path(__file__).resolve().parent
FIELDS = ['uid', 'section', 'domain', 'skill', 'difficulty', 'passage', 'question', 'answer_type',
          'choices', 'answer', 'accepted', 'figures']


def importable(r):
    flags = r.get('flags') or []
    if not r.get('answer') or any(f.startswith(('ambiguous', 'key-disagrees')) for f in flags):
        return False
    if r['answer_type'] != 'grid-in':
        choices = r.get('choices') or []
        if len(choices) != 4 or len({str(c).strip() for c in choices}) != 4:
            return False
    return bool((r.get('question') or '').strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=15)
    args = ap.parse_args()
    rows = read_jsonl(OUT / 'dataset' / 'dsat.jsonl')
    bank = [r for r in read_jsonl(OUT / 'dataset' / 'cb.jsonl') if r.get('rationale') and not r.get('figures')]
    by_skill = {}
    for r in bank:
        by_skill.setdefault((r['section'], r['skill']), []).append(r)
    out_dir = OUT / 'out' / 'dsat' / 'written'
    # One copy of a question printed in several tests: the build hands the
    # explanation to the others.
    identity = lambda r: re.sub(r'[^a-z0-9]', '', f"{r.get('passage') or ''}|{r.get('question')}|{'|'.join(r.get('choices') or [])}".lower())
    seen, todo = set(), []
    for r in rows:
        if not importable(r) or r.get('rationale') or (out_dir / f"{r['uid'].replace(':', '_')}.json").exists():
            continue
        if identity(r) in seen:
            continue
        seen.add(identity(r))
        todo.append(r)
    rng = random.Random(7)

    def models(section, skill):
        pool = by_skill.get((section, skill)) or [r for r in bank if r['section'] == section]
        return [{k: m.get(k) for k in ('passage', 'question', 'choices', 'answer', 'rationale')}
                for m in rng.sample(pool, min(3, len(pool)))]

    jobs = [todo[i:i + args.size] for i in range(0, len(todo), args.size)]
    for n, part in enumerate(jobs, 1):
        write_json(OUT / 'jobs' / f'write-explanations-{n:03d}.json', {
            'job': f'write-explanations-{n:03d}',
            'spec': str(TOOLS / 'SPEC.md'),
            'collection': 'dsat',
            'mode': 'write-explanations',
            'questions': [{
                'record': {k: r.get(k) for k in FIELDS},
                'figure_image': str(OUT / 'dataset' / r['figure_asset']) if r.get('figure_asset') else None,
                'models': models(r['section'], r['skill']),
                'out': str(out_dir / f"{r['uid'].replace(':', '_')}.json"),
            } for r in part],
        })
    print(f'{len(todo)} questions without an explanation -> {len(jobs)} jobs')


if __name__ == '__main__':
    main()
