"""Render every DSAT page that the vision pass reads, cropped to its ink.

Scans carry their own resolution: rendering the 96 dpi screenshot tests any
finer only enlarges pixels, while the ~350 dpi phone scans are downsampled to
the image budget. Word documents are first laid out to PDF with their inline
pictures (docx_render.py).

Usage: python3 dsat_render.py [--tests 1,2]   -> OUT/cache/pages/dsat/..., OUT/dsat/render.json
"""

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pymupdf

from common import CACHE, DSAT_ROOT, OUT, content_rect, ink_rect, read_json, render_clip, write_json
from docx_render import render as render_docx
from dsat_sources import TESTS


def native_dpi(page):
    """Resolution of the page's dominant raster image, or None if born-digital."""
    infos = page.get_image_info()
    if not infos:
        return None
    big = max(infos, key=lambda i: (i['bbox'][2] - i['bbox'][0]) * (i['bbox'][3] - i['bbox'][1]))
    w_pt = big['bbox'][2] - big['bbox'][0]
    h_pt = big['bbox'][3] - big['bbox'][1]
    if w_pt * h_pt < 0.5 * page.rect.width * page.rect.height:
        return None  # pictures inside a born-digital page, not a scan
    return big['width'] / (w_pt / 72)


def open_source(test, rel):
    """(pymupdf document or list of page files, source path used for zooming)."""
    src = DSAT_ROOT / rel
    if src.is_dir():
        return [pymupdf.open(p) for p in sorted(src.glob('*.jpg'))], src
    if src.suffix == '.docx':
        pdf = CACHE / 'docx' / f't{test:02d}' / (src.stem + '.pdf')
        if not pdf.exists():
            pdf.parent.mkdir(parents=True, exist_ok=True)
            render_docx(src, pdf)
        return pymupdf.open(pdf), pdf
    return pymupdf.open(src), src


def render_page(task):
    test, kind, n, rel, pno = task
    docs, src = open_source(test, rel)
    if isinstance(docs, list):
        page = docs[pno][0]
        source = str(Path(rel) / sorted((DSAT_ROOT / rel).glob('*.jpg'))[pno].name)
        page_index = 0
    else:
        page = docs[pno]
        source = str(src) if src.suffix == '.pdf' and CACHE in src.parents else rel
        page_index = pno
    scan = native_dpi(page)
    clip = ink_rect(page) if scan else content_rect(page)
    if clip is None or clip.width < 20 or clip.height < 20:
        return task, []
    want = min(140, scan) if scan else 130
    out = CACHE / 'pages' / 'dsat' / f't{test:02d}' / f'{kind}{n}-p{pno + 1:03d}.png'
    parts = render_clip(page, clip, out, want_dpi=want, min_dpi=min(want, 90))
    return task, [{**p, 'page': page_index, 'source': source, 'scan_dpi': scan and round(scan)} for p in parts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tests', default='')
    args = ap.parse_args()
    only = {int(t) for t in args.tests.split(',') if t}
    tasks = []
    for test, spec in TESTS.items():
        if only and test not in only:
            continue
        for kind in ('book', 'key', 'explain'):
            for n, rel in enumerate(spec.get(kind, []), 1):
                docs, _ = open_source(test, rel)
                count = len(docs) if isinstance(docs, list) else docs.page_count
                tasks += [(test, kind, n, rel, p) for p in range(count)]
    manifest = read_json(OUT / 'dsat' / 'render.json', {})
    with ProcessPoolExecutor(8) as ex:
        for i, ((test, kind, n, rel, pno), images) in enumerate(ex.map(render_page, tasks, chunksize=4), 1):
            manifest[f't{test:02d}/{kind}{n}/p{pno + 1:03d}'] = images
            if i % 250 == 0:
                print(f'{i}/{len(tasks)}', file=sys.stderr)
    write_json(OUT / 'dsat' / 'render.json', manifest)
    ims = [im for k, v in manifest.items() for im in v]
    px = sum(im['width'] * im['height'] for im in ims)
    print(f'{len(tasks)} pages -> {len(ims)} images, ~{px / 750 / 1e6:.2f}M image tokens', file=sys.stderr)


if __name__ == '__main__':
    main()
