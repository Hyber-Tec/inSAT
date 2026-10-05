"""Decode a ClassMarker question export into one JSON record per question.

The export is plain text: each record starts at "(Type):" and each field is
"(Name): value", running until the next field tag. Its markup becomes the
bank's conventions: [u] stays an underline (<u>), [sup] and [sub] become
^{...} and _{...}, a list becomes bullet lines, a table one line per row with
" | " between cells, [sqr] and [pi] the symbols. An image stays a named
placeholder, [image <path>]; the export does not carry the files.

Each record is flagged so an import can leave out what it must not serve:
  needs-image         a question or a choice shows an image (the import
                      transcribes it; --fetch-images downloads the files)
  explanation-image   only the academy's explanation shows one (harmless: the
                      import writes new explanations)
  college-board-text  three or more rare 10-word runs match the College Board
                      bank or a DSAT test
  mentions-cracksat   copied from CrackSAT (it names the site)
  duplicate-of:cm:N   the same question and choices as an earlier record

Usage: python3 classmarker.py <export.txt> [--out DIR] [--fetch-images]
  -> DIR/questions.jsonl (default OUT/classmarker); ids are cm:<record number>,
     stable for one export. server/scripts/import-classmarker.js imports it.
  --fetch-images downloads the images of every record an import could use into
     DIR/images/. The export names them ([image 0/<file>]) but does not carry
     them; ClassMarker serves each at https://0cm.classmarker.com/<file>.
     Files already there are kept, so a rerun only fetches what is missing.
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import OUT

TAG = re.compile(r'^\((Type|Category|Random answers|Question|[A-J]|Correct|Points|WF|WFC|WFI|Correct feedback|'
                 r'Incorrect feedback|Answer|Answers|Grade|Case sensitive|Explanation)\):\s?(.*)$')
IMAGE = re.compile(r'\[cmimg\](.*?)\[/cmimg\]|\[img\](.*?)\[/img\]', re.S)
BULLET = '\u2022 '
PLACEHOLDER = re.compile(r'\[image ([^\]]+)\]')
CDN = 'https://0cm.classmarker.com/'


def parse(path):
    """The export's records as {field: text}."""
    recs, cur, field = [], None, None
    for line in Path(path).read_text(encoding='utf8').replace('\r\n', '\n').split('\n'):
        m = TAG.match(line)
        if m:
            name, val = m.groups()
            if name == 'Type':
                if cur:
                    recs.append(cur)
                cur = {}
            if cur is None:
                continue
            field = name
            cur[field] = val
        elif cur is not None and field:
            cur[field] += '\n' + line
    if cur:
        recs.append(cur)
    return [{k: v.strip() for k, v in r.items()} for r in recs]


def cell(t):
    return re.sub(r'\s+', ' ', t).strip()


def table(body):
    rows = [[cell(c) for c in re.findall(r'\[td\](.*?)\[/td\]', row, re.S)] for row in re.findall(r'\[tr\](.*?)\[/tr\]', body, re.S)]
    return '\n' + '\n'.join(' | '.join(r) for r in rows) + '\n'


def sqrt(m):
    x = m.group(1).strip()
    return f'\u221a{x}' if re.fullmatch(r'\w+', x) else f'\u221a({x})'


def tidy(t):
    """ClassMarker markup as the plain text the bank renders."""
    t = (t or '').replace('\r', '').replace('\u00a0', ' ')
    t = re.sub(r'\[u\](.*?)\[/u\]', r'<u>\1</u>', t, flags=re.S)
    t = re.sub(r'\[sup\](.*?)\[/sup\]', r'^{\1}', t, flags=re.S)
    t = re.sub(r'\[sub\](.*?)\[/sub\]', r'_{\1}', t, flags=re.S)
    t = IMAGE.sub(lambda m: f'[image {m.group(1) or m.group(2)}]', t)
    t = re.sub(r'\[table\](.*?)\[/table\]', lambda m: table(m.group(1)), t, flags=re.S)
    t = re.sub(r'\[li\](.*?)\[/li\]', lambda m: '\n' + BULLET + cell(m.group(1)), t, flags=re.S)
    t = re.sub(r'\[/?(?:ul|ol)\]', '\n', t)
    t = re.sub(r'\[sqr\](.*?)\[/sqr\]', sqrt, t, flags=re.S)
    t = t.replace('[pi]', '\u03c0').replace('[x]', 'x')
    t = re.sub(r'\[/?(i|b|em|strong|br|center|left|right|color[^\]]*|size[^\]]*|font[^\]]*)\]', '', t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r' ?\n ?', '\n', t)
    return re.sub(r'\n{3,}', '\n\n', t).strip()


def words(t):
    return re.sub(r'[^a-z0-9 ]', ' ', re.sub(r'\[[^\]]*\]', ' ', t or '').lower()).split()


def shingles(t, k=10):
    w = words(t)
    return {' '.join(w[i:i + k]) for i in range(0, max(0, len(w) - k + 1))}


def fetch(name, folder):
    """Download one image unless it is already there. Returns an error or None.
    The CDN refuses urllib's default user agent, so the request names itself."""
    target = folder / name
    if target.exists() and target.stat().st_size:
        return None
    request = urllib.request.Request(CDN + name, headers={'User-Agent': 'satify-classmarker-import/1.0'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as res:
                data = res.read()
            tmp = target.with_suffix(target.suffix + '.part')
            tmp.write_bytes(data)
            tmp.replace(target)
            return None
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503, 504) or attempt == 2:
                return f'{name}: HTTP {err.code}'
        except Exception as err:  # noqa: BLE001 - a network error, reported per file
            if attempt == 2:
                return f'{name}: {err}'
        time.sleep(2 ** attempt)


def fetch_images(records, folder):
    """Every image a usable record shows, fetched a few at a time."""
    folder.mkdir(exist_ok=True)
    names = sorted({Path(ref).name for r in records if r['flags'] == ['needs-image']
                    for text in [r['question'], *r['choices']] for ref in PLACEHOLDER.findall(text)})
    with ThreadPoolExecutor(max_workers=6) as pool:
        errors = [e for e in pool.map(lambda n: fetch(n, folder), names) if e]
    print(f'images: {len(names) - len(errors)} of {len(names)} in {folder}')
    for e in errors[:10]:
        print('  failed', e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('export', help='the ClassMarker export (.txt)')
    ap.add_argument('--out', default=str(OUT / 'classmarker'))
    ap.add_argument('--fetch-images', action='store_true', help='download the images usable records show')
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    recs = parse(args.export)
    reference = set()
    for coll in ('cb', 'dsat'):
        for line in (OUT / 'dataset' / f'{coll}.jsonl').read_text(encoding='utf8').splitlines():
            r = json.loads(line)
            reference |= shingles((r.get('passage') or '') + ' ' + (r.get('question') or ''))
    runs = [shingles(r.get('Question', '')) for r in recs]
    freq = Counter(sh for s in runs for sh in s)

    seen, flags, records = {}, Counter(), []
    with open(out / 'questions.jsonl', 'w', encoding='utf8') as f:
        for i, (r, s) in enumerate(zip(recs, runs)):
            raw = json.dumps(r)
            shown = json.dumps({k: v for k, v in r.items() if k not in ('WF', 'WFC', 'WFI', 'Correct feedback', 'Incorrect feedback', 'Explanation')})
            kind = r.get('Type', '').split('\n')[0]
            letters = [L for L in 'ABCDEFGHIJ' if r.get(L)]
            # Two questions with the same words and different figures are different questions.
            key = (' '.join(words(r.get('Question', '')))[:500] + '|' + '|'.join(' '.join(words(r.get(L, ''))) for L in 'ABCD')
                   + '|' + ' '.join(a or b for a, b in IMAGE.findall(shown)))
            rec = {
                'id': f'cm:{i}',
                'category': r.get('Category'),
                'type': kind,
                'question': tidy(r.get('Question')),
                'choices': [tidy(r.get(L)) for L in letters] if kind.startswith(('multiplechoice', 'truefalse')) else [],
                'answer': r.get('Correct') or None,
                'accepted': [tidy(r.get(L)) for L in letters] if kind == 'freetext' else [],
                'explanation': tidy(r.get('WF')) or None,
                'flags': [x for x, on in [
                    ('needs-image', bool(IMAGE.search(shown))),
                    ('explanation-image', bool(IMAGE.search(raw)) and not IMAGE.search(shown)),
                    # A 10-word run shared by more than 25 records is boilerplate, not a copy.
                    ('college-board-text', sum(1 for sh in s if sh in reference and freq[sh] <= 25) >= 3),
                    ('mentions-cracksat', 'cracksat' in raw.lower()),
                    ('duplicate-of:' + seen.get(key, ''), key in seen),
                ] if on],
            }
            seen.setdefault(key, rec['id'])
            flags.update(x.split(':')[0] for x in rec['flags'])
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            records.append(rec)
    print(f'{len(recs)} records -> {out / "questions.jsonl"}')
    print('flags:', ', '.join(f'{k} {n}' for k, n in flags.most_common()))
    if args.fetch_images:
        fetch_images(records, out / 'images')


if __name__ == '__main__':
    main()
