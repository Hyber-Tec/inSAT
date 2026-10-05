"""Cut original-question jobs: new questions in the College Board's style, to be
shown to students (see "Original-question jobs" in SPEC.md).

Each job names the skills to write for, how many at each difficulty, and gives
a few of the bank's own questions for the skill as models, spread across
difficulties. The writer's output is one JSON-lines file per job, which
jobs_verify_originals.py then sends for a blind solve.

Usage: python3 jobs_originals.py --name rw-001 --section rw [--skill Transitions --skill "Form, Structure, and Sense"]
           [--easy 2 --medium 2 --hard 1] [--models 4]
       -> OUT/jobs/originals-<name>.json, writer output OUT/out/original/<name>.jsonl
"""

import argparse
import json
import random
from pathlib import Path

from common import OUT, read_jsonl, write_json

TOOLS = Path(__file__).resolve().parent
MODEL_FIELDS = ('difficulty', 'passage', 'question', 'choices', 'answer', 'rationale')


def bank_by_skill(section):
    """The bank's questions of one section that can serve as models, by (domain, skill)."""
    out = {}
    for r in read_jsonl(OUT / 'dataset' / 'cb.jsonl'):
        if r.get('section') != section or not r.get('rationale') or r.get('figures'):
            continue
        if r.get('answer_type') != 'multiple-choice' or not r.get('skill'):
            continue
        out.setdefault((r['domain'], r['skill']), []).append(r)
    return out


def topics_written(section):
    """Opening words of every original passage already written, by (domain,
    skill), so a new batch is told what to steer clear of. Unverified batches
    count too, including one still being written (a half-written line is
    skipped)."""
    out = {}
    for path in sorted((OUT / 'out' / 'original').glob('*.jsonl')):
        if '.verify-' in path.name or '.blind-' in path.name:
            continue
        for line in path.read_text(encoding='utf8').splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('section') != section or not r.get('passage'):
                continue
            lines = [ln for ln in r['passage'].split('\n') if ln.strip() and not ln.startswith(('Text 1', 'Text 2', 'While researching'))]
            if not lines:
                continue
            words = lines[0].lstrip('• ').split()
            out.setdefault((r.get('domain'), r.get('skill')), []).append(' '.join(words[:10]))
    return out


def spread(rows, n, rng):
    """n models with as many difficulties represented as the rows allow."""
    by_difficulty = {}
    for r in rows:
        by_difficulty.setdefault(r.get('difficulty'), []).append(r)
    for bucket in by_difficulty.values():
        rng.shuffle(bucket)
    picked = []
    while len(picked) < n and any(by_difficulty.values()):
        for d in ('easy', 'medium', 'hard'):
            if by_difficulty.get(d) and len(picked) < n:
                picked.append(by_difficulty[d].pop())
    rng.shuffle(picked)
    return [{k: m.get(k) for k in MODEL_FIELDS} for m in picked]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True, help='job name, e.g. rw-001')
    ap.add_argument('--section', choices=['rw', 'math'], default='rw')
    ap.add_argument('--skill', action='append', default=[],
                    help='a skill name, repeatable (names contain commas); default every skill of the section')
    ap.add_argument('--easy', type=int, default=1)
    ap.add_argument('--medium', type=int, default=1)
    ap.add_argument('--hard', type=int, default=0)
    ap.add_argument('--models', type=int, default=4)
    ap.add_argument('--seed', type=int, default=11)
    args = ap.parse_args()

    bank = bank_by_skill(args.section)
    wanted = [s.strip() for s in args.skill if s.strip()]
    keys = sorted(bank) if not wanted else [k for k in sorted(bank) if k[1] in wanted]
    missing = set(wanted) - {k[1] for k in keys}
    if missing:
        raise SystemExit(f'no bank questions for: {", ".join(sorted(missing))}')
    write = {d: n for d, n in (('easy', args.easy), ('medium', args.medium), ('hard', args.hard)) if n > 0}
    if not write:
        raise SystemExit('nothing to write: give --easy, --medium or --hard')

    rng = random.Random(args.seed)
    written = topics_written(args.section)
    targets = [{'domain': domain, 'skill': skill, 'write': dict(write), 'models': spread(bank[(domain, skill)], args.models, rng),
                # The whole domain: a student practicing Information and Ideas
                # should not meet the same experiment under two of its skills.
                'avoid_topics': [t for (d, _), ts in sorted(written.items()) if d == domain for t in ts]}
               for domain, skill in keys]
    job = f'originals-{args.name}'
    write_json(OUT / 'jobs' / f'{job}.json', {
        'job': job,
        'spec': str(TOOLS / 'SPEC.md'),
        'collection': 'original',
        'mode': 'write-originals',
        'section': args.section,
        'out': str(OUT / 'out' / 'original' / f'{args.name}.jsonl'),
        'targets': targets,
    })
    total = sum(write.values()) * len(targets)
    print(f'{job}: {len(targets)} skills, {total} questions to write -> jobs/{job}.json')


if __name__ == '__main__':
    main()
