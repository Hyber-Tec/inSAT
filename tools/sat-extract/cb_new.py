"""What the College Board's bank has added since the PDF export, and which of it
was already in hand.

Every question of the bank's dataset (build.py cb) that the PDF export did not
hold is looked for among everything else there is: the bank's other questions,
the practice tests, the original questions and the academy's ClassMarker
pool. A question is the same as another when nearly every word of what
identifies it (a Reading and Writing passage; a math stem and its choices) is
in the other and the two share most of their words; it is close when most of
its words are. The report also lists what the bank re-rated and withdrew.

Usage: python3 cb_new.py   -> OUT/reports/cb-new.md, OUT/reports/cb-new.json
"""

import re
import sys
from collections import Counter, defaultdict

from common import OUT, read_json, read_jsonl, write_json

SAME = (0.9, 0.6)   # containment, Jaccard
CLOSE = 0.7         # containment
RARE = 40           # a word in at most this many questions finds candidates


def words(text):
    text = re.sub(r'\\[()\[\]]', ' ', str(text or '').lower())
    text = re.sub(r'\\[a-z]+', ' ', text)
    return set(re.sub(r'[^a-z0-9]+', ' ', text).split())


def identity(q):
    if q.get('section') == 'rw' and q.get('passage'):
        return words(q['passage'])
    return words(' '.join([q.get('question') or '', *(q.get('choices') or [])]))


def main():
    bank = read_jsonl(OUT / 'dataset' / 'cb.jsonl')
    export = {q['id']: q for q in read_json(OUT / 'cb' / 'index.json', [])}
    if not bank:
        sys.exit('No bank dataset: run build.py cb first')
    added = [q for q in bank if q['source_id'] not in export]

    others = []  # (where, id, words)
    for q in bank:
        if q['source_id'] in export:
            others.append(('the bank (in the PDF export)', q['source_id'], identity(q)))
    for q in read_jsonl(OUT / 'dataset' / 'dsat.jsonl'):
        others.append((f"practice test {q['test']}", q['uid'], identity(q)))
    for q in read_jsonl(OUT / 'dataset' / 'original.jsonl'):
        others.append(('original questions', q['uid'], identity(q)))
    for q in read_jsonl(OUT / 'classmarker' / 'questions.jsonl'):
        others.append(('the ClassMarker pool', q['id'], words(' '.join([q.get('question') or '', *(q.get('choices') or [])]))))
    df = Counter(w for _, _, ws in others for w in ws)
    index = defaultdict(list)
    for i, (_, _, ws) in enumerate(others):
        for w in ws:
            if df[w] <= RARE:
                index[w].append(i)

    found = {}
    for q in added:
        mine = identity(q)
        hits = Counter(i for w in mine if df[w] <= RARE for i in index[w])
        best = []
        for i, _ in sorted(hits.items(), key=lambda kv: (-kv[1], kv[0]))[:30]:  # ties in a fixed order
            where, oid, theirs = others[i]
            both = len(mine & theirs)
            if mine and theirs:
                best.append({'containment': round(both / len(mine), 2), 'jaccard': round(both / len(mine | theirs), 2),
                             'in': where, 'id': oid})
        best.sort(key=lambda b: (b['containment'], b['jaccard']), reverse=True)
        top = best[0] if best else None
        status = 'new'
        if top and top['containment'] >= SAME[0] and top['jaccard'] >= SAME[1]:
            status = 'same'
        elif top and top['containment'] >= CLOSE:
            status = 'close'
        found[q['source_id']] = {'status': status, 'match': top if status != 'new' else None,
                                 'section': q['section'], 'skill': q['skill'], 'difficulty': q['difficulty'],
                                 'published_on': q['published_on']}

    rerated = Counter()
    for q in bank:
        old = export.get(q['source_id'])
        was = old and (old.get('pdf_difficulty') or old.get('folder_difficulty'))
        if was and was != q['difficulty']:
            rerated[(was, q['difficulty'])] += 1
    withdrawn = sorted(set(export) - {q['source_id'] for q in bank})

    write_json(OUT / 'reports' / 'cb-new.json', {'added': found, 'rerated': {f'{a}->{b}': n for (a, b), n in rerated.items()},
                                                 'withdrawn': withdrawn})
    status = Counter(f['status'] for f in found.values())
    where = Counter('the practice tests' if f['match']['in'].startswith('practice') else f['match']['in']
                    for f in found.values() if f['status'] == 'same')
    lines = [
        "# What the College Board's bank added",
        '',
        f"{len(added)} questions are in the bank that the PDF export did not hold "
        f"(published {', '.join(f'{m}: {n}' for m, n in sorted(Counter(f['published_on'][:7] for f in found.values()).items()))}).",
        '',
        f"- **Already in hand** ({status['same']}): the same question is in "
        + ', '.join(f'{w} ({n})' for w, n in where.most_common()) + '.',
        f"- **Close** ({status['close']}): most of its words are in a question we have (the same passage asked about "
        'differently, or the same problem with other numbers).',
        f"- **New** ({status['new']}).",
        '',
        f"The bank also rates {sum(rerated.values())} questions of the export at a new difficulty "
        f"({', '.join(f'{a} to {b} {n}' for (a, b), n in rerated.most_common())}) and has withdrawn {len(withdrawn)}"
        f"{(': ' + ', '.join(withdrawn)) if withdrawn else ''}.",
        '',
        '## Share rated hard',
        '',
        '| | Math | Reading and Writing |',
        '| --- | ---: | ---: |',
    ]
    for label, pick in [('all added', lambda f: True), ('new', lambda f: f['status'] == 'new')]:
        cells = []
        for sec in ('math', 'rw'):
            fs = [f for f in found.values() if f['section'] == sec and pick(f)]
            cells.append(f"{sum(1 for f in fs if f['difficulty'] == 'hard') / len(fs):.0%} of {len(fs)}" if fs else '-')
        lines.append(f'| {label} | {cells[0]} | {cells[1]} |')
    lines += ['', '## Matches', '', '| Question | Published | Status | Found in | Id | Containment | Jaccard |',
              '| --- | --- | --- | --- | --- | ---: | ---: |']
    for qid, f in sorted(found.items(), key=lambda kv: (kv[1]['status'], kv[0])):
        if f['match']:
            m = f['match']
            lines.append(f"| {qid} | {f['published_on']} | {f['status']} | {m['in']} | {m['id']} | {m['containment']} | {m['jaccard']} |")
    (OUT / 'reports').mkdir(parents=True, exist_ok=True)
    (OUT / 'reports' / 'cb-new.md').write_text('\n'.join(lines) + '\n', encoding='utf8')
    print('\n'.join(lines[:12]), file=sys.stderr)


if __name__ == '__main__':
    main()
