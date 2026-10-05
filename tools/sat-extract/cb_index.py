"""Index the College Board question bank: one record per question, with the page
regions it occupies and everything the PDF text layer states reliably.

The text layer is trustworthy for prose, question ids, difficulty and (when the
line exists) the correct answer. It is not trustworthy for mathematics: stems
and choices draw math as vector paths or raster images, and even the rationale
math that is real text loses parentheses and exponents. So this index is a
scaffold for the vision pass and the ground truth it is checked against, not a
source of math.

Usage: python3 cb_index.py        -> OUT/cb/index.json
"""

import re
import sys
from collections import Counter

import pymupdf

from common import CB_ROOT, DOMAIN_ID, OUT, write_json

QID = re.compile(r'Question ID\s+([0-9a-f]{6,})')


def labels_for(path):
    rel = path.relative_to(CB_ROOT).parts
    section = 'math' if rel[0].upper().startswith('MATH') else 'rw'
    return {
        'section': section,
        'domain': DOMAIN_ID[rel[1]],
        'domain_label': rel[1],
        'skill': rel[2],
        'folder_difficulty': rel[3].lower(),
        'file': str(path.relative_to(CB_ROOT)),
    }


def header_hits(page):
    """(question id, y of the 'Question ID' header) for every question starting on this page."""
    hits = []
    for x0, y0, x1, y1, text, *_ in page.get_text('blocks'):
        for m in QID.finditer(text):
            hits.append((m.group(1), y0))
    return sorted(hits, key=lambda h: h[1])


def banner_y(page, qid):
    """Top of the 'ID: <qid>' banner, where the question content begins."""
    for r in page.search_for(f'ID: {qid}'):
        return r.y0
    return None


def after_label(text, label):
    m = re.search(label + r'\s*\n\s*([^\n]+)', text)
    return m.group(1).strip() if m else None


def index_file(path):
    doc = pymupdf.open(path)
    labels = labels_for(path)
    starts = []  # (page, y, qid)
    for pno, page in enumerate(doc):
        for qid, y in header_hits(page):
            starts.append((pno, y, qid))
    questions = []
    for i, (pno, y, qid) in enumerate(starts):
        end_pno, end_y = (starts[i + 1][0], starts[i + 1][1]) if i + 1 < len(starts) else (doc.page_count - 1, None)
        regions = []
        for p in range(pno, end_pno + 1):
            y0 = y if p == pno else 0
            y1 = end_y if (p == end_pno and end_y is not None) else doc[p].rect.height
            if p == end_pno and end_y is not None and p != pno and end_y < 40:
                continue  # next question starts at the very top: nothing of ours on that page
            if y1 - y0 < 4:
                continue
            regions.append({'page': p, 'y0': round(y0, 1), 'y1': round(y1, 1)})
        text = ''
        images = 0
        drawings = 0
        type3 = False
        top = banner_y(doc[pno], qid)
        for n, r in enumerate(regions):
            page = doc[r['page']]
            clip = pymupdf.Rect(0, r['y0'], page.rect.width, r['y1'])
            # The reference text starts at the "ID:" banner: the header table
            # above it repeats the folder labels and is not part of the question.
            text_clip = pymupdf.Rect(clip.x0, top, clip.x1, clip.y1) if n == 0 and top is not None else clip
            text += page.get_text(clip=text_clip) + '\n'
            images += sum(1 for info in page.get_image_info() if pymupdf.Rect(info['bbox']).intersects(clip))
            drawings += sum(1 for d in page.get_drawings() if d['rect'].intersects(clip))
            type3 = type3 or any(f[2] == 'Type3' for f in page.get_fonts())
        # A value missing from the text layer makes the next line ("Assessment",
        # from the header table) look like the value, so only accept real ones.
        pdf_difficulty = (after_label(text, r'Question Difficulty:') or '').lower()
        answer = after_label(text, r'Correct Answer:')
        if answer and answer.lower() in ('assessment', 'rationale'):
            answer = None
        questions.append({
            'id': qid,
            **labels,
            'pdf_difficulty': pdf_difficulty if pdf_difficulty in ('easy', 'medium', 'hard') else None,
            'correct_answer_text': answer,
            'regions': regions,
            'content_top': top,
            'images': images,
            'drawings': drawings,
            'type3': type3,
            'text': text,
        })
    return questions


def main():
    files = sorted(CB_ROOT.rglob('*_a.pdf'))
    all_q = []
    seen = set()
    for f in files:
        qs = index_file(f)
        # A handful of questions are printed twice in the same file.
        qs = [q for q in qs if not (q['id'] in seen or seen.add(q['id']))]
        all_q.extend(qs)
        print(f'{len(qs):4d}  {f.relative_to(CB_ROOT)}', file=sys.stderr)
    write_json(OUT / 'cb' / 'index.json', all_q)
    by = Counter(q['section'] for q in all_q)
    print(f"\n{len(all_q)} questions ({by['rw']} rw, {by['math']} math)", file=sys.stderr)


if __name__ == '__main__':
    main()
