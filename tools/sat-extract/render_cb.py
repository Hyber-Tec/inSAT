"""Render College Board questions for the vision pass: one image per page region,
cropped to the question's own content (the "ID: <id>" banner down), so the
header table and empty margins do not spend the image budget.

Usage: python3 render_cb.py [--section math|rw] [--ids id1,id2]
        -> OUT/cache/pages/cb/<id>-<n>.png and OUT/cb/render.json
"""

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor

import pymupdf

from common import CACHE, CB_ROOT, OUT, content_rect, read_json, render_clip, write_json


def render_question(q):
    doc = pymupdf.open(CB_ROOT / q['file'])
    images = []
    for n, r in enumerate(q['regions']):
        page = doc[r['page']]
        top = (q['content_top'] - 4) if n == 0 and q['content_top'] is not None else r['y0']
        region = pymupdf.Rect(0, top, page.rect.width, r['y1'])
        clip = content_rect(page, top=top)
        if clip is None:
            continue
        clip &= region
        if clip.is_empty or clip.height < 12:
            continue
        out = CACHE / 'pages' / 'cb' / f"{q['id']}-{n + 1}.png"
        for part in render_clip(page, clip, out, want_dpi=135, min_dpi=100):
            images.append({**part, 'page': r['page']})
    return q['id'], images


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--section', default='math')
    ap.add_argument('--ids', default='')
    args = ap.parse_args()
    index = read_json(OUT / 'cb' / 'index.json')
    wanted = set(filter(None, args.ids.split(',')))
    todo = [q for q in index if q['section'] == args.section and (not wanted or q['id'] in wanted)]
    manifest = read_json(OUT / 'cb' / 'render.json', {})
    with ProcessPoolExecutor(8) as ex:
        for i, (qid, images) in enumerate(ex.map(render_question, todo, chunksize=8), 1):
            manifest[qid] = images
            if i % 200 == 0:
                print(f'{i}/{len(todo)}', file=sys.stderr)
    write_json(OUT / 'cb' / 'render.json', manifest)
    n_img = sum(len(manifest[q['id']]) for q in todo)
    px = sum(im['width'] * im['height'] for q in todo for im in manifest[q['id']])
    print(f'{len(todo)} questions -> {n_img} images, {px / 1e6:.0f} MP total '
          f'(~{px / 750 / 1e6:.2f}M image tokens)', file=sys.stderr)


if __name__ == '__main__':
    main()
