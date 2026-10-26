"""Fetch the College Board question bank from the bank's own site.

The question bank (satsuitequestionbank.collegeboard.org) is a public page that
reads its questions from a JSON API. That API gives what the PDF export cannot:
the date the College Board added each question, its current difficulty, and the
question itself as HTML, with its math as MathML and its figures as SVG, exact
where the PDFs had to be transcribed.

What is fetched is kept as it came, under SRC next to the PDFs, and never
edited (build.py reads it):
  list.json         every SAT question in the bank: its id, skill, difficulty
                    and the dates it was added and last changed (createDate,
                    updateDate), with the time it was fetched
  lookup.json       the bank's lookup tables, including its "live" questions
  items/<id>.json   one question's content, as the API returned it

A question is fetched again only when the bank has changed it since (its
updateDate). The bank serves 459 questions of its first release (August 2023,
all in the PDF export) only as images of their math ("disclosed" items, with
an `ibn`); those have no content to fetch here and keep their transcription.

Usage: python3 cb_api.py               -> the list, the lookup and every question not yet fetched
       python3 cb_api.py --list-only   -> the list and the lookup
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from common import SRC, read_json, write_json

API = 'https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank'
API_DIR = SRC / 'College Board Question Bank API'
SAT = 99  # the bank's assessment id for the SAT (100 and 102 are the PSATs)
SECTIONS = {'rw': {'test': 1, 'domain': 'INI,CAS,EOI,SEC'}, 'math': {'test': 2, 'domain': 'H,P,Q,S'}}
HEADERS = {'Content-Type': 'application/json', 'User-Agent': 'insat-sat-extract/1.0'}
WORKERS = 4  # a few requests at a time: the whole bank in minutes, without leaning on the site


def call(path, body=None, attempts=5):
    """The API's JSON answer to a POST (with `body`) or a GET; retried with backoff."""
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(attempts):
        req = urllib.request.Request(f'{API}/{path}', data=data, headers=HEADERS, method='POST' if data else 'GET')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            if attempt == attempts - 1:
                raise RuntimeError(f'{path}: {err}') from err
            time.sleep(2 ** (attempt + 1))


def fetch_list():
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    questions = []
    for section, query in SECTIONS.items():
        rows = call('digital/get-questions', {'asmtEventId': SAT, **query})
        questions.extend({**q, 'section': section} for q in rows)
    write_json(API_DIR / 'list.json', {'fetched_at': now, 'questions': questions})
    write_json(API_DIR / 'lookup.json', call('lookup'))
    return questions


def fetch_item(q):
    item = call('digital/get-question', {'external_id': q['external_id']})
    if not isinstance(item, dict) or 'stem' not in item:
        raise RuntimeError(f"{q['questionId']}: unexpected answer {str(item)[:200]}")
    write_json(API_DIR / 'items' / f"{q['questionId']}.json", {
        'questionId': q['questionId'],
        'external_id': q['external_id'],
        'updateDate': q['updateDate'],
        'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'item': item,
    })


def stale(q):
    """Whether a question's content is missing or older than the bank's."""
    have = read_json(API_DIR / 'items' / f"{q['questionId']}.json")
    return not have or have.get('updateDate') != q['updateDate']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--list-only', action='store_true')
    args = ap.parse_args()
    questions = fetch_list()
    disclosed = [q for q in questions if not q.get('external_id')]
    print(f'{len(questions)} SAT questions in the bank ({len(disclosed)} disclosed, served as images)', file=sys.stderr)
    if args.list_only:
        return
    todo = [q for q in questions if q.get('external_id') and stale(q)]
    print(f'fetching {len(todo)} questions', file=sys.stderr)
    failed = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        jobs = {pool.submit(fetch_item, q): q for q in todo}
        for n, job in enumerate(as_completed(jobs), 1):
            try:
                job.result()
            except RuntimeError as err:
                failed.append(str(err))
            if n % 250 == 0:
                print(f'  {n}/{len(todo)}', file=sys.stderr)
    for f in failed:
        print(f'FAILED {f}', file=sys.stderr)
    print(f'done: {len(todo) - len(failed)} fetched, {len(failed)} failed', file=sys.stderr)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
