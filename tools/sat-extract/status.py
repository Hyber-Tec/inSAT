"""Progress of the vision pass: per job, how many of its records exist.

Usage: python3 status.py [prefix]      e.g. python3 status.py cb-math
"""

import json
import sys
from pathlib import Path

from common import OUT


def job_state(j):
    # Jobs that name one output file per question: the bank, and adjudication.
    if j.get('collection') == 'cb-bank' or j.get('mode') == 'adjudicate':
        want = [q['out'] for q in j['questions']]
        have = sum(1 for o in want if Path(o).exists())
        return have, len(want)
    if j.get('mode') == 'key':
        want = [k['out'] for k in j['keys']]
        return sum(1 for o in want if Path(o).exists()), len(want)
    # page jobs: records named <book|explain>-p<page>-q<n>.json for the job's own pages
    name = j.get('book') or j.get('explain')
    own = {im['page'] for im in j['images'] if not im.get('context')}
    out = Path(j['out_dir'])
    have = [p for p in out.glob(f'{name}-p*-q*.json') if int(p.stem.split('-p')[1].split('-')[0]) in own]
    return len(have), None


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else ''
    done = partial = todo = 0
    lines = []
    for p in sorted((OUT / 'jobs').glob(f'{prefix}*.json')):
        j = json.loads(p.read_text())
        have, want = job_state(j)
        if want is None:
            state = 'started' if have else 'todo'
        else:
            state = 'done' if have >= want else ('partial' if have else 'todo')
        done += state == 'done'
        partial += state in ('partial', 'started')
        todo += state == 'todo'
        lines.append(f"{p.stem:28s} {state:8s} {have}{'' if want is None else '/' + str(want)}")
    print('\n'.join(lines))
    print(f'\n{done} done, {partial} partial/started, {todo} not started')


if __name__ == '__main__':
    main()
