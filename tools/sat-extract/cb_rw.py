"""Parse the College Board Reading and Writing questions straight from the PDF.

Reading and Writing is prose, and the PDF text layer holds all of it exactly,
so no vision pass is needed except for questions that carry a table or chart
(drawn as vector graphics that text extraction flattens into a jumble). Those
are written to a list for the vision pass instead of being parsed.

What the old Ghostscript parser lost, and how this one keeps it:
  - paragraph boundaries: from vertical gaps between lines (a wrapped stem is
    one paragraph, not "the last line")
  - bullets in Rhetorical Synthesis notes: from the drawn bullet dots
  - underlined sentences: from the drawn underline strokes, as <u>...</u>
  - the "Text 1" / "Text 2" labels of cross-text passages

Usage: python3 cb_rw.py [--ids a,b]   -> OUT/out/cb/<id>.json for text-only questions,
                                          OUT/cb/rw-needs-vision.json for the rest
"""

import argparse
import re
import sys
import unicodedata
from pathlib import Path

import pymupdf

from common import CB_ROOT, OUT, read_json, write_json

LETTERS = 'ABCD'
CHOICE = re.compile(r'^([A-D])\.\s*(.*)$')
PARA_GAP = 21.0     # line pitch inside a paragraph is ~15pt, between paragraphs ~26pt
LIGATURES = {'\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl'}


def clean(text):
    for k, v in LIGATURES.items():
        text = text.replace(k, v)
    text = (text.replace('\u2018', "'").replace('\u2019', "'")
                .replace('\u201c', '"').replace('\u201d', '"')
                .replace('\u201a', ',')        # a low quote used as a comma
                .replace('\xa0', ' ')
                .replace('\u200b', '')         # zero-width space
                .replace('\xad', ''))          # soft hyphen
    text = unicodedata.normalize('NFC', text)
    text = re.sub(r'_{3,}', '______', text)
    return re.sub(r'[ \t]+', ' ', text).strip()


def inside(rect, zones):
    """Whether a rect's center falls in any of the figure zones."""
    c = pymupdf.Point((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    return any(c in z for z in zones)


def classify_drawings(page, clip, zones=()):
    """Split the vector graphics in a region into bullets, underlines and the rest."""
    bullets, underlines, other = [], [], 0
    for d in page.get_drawings():
        r = d['rect']
        if not r.intersects(clip) or inside(r, zones):
            continue
        if r.width > page.rect.width * 0.8 and r.height > page.rect.height * 0.5:
            continue  # page frame
        if 18 <= r.height <= 32 and r.width > 90 and r.x0 < 20:
            continue  # the dark "ID:" banners
        kinds = {it[0] for it in d['items']}
        if r.width < 6 and r.height < 6 and kinds <= {'c'}:
            bullets.append(r)
            continue
        if r.height <= 1.6 and r.width >= 2:
            underlines.append(r)
            continue
        other += 1
    return bullets, underlines, other


def line_text(line, underlines):
    """Line text with underlined runs wrapped in <u>...</u>."""
    chars = [c for s in line['spans'] for c in s['chars']]

    def under(c):
        x = (c['bbox'][0] + c['bbox'][2]) / 2
        base = c['bbox'][3]
        return any(u.x0 - 1 <= x <= u.x1 + 1 and base - 3.5 <= u.y0 <= base + 3.5 for u in underlines)

    flags = [under(c) for c in chars]
    # A space between two underlined characters is part of the underlined run.
    for i, c in enumerate(chars):
        if c['c'].isspace() and 0 < i < len(chars) - 1 and flags[i - 1] and flags[i + 1]:
            flags[i] = True
    out, inside = [], False
    for c, f in zip(chars, flags):
        if f and not inside:
            out.append('<u>')
            inside = True
        elif not f and inside:
            out.append('</u>')
            inside = False
        out.append(c['c'])
    if inside:
        out.append('</u>')
    text = ''.join(out)
    # Keep markup tight around words: "<u> foo</u>" -> " <u>foo</u>"
    text = re.sub(r'<u>(\s+)', r'\1<u>', text)
    text = re.sub(r'(\s+)</u>', r'</u>\1', text)
    return text


SUP = str.maketrans('0123456789+-=()', '\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079\u207a\u207b\u207c\u207d\u207e')
SUB = str.maketrans('0123456789+-=()', '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089\u208a\u208b\u208c\u208d\u208e')
SMALL = 9.6  # body text is 10.1pt; super/subscripts are 8.6pt


def merge_scripts(raw_lines):
    """Fold superscript and subscript fragments (isotopes, CO2) into the line
    they belong to. The text layer stores them as separate lines on a shifted
    baseline and leaves a placeholder space under them in the host line, and it
    can split the host itself into fragments around them."""
    def chars_of(ln):
        return [c for s in ln['spans'] for c in s['chars']]

    def small(ln):
        sizes = [s['size'] for s in ln['spans'] if ''.join(c['c'] for c in s['chars']).strip()]
        return bool(sizes) and max(sizes) < SMALL

    # 1. Rebuild visual lines: fragments sharing a baseline are one line.
    visual = []
    for ln in sorted((l for l in raw_lines if not small(l)), key=lambda l: (l['bbox'][3], l['bbox'][0])):
        host = next((v for v in visual if abs(v['bbox'][3] - ln['bbox'][3]) < 2.0), None)
        if host is None:
            visual.append({'bbox': list(ln['bbox']), 'chars': chars_of(ln),
                           'fonts': {s['font'] for s in ln['spans']}})
        else:
            host['chars'] += chars_of(ln)
            host['fonts'] |= {s['font'] for s in ln['spans']}
            host['bbox'] = [min(host['bbox'][0], ln['bbox'][0]), min(host['bbox'][1], ln['bbox'][1]),
                            max(host['bbox'][2], ln['bbox'][2]), max(host['bbox'][3], ln['bbox'][3])]

    # 2. Attach each script to the visual line it overlaps vertically.
    for ln in raw_lines:
        if not small(ln):
            continue
        y0, y1 = ln['bbox'][1], ln['bbox'][3]
        host = max(visual, key=lambda v: min(y1, v['bbox'][3]) - max(y0, v['bbox'][1]), default=None)
        if host is None or min(y1, host['bbox'][3]) - max(y0, host['bbox'][1]) <= 0:
            visual.append({'bbox': list(ln['bbox']), 'chars': chars_of(ln), 'fonts': {'script'}})
            continue
        up = (y0 + y1) / 2 < (host['bbox'][1] + host['bbox'][3]) / 2
        table = SUP if up else SUB
        scripts = [dict(c, c=c['c'].translate(table), script=True) for c in chars_of(ln) if c['c'].strip()]
        # The host carries a placeholder space exactly where the script sits.
        spans = [(c['bbox'][0], c['bbox'][2]) for c in scripts]
        host['chars'] = [c for c in host['chars']
                         if not (c['c'].isspace() and any(a - 0.5 <= (c['bbox'][0] + c['bbox'][2]) / 2 <= b + 0.5
                                                          for a, b in spans))]
        # Insert each script before the first host character to its right. The
        # host keeps its own order: characters expanded from one ligature glyph
        # share a position, so sorting the whole line by x can swap them
        # ("five" came out as "fvie").
        for sc in scripts:
            cx = (sc['bbox'][0] + sc['bbox'][2]) / 2
            at = next((i for i, c in enumerate(host['chars']) if (c['bbox'][0] + c['bbox'][2]) / 2 > cx),
                      len(host['chars']))
            host['chars'].insert(at, sc)

    return [{'bbox': tuple(v['bbox']),
             'spans': [{'size': 10.1, 'font': ','.join(sorted(v['fonts'])), 'chars': v['chars']}]}
            for v in visual]


def collect(q, doc, zones_by_page=None):
    """Lines of one question in reading order. `zones_by_page` maps a page
    index to figure rectangles whose text belongs to the figure, not the prose."""
    lines, bullets, underlines, figure_marks = [], [], [], 0
    for n, r in enumerate(q['regions']):
        page = doc[r['page']]
        zones = (zones_by_page or {}).get(r['page'], [])
        top = q['content_top'] if n == 0 and q['content_top'] is not None else r['y0']
        clip = pymupdf.Rect(0, top, page.rect.width, r['y1'])
        b, u, other = classify_drawings(page, clip, zones)
        figure_marks += other
        underlines_here = u
        raw_lines = []
        for blk in page.get_text('rawdict', clip=clip)['blocks']:
            if blk['type'] != 0:
                if not inside(blk['bbox'], zones):
                    figure_marks += 10
                continue
            raw_lines += [ln for ln in blk['lines'] if not inside(ln['bbox'], zones)]
        if True:
            for ln in merge_scripts(raw_lines):
                text = line_text(ln, underlines_here)
                lines.append({
                    'page': n, 'y0': ln['bbox'][1], 'y1': ln['bbox'][3], 'x0': ln['bbox'][0], 'x1': ln['bbox'][2],
                    'text': text,
                    'fonts': {s['font'] for s in ln['spans'] if ''.join(c['c'] for c in s['chars']).strip()},
                    'bullet': any(bb.y0 >= ln['bbox'][1] - 2 and bb.y1 <= ln['bbox'][3] + 2 and bb.x1 < ln['bbox'][0]
                                  for bb in b),
                })
        bullets += b
        underlines += u
    lines.sort(key=lambda l: (l['page'], round(l['y0'], 1), l['x0']))
    return lines, figure_marks


VERSE_SHORTFALL = 100.0  # a line ending this far before the right margin was broken on purpose


def paragraphs(lines):
    """Group lines into paragraphs by gaps, bullets, labels and indentation.

    Inside a paragraph, wrapped lines are joined with a space, except that a
    line ending well short of the right margin was broken on purpose (verse,
    an address, a list), so it keeps its line break."""
    paras = []
    prev = None
    right = max((l['x1'] for l in lines), default=590.0)
    for ln in lines:
        t = clean(ln['text'])
        if not t or t in ('<u></u>',):
            prev = None
            continue
        label = t in ('Text 1', 'Text 2')  # a line holding only the label, whatever its font
        # A page break is not a paragraph break: explanations often run on
        # across pages mid-sentence, so only gaps on the same page count.
        new = (prev is None or ln['bullet'] or label or prev.get('label')
               or (ln['page'] == prev['page'] and ln['y0'] - prev['y0'] > PARA_GAP)
               or (abs(ln['x0'] - prev['x0']) > 6 and not prev.get('in_bullet')))
        if new:
            paras.append({'text': ('• ' if ln['bullet'] else '') + t, 'bullet': ln['bullet']})
        else:
            cur = paras[-1]['text']
            if prev['x1'] < right - VERSE_SHORTFALL:
                joiner = '\n'
            elif cur.endswith('-') and not cur.endswith(' -'):
                joiner = ''
            else:
                joiner = ' '
            paras[-1]['text'] = cur + joiner + t
        prev = {**ln, 'label': label, 'in_bullet': ln['bullet'] or (prev and prev.get('in_bullet') and not new)}
    for p in paras:
        p['text'] = re.sub(r'</u>(\s*)<u>', r'\1', p['text'])
    return paras


def parse(q, doc, zones_by_page=None):
    lines, figure_marks = collect(q, doc, zones_by_page)
    texts = [clean(l['text']) for l in lines]

    def find(pred, start=0):
        return next((i for i in range(start, len(texts)) if pred(texts[i])), None)

    qid = q['id']
    i_start = find(lambda t: t == f'ID: {qid}')
    i_ans = find(lambda t: t == f'ID: {qid} Answer')
    if i_start is None or i_ans is None:
        return None, 'banners not found'
    i_correct = find(lambda t: t.startswith('Correct Answer:'), i_ans)
    i_rat = find(lambda t: t == 'Rationale', i_ans)
    i_diff = find(lambda t: t.startswith('Question Difficulty:'), i_ans)
    if i_rat is None:
        return None, 'no rationale marker'

    body = lines[i_start + 1:i_ans]
    choices, pre, current = [], [], None
    for ln in body:
        t = clean(ln['text'])
        m = CHOICE.match(t)
        if m and len(choices) < 4 and m.group(1) == LETTERS[len(choices)] and 15 < ln['x0'] < 27:
            choices.append(m.group(2))
            current = len(choices) - 1
        elif current is not None:
            if t:
                choices[current] = f'{choices[current]} {t}'.strip()
        else:
            pre.append(ln)
    if len(choices) != 4:
        return None, f'{len(choices)} choices found'

    paras = paragraphs(pre)
    if not paras:
        return None, 'no question text'
    stem = paras[-1]['text']
    passage = '\n'.join(p['text'] for p in paras[:-1]) or None

    answer = None
    if i_correct is not None:
        after = texts[i_correct].split(':', 1)[1].strip()
        answer = after or (texts[i_correct + 1] if i_correct + 1 < len(texts) else '')
    rat_lines = lines[i_rat + 1:i_diff if i_diff is not None else len(lines)]
    # Inside a rationale every hard break starts a new paragraph.
    rationale = '\n\n'.join(p['text'] for p in paragraphs(rat_lines))
    rationale = re.sub(r'(?<!\n)\n(?!\n)', '\n\n', rationale)

    rec = {
        'uid': f'cb:{qid}',
        'passage': passage,
        'question': stem,
        'answer_type': 'multiple-choice',
        'choices': [re.sub(r'</u>(\s*)<u>', r'\1', clean(c)) for c in choices],
        'answer': (answer or '').strip(),
        'accepted': [],
        'rationale': rationale,
        'figure': None,
        'check': {'status': 'unverifiable', 'note': 'parsed from the PDF text layer; key from the source'},
        'flags': [],
        'method': 'text-layer',
    }
    problems = []
    if rec['answer'] not in LETTERS:
        problems.append(f"answer {rec['answer']!r}")
    if not stem.rstrip().endswith(('?', '.', ':')):
        problems.append(f'stem does not end a sentence: {stem[-60:]!r}')
    if figure_marks > 4:
        problems.append(f'figure ({figure_marks} graphic elements)')
    return rec, '; '.join(problems)


def figure_zones(qid, fig_rec, render):
    """A figure-only record's bboxes (pixels of rendered images) as PDF
    rectangles per page index, padded a little."""
    images = {Path(im['path']).name: im for im in render.get(qid, [])}
    figs = fig_rec.get('figure')
    zones = {}
    for f in (figs if isinstance(figs, list) else [figs] if figs else []):
        im = images.get(f.get('image'))
        if not im or not f.get('bbox'):
            continue
        x0, y0, x1, y1 = f['bbox']
        k = 72 / im['dpi']
        cx, cy = im['clip'][0], im['clip'][1]
        rect = pymupdf.Rect(cx + x0 * k - 2, cy + y0 * k - 2, cx + x1 * k + 2, cy + y1 * k + 2)
        zones.setdefault(im['page'], []).append(rect)
    return zones


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', default='')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    only = set(filter(None, args.ids.split(',')))
    index = [q for q in read_json(OUT / 'cb' / 'index.json') if q['section'] == 'rw' and (not only or q['id'] in only)]
    render = read_json(OUT / 'cb' / 'render.json', {})
    docs = {}
    needs_vision, written, merged = [], 0, 0
    for q in index:
        doc = docs.setdefault(q['file'], pymupdf.open(CB_ROOT / q['file']))
        # A question with a figure read by the vision pass: parse its text with
        # the figure's area left out, then attach the figure as read.
        fig_path = OUT / 'out' / 'cb-fig' / f"{q['id']}.json"
        fig_rec = read_json(fig_path) if fig_path.exists() else None
        rec, problem = parse(q, doc, figure_zones(q['id'], fig_rec, render) if fig_rec else None)
        if rec is not None and fig_rec:
            rec['figure'] = fig_rec.get('figure')
            rec['flags'] = list(fig_rec.get('flags') or [])
            rec['method'] = 'text-layer+vision'
            problem = '; '.join(p for p in problem.split('; ') if p and not p.startswith('figure'))
            merged += 1
        if rec is None or problem:
            needs_vision.append({'id': q['id'], 'reason': problem})
            continue
        # A full vision transcription, where one exists, is kept as is.
        full = OUT / 'out' / 'cb' / f"{q['id']}.json"
        if full.exists() and read_json(full).get('method', 'vision') == 'vision' and not fig_rec:
            continue
        if not args.dry_run:
            write_json(full, rec)
        written += 1
    if not args.dry_run and not only:
        write_json(OUT / 'cb' / 'rw-needs-vision.json', needs_vision)
    reasons = {}
    for n in needs_vision:
        key = n['reason'].split('(')[0].split(':')[0].strip()
        reasons[key] = reasons.get(key, 0) + 1
    print(f'{len(index)} rw questions: {written} parsed from text ({merged} with a figure from the vision pass), '
          f'{len(needs_vision)} to the vision pass', file=sys.stderr)
    for k, v in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f'  {v:4d}  {k}', file=sys.stderr)


if __name__ == '__main__':
    main()
