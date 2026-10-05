"""Cut blind-verification jobs for original questions (see "Verification jobs"
in SPEC.md).

A verifier gets each question with its key and explanation removed and solves
it cold. build.py keeps an original question only when the blind answer
matches the writer's, so a question with a debatable key never reaches a
student.

Usage: python3 jobs_verify_originals.py --name rw-pilot-001 [--size 20] [--staged]
       -> OUT/jobs/verify-originals-<name>-NN.json, verifier output OUT/out/original/<name>.verify-NN.jsonl
          (with --staged, <name>.blind-NN.jsonl, promoted to .verify-NN once an editor has applied
          any fixes the verifier's notes call for; the build reads only .verify-NN)
"""

import argparse
from pathlib import Path

from common import OUT, read_jsonl, write_json

TOOLS = Path(__file__).resolve().parent
SHOWN = ('section', 'domain', 'skill', 'passage', 'question', 'choices')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True, help='the writer job name, e.g. rw-pilot-001')
    ap.add_argument('--size', type=int, default=20, help='questions per verification job')
    ap.add_argument('--staged', action='store_true', help='write blind answers to <name>.blind-NN.jsonl for an editor to promote')
    args = ap.parse_args()

    source = OUT / 'out' / 'original' / f'{args.name}.jsonl'
    rows = read_jsonl(source)
    if not rows:
        raise SystemExit(f'nothing to verify: {source} is missing or empty')
    questions = [{'index': i, **{k: r.get(k) for k in SHOWN}} for i, r in enumerate(rows)]
    parts = [questions[i:i + args.size] for i in range(0, len(questions), args.size)]
    for n, part in enumerate(parts, 1):
        job = f'verify-originals-{args.name}-{n:02d}'
        write_json(OUT / 'jobs' / f'{job}.json', {
            'job': job,
            'spec': str(TOOLS / 'SPEC.md'),
            'collection': 'original',
            'mode': 'verify-originals',
            'source': str(source),
            'out': str(OUT / 'out' / 'original' / f'{args.name}.{"blind" if args.staged else "verify"}-{n:02d}.jsonl'),
            'questions': part,
        })
    print(f'{len(rows)} questions in {source.name} -> {len(parts)} verification job(s)')


if __name__ == '__main__':
    main()
