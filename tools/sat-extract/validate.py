"""Validate transcribed records against the rules in SPEC.md and against an
independent reading of the same page.

Independent readings: for the College Board bank, the PDF text layer (exact for
prose); for scans, Tesseract OCR (noisy, so only large disagreements count).
Every non-math word of the reference should appear in the transcription and the
transcription should not contain prose the page does not have. Math is excluded
from the comparison on both sides because it is exactly what the text layer
cannot represent.

Usage: python3 validate.py cb [--ids a,b] [--quiet]   -> OUT/reports/cb-validation.json (+ summary)
"""

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from pathlib import Path

from common import OUT, read_json, write_json

TOOLS = Path(__file__).resolve().parent
LETTERS = ['A', 'B', 'C', 'D']
REQUIRED = ['uid', 'passage', 'question', 'answer_type', 'choices', 'answer', 'accepted',
            'rationale', 'figure', 'check', 'flags']
# Banner and label words of the College Board export, and math function names
# that the text layer drops with the rest of the math.
FURNITURE = set('''answer correct rationale question difficulty easy medium hard
sin cos tan log lim max min'''.split())
IDS = re.compile(r'\bID:?\s*[0-9a-f]{6,}\b|\b[0-9a-f]{8}\b')
LATEX_CMD = re.compile(r'\\[a-zA-Z]+')

MATH = re.compile(r'\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$')
WORD = re.compile(r"[A-Za-z][A-Za-z']{2,}")


def all_text(rec, descriptions=False):
    parts = [rec.get('passage') or '', rec.get('question') or '', *(rec.get('choices') or []), rec.get('rationale') or '']
    figs = rec.get('figure')
    figs = figs if isinstance(figs, list) else [figs] if figs else []
    for f in figs:
        if descriptions and (f or {}).get('description'):
            parts.append(f['description'])  # axis titles and labels live here
        t = (f or {}).get('table') or {}
        if t.get('title'):
            parts.append(t['title'])
        for row in t.get('rows') or []:
            for cell in row:
                parts.append(cell.get('text', '') if isinstance(cell, dict) else str(cell))
    return '\n'.join(parts)


def words(text, strip_math):
    # Compare letters without their accents (Ibanez, Hawai'i), so a word is
    # never split in two by a character outside ASCII.
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c)).replace('\u02bb', "'")
    text = IDS.sub(' ', text)
    if strip_math:
        # Keep what a math span spells out (names like ABC, words in \text{})
        # but not the LaTeX command names around them.
        text = LATEX_CMD.sub(' ', text)
    text = text.replace('<u>', ' ').replace('</u>', ' ')
    text = text.replace('\u2019', "'").replace('\u2018', "'")
    return Counter(w.lower().strip("'") for w in WORD.findall(text) if w.lower().strip("'") not in FURNITURE)


def overlap(ref, got):
    inter = sum((ref & got).values())
    return (inter / max(1, sum(ref.values())), inter / max(1, sum(got.values())),
            sorted((ref - got).elements())[:25], sorted((got - ref).elements())[:25])


def check_shape(rec):
    issues = []
    for k in REQUIRED:
        if k not in rec:
            issues.append(f'missing field {k}')
    at = rec.get('answer_type')
    ans = str(rec.get('answer') or '').strip()
    ch = rec.get('choices') or []
    if at == 'multiple-choice':
        if len(ch) != 4 or not all(str(c).strip() for c in ch):
            issues.append(f'multiple choice needs 4 non-empty choices, has {len(ch)}')
        elif len({re.sub(r'\s+', '', str(c)) for c in ch}) < 4:
            issues.append('duplicate choices')
        if ans not in LETTERS:
            issues.append(f'answer {ans!r} is not A-D')
    elif at == 'grid-in':
        if ch:
            issues.append('grid-in has choices')
        if not ans:
            issues.append('grid-in has no answer')
        acc = rec.get('accepted') or []
        if acc and ans not in acc:
            issues.append('accepted does not include answer')
    else:
        issues.append(f'answer_type {at!r}')
    if not str(rec.get('question') or '').strip():
        issues.append('empty question')
    st = (rec.get('check') or {}).get('status')
    if st not in ('ok', 'mismatch', 'unverifiable'):
        issues.append(f'check.status {st!r}')
    figs = rec.get('figure')
    for f in (figs if isinstance(figs, list) else [figs] if figs else []):
        if not isinstance(f, dict) or f.get('kind') not in ('table', 'graph', 'diagram', 'image'):
            issues.append('bad figure object')
            continue
        bb = f.get('bbox')
        if not (isinstance(bb, list) and len(bb) == 4 and bb[2] > bb[0] and bb[3] > bb[1]):
            issues.append('figure bbox invalid')
        if f['kind'] == 'table' and not (f.get('table') or {}).get('rows'):
            issues.append('table figure without rows')
    return issues


def norm_answer(a):
    return re.sub(r'\s+', '', str(a or '')).replace('\u2212', '-').lower()


def katex_problems(paths):
    if not paths:
        return {}
    res = subprocess.run(['node', str(TOOLS / 'katex_check.mjs'), *map(str, paths)], capture_output=True, text=True)
    out = {}
    for line in res.stdout.splitlines():
        p = json.loads(line)
        out.setdefault(p.get('uid') or p['file'], []).append(p)
    return out


def validate_cb(ids, quiet):
    index = {q['id']: q for q in read_json(OUT / 'cb' / 'index.json')}
    rec_dir = OUT / 'out' / 'cb'
    paths = sorted(rec_dir.glob('*.json'))
    if ids:
        paths = [p for p in paths if p.stem in ids]
    kt = katex_problems(paths)
    report = {}
    for p in paths:
        try:
            rec = json.loads(p.read_text(encoding='utf8'))
        except json.JSONDecodeError as err:
            report[p.stem] = {'issues': [f'invalid json: {err}']}
            continue
        q = index.get(p.stem)
        issues = check_shape(rec)
        if rec.get('uid') != f'cb:{p.stem}':
            issues.append(f"uid {rec.get('uid')!r} does not match file")
        if q and q['correct_answer_text']:
            # Grid-ins list every accepted form: "-13/2, -6.5".
            pdf = {norm_answer(a) for a in re.split(r',\s+|\s+or\s+', q['correct_answer_text'])}
            got = {norm_answer(a) for a in [rec.get('answer'), *(rec.get('accepted') or [])]}
            if norm_answer(rec.get('answer')) not in pdf or (len(pdf) > 1 and not pdf <= got):
                issues.append(f"answer {rec.get('answer')!r} / accepted {rec.get('accepted')} but the PDF says {q['correct_answer_text']!r}")
        recall = precision = None
        missing = extra = []
        if q:
            ref = words(q['text'], strip_math=False)
            # Recall keeps what math spells out (names like ABC are prose in the
            # text layer); precision drops math entirely, since the text layer has
            # none. Choices that describe a figure are the reader's words.
            got_all = words(all_text(rec, descriptions=True), strip_math=True)
            recall, _, missing, _ = overlap(ref, got_all)
            no_math = dict(rec)
            if 'figure-in-choices' in ' '.join(rec.get('flags') or []):
                no_math['choices'] = []
            got_prose = words(MATH.sub(' ', all_text(no_math)), strip_math=True)
            _, precision, _, extra = overlap(ref, got_prose)
            # The text layer holds a few words the transcription legitimately
            # renders as math (units in \text{}, variable names spelled out), so
            # small gaps are normal; anything past a sentence is not.
            # A record parsed from the text layer must match it word for word;
            # one read from the image may differ where math is spelled out.
            strict = rec.get('method') == 'text-layer'
            if missing and (strict or (recall < 0.97 and len(missing) > 3)):
                issues.append(f'prose missing vs text layer ({recall:.0%}): {" ".join(missing)}')
            if extra and (strict or (precision < 0.97 and len(extra) > 3)):
                issues.append(f'prose not in text layer ({precision:.0%}): {" ".join(extra)}')
        for k in kt.get(rec.get('uid'), []) + kt.get(str(p), []):
            issues.append(f"{k['kind']} in {k['where']}: {k.get('tex') or k.get('sample') or ''} {k.get('error', '')}".strip())
        st = (rec.get('check') or {}).get('status')
        report[p.stem] = {
            'issues': issues,
            'check': st,
            'check_note': (rec.get('check') or {}).get('note', ''),
            'flags': rec.get('flags') or [],
            'recall': recall and round(recall, 3),
            'precision': precision and round(precision, 3),
        }
    write_json(OUT / 'reports' / 'cb-validation.json', report)
    bad = {k: v for k, v in report.items() if v['issues'] or v.get('flags') or v.get('check') != 'ok'}
    print(f'{len(report)} records, {len(bad)} with issues, flags or a non-ok check')
    if not quiet:
        for k, v in bad.items():
            print(f'\n{k}  check={v.get("check")}  recall={v.get("recall")} precision={v.get("precision")}')
            for i in v['issues']:
                print(f'   - {i}')
            for fl in v.get('flags', []):
                print(f'   * flag {fl}')
            if v.get('check') != 'ok' and v.get('check_note'):
                print(f'   > {v["check_note"][:300]}')
    return report


def ocr_words(test, name, page):
    # A tall page is rendered (and OCR'd) in slices: p033-a, p033-b, ...
    files = sorted((OUT / 'dsat' / 'ocr').glob(f't{test:02d}-{name}-p{page:03d}*.txt'))
    return sum((words(f.read_text(encoding='utf8'), strip_math=False) for f in files), Counter())


def validate_dsat(tests, quiet):
    """Book and explanation records against Tesseract's reading of the same
    pages. OCR garbles some words, so only a large share of transcribed words
    missing from the page (a wrong page, or text that is not there) counts."""
    report = {}
    for tdir in sorted((OUT / 'out' / 'dsat').glob('t[0-9][0-9]')):
        test = int(tdir.name[1:])
        if tests and test not in tests:
            continue
        paths = sorted(tdir.glob('*.json'))
        kt = katex_problems(paths)
        for p in paths:
            rec = json.loads(p.read_text(encoding='utf8'))
            name = p.stem.split('-p')[0]
            page = int(p.stem.split('-p')[1].split('-')[0])
            issues = []
            if name.startswith('book'):
                issues += [i for i in check_shape({**rec, 'answer': rec.get('solved_answer')})
                           if not i.startswith('check.status')]
                if (rec.get('check') or {}).get('status') not in ('solved', 'unverifiable'):
                    issues.append(f"check.status {(rec.get('check') or {}).get('status')!r}")
                # Table cells OCR poorly in scans; the running text is enough to
                # tell whether the record came from this page.
                text = '\n'.join([rec.get('passage') or '', rec.get('question') or '', *(rec.get('choices') or [])])
            else:
                text = rec.get('rationale') or ''
            ref = ocr_words(test, name, page) + ocr_words(test, name, page - 1) + ocr_words(test, name, page + 1)
            got = words(MATH.sub(' ', text), strip_math=True)
            if sum(got.values()) >= 12 and ref:
                inter = sum((got & ref).values())
                precision = inter / sum(got.values())
                if precision < 0.7:
                    issues.append(f'{precision:.0%} of transcribed words are on the page per OCR: '
                                  f'{" ".join(sorted((got - ref).elements())[:15])}')
            for k in kt.get(rec.get('uid'), []) + kt.get(str(p), []):
                issues.append(f"{k['kind']} in {k['where']}: {k.get('tex') or k.get('sample') or ''} {k.get('error', '')}".strip())
            report[f'{tdir.name}/{p.stem}'] = {'issues': issues, 'flags': rec.get('flags') or []}
    write_json(OUT / 'reports' / 'dsat-validation.json', report)
    bad = {k: v for k, v in report.items() if v['issues']}
    print(f'{len(report)} records, {len(bad)} with issues')
    if not quiet:
        for k, v in bad.items():
            print(f'\n{k}')
            for i in v['issues']:
                print(f'   - {i}')
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('collection', choices=['cb', 'dsat'])
    ap.add_argument('--ids', default='')
    ap.add_argument('--tests', default='')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    if args.collection == 'cb':
        validate_cb(set(filter(None, args.ids.split(','))), args.quiet)
    else:
        validate_dsat({int(t) for t in args.tests.split(',') if t}, args.quiet)


if __name__ == '__main__':
    sys.exit(main())
