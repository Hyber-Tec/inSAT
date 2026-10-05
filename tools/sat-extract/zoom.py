"""Re-render part of a page image at higher resolution, straight from the source
PDF, for reading small print or plotted points precisely.

Usage: python3 zoom.py <image> x0 y0 x1 y1 [scale]
  <image>        the image's full `path` from your job manifest (a bare file name
                 works only when it is unique: DSAT page names repeat per test)
  x0 y0 x1 y1    region in that image's pixels (top-left origin)
  scale          magnification over the page image, default 3

Prints the path of the zoomed PNG, which you can then Read.
"""

import sys
from pathlib import Path

import pymupdf

from common import CACHE, CB_ROOT, DSAT_ROOT, OUT, fit_dpi, pixmap, read_json


def candidates():
    cb_files = {q['id']: q['file'] for q in read_json(OUT / 'cb' / 'index.json', [])}
    for key, images in read_json(OUT / 'cb' / 'render.json', {}).items():
        for im in images:
            yield im, CB_ROOT / cb_files[key]
    for images in read_json(OUT / 'dsat' / 'render.json', {}).values():
        for im in images:
            src = Path(im['source'])
            yield im, (src if src.is_absolute() else DSAT_ROOT / src)


def find(arg):
    target = Path(arg)
    if target.is_absolute():
        hits = [(im, pdf) for im, pdf in candidates() if Path(im['path']) == target]
    else:
        hits = [(im, pdf) for im, pdf in candidates() if Path(im['path']).name == target.name]
    if not hits:
        raise SystemExit(f'unknown image {arg}')
    if len(hits) > 1:
        raise SystemExit(f'{arg} is ambiguous ({len(hits)} images have that name); pass its full path '
                         f'from the manifest, e.g. {hits[0][0]["path"]}')
    return hits[0]


def main():
    if len(sys.argv) < 6:
        raise SystemExit(__doc__)
    x0, y0, x1, y1 = (float(v) for v in sys.argv[2:6])
    scale = float(sys.argv[6]) if len(sys.argv) > 6 else 3.0
    im, pdf = find(sys.argv[1])
    k = 72 / im['dpi']
    cx, cy = im['clip'][0], im['clip'][1]
    page = pymupdf.open(pdf)[im['page']]
    clip = pymupdf.Rect(cx + x0 * k, cy + y0 * k, cx + x1 * k, cy + y1 * k) & page.rect
    if clip.is_empty:
        raise SystemExit('region is outside the image')
    dpi = fit_dpi(clip, im['dpi'] * scale)
    stem = Path(im['path']).stem
    parent = Path(im['path']).parent.name
    out = CACHE / 'zoom' / f'{parent}-{stem}_{int(x0)}_{int(y0)}_{int(x1)}_{int(y1)}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    pixmap(page, dpi, clip).save(str(out))
    print(out)


if __name__ == '__main__':
    main()
