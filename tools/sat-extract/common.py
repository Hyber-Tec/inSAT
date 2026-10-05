"""Shared paths and helpers for turning the SAT source PDFs into structured data.

The source material lives in the project's private-data/ folder, which git
ignores (it is College Board and third-party content, so it is never
committed). Everything this tooling writes goes under OUT, next to the
sources, for the same reason.
"""

import json
import os
import re
from pathlib import Path

import pymupdf

REPO = Path(__file__).resolve().parents[2]
SRC = Path(os.environ.get('SAT_SRC', str(REPO / 'private-data' / 'SAT')))
CB_ROOT = SRC / 'College Board Question Bank'
DSAT_ROOT = SRC / 'DSAT'
OUT = Path(os.environ.get('SAT_OUT', str(SRC / 'extracted')))
CACHE = OUT / 'cache'

# Folder names in the College Board bank -> taxonomy ids in server/lib/taxonomy.js.
DOMAIN_ID = {
    'Information and Ideas': 'info-ideas',
    'Craft and Structure': 'craft-structure',
    'Expression of Ideas': 'expression',
    'Standard English Conventions': 'conventions',
    'Algebra': 'algebra',
    'Advanced Math': 'advanced-math',
    'Problem-Solving and Data Analysis': 'problem-solving',
    'Geometry and Trigonometry': 'geometry-trig',
}

# Image budget for one page image shown to a vision reader. Larger images are
# downscaled by the reader anyway, so rendering past this only costs tokens.
MAX_PIXELS = 1_150_000
MAX_EDGE = 1560

pymupdf.TOOLS.mupdf_display_errors(False)


def read_json(path, default=None):
    try:
        with open(path, encoding='utf8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _tmp_for(path):
    """A temporary file beside `path`, unique to this process, so two builds
    writing the same file at once each replace it with a complete copy."""
    return path.with_name(f'.{path.name}.{os.getpid()}.tmp')


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_for(path)
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    tmp.replace(path)


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding='utf8') as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as err:
                    raise ValueError(f'{path}:{n}: {err}') from err
    except FileNotFoundError:
        pass
    return rows


def write_jsonl(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_for(path)
    with open(tmp, 'w', encoding='utf8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    tmp.replace(path)


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', str(text).lower()).strip('-')


def content_rect(page, top=None, pad=6):
    """Union of everything drawn on the page (text, vector paths, images),
    optionally starting at y=top. Used to crop away empty margins."""
    rects = []
    for b in page.get_text('blocks'):
        rects.append(pymupdf.Rect(b[:4]))
    for d in page.get_drawings():
        r = d['rect']
        # Full-page frames and hairline rules at the page edge are not content.
        if r.width > page.rect.width * 0.98 and r.height > page.rect.height * 0.98:
            continue
        rects.append(r)
    for info in page.get_image_info():
        rects.append(pymupdf.Rect(info['bbox']))
    if top is not None:
        rects = [r for r in rects if r.y1 > top]
    rects = [r & page.rect for r in rects]
    rects = [r for r in rects if not r.is_empty]
    if not rects:
        return None
    u = pymupdf.Rect(rects[0])
    for r in rects[1:]:
        u |= r
    if top is not None:
        u.y0 = max(u.y0, top)
    u = pymupdf.Rect(u.x0 - pad, u.y0 - pad, u.x1 + pad, u.y1 + pad) & page.rect
    return u


def ink_rect(page, threshold=200, probe_dpi=36, pad_pt=8):
    """Bounding box of non-white pixels, for scanned pages whose only content is
    one big image (the image itself covers the page, margins included)."""
    pix = page.get_pixmap(dpi=probe_dpi, colorspace=pymupdf.csGRAY)
    w, h, s = pix.width, pix.height, pix.samples
    rows = [y for y in range(h) if min(s[y * w:(y + 1) * w]) < threshold]
    if not rows:
        return None
    cols_min = w
    cols_max = 0
    for y in rows:
        line = s[y * w:(y + 1) * w]
        xs = [x for x in range(w) if line[x] < threshold]
        cols_min = min(cols_min, xs[0])
        cols_max = max(cols_max, xs[-1])
    k = 72 / probe_dpi
    r = pymupdf.Rect(cols_min * k - pad_pt, rows[0] * k - pad_pt,
                     (cols_max + 1) * k + pad_pt, (rows[-1] + 1) * k + pad_pt)
    return r & page.rect


def fit_dpi(clip, want_dpi):
    """Largest dpi <= want_dpi that keeps the rendered clip inside the budget."""
    w_in, h_in = clip.width / 72, clip.height / 72
    dpi = want_dpi
    dpi = min(dpi, MAX_EDGE / max(w_in, h_in))
    dpi = min(dpi, (MAX_PIXELS / (w_in * h_in)) ** 0.5)
    return dpi


def pixmap(page, dpi, clip):
    # get_pixmap(dpi=) only takes integers; a matrix allows the exact fit.
    return page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72), clip=clip)


def render_clip(page, clip, out_path, want_dpi=130, min_dpi=96):
    """Render one region of a page to PNG. A region too big to stay legible at
    min_dpi inside the pixel budget is split into vertical slices instead, so
    small print is never downscaled past the point of reading it."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dpi = fit_dpi(clip, want_dpi)
    if dpi >= min_dpi:
        pix = pixmap(page, dpi, clip)
        pix.save(str(out_path))
        return [{'path': str(out_path), 'width': pix.width, 'height': pix.height,
                 'dpi': round(dpi, 1), 'clip': [round(v, 1) for v in clip]}]
    # Slice top to bottom with a small overlap so no line is cut in half.
    dpi = min_dpi
    slice_h = min(MAX_EDGE / dpi * 72, MAX_PIXELS / ((clip.width / 72 * dpi) * dpi) * 72)
    overlap = 18
    parts = []
    y = clip.y0
    i = 0
    while y < clip.y1 - 1:
        y1 = min(clip.y1, y + slice_h)
        sub = pymupdf.Rect(clip.x0, y, clip.x1, y1)
        pix = pixmap(page, dpi, sub)
        p = out_path.with_name(f'{out_path.stem}-{chr(97 + i)}{out_path.suffix}')
        pix.save(str(p))
        parts.append({'path': str(p), 'width': pix.width, 'height': pix.height,
                      'dpi': dpi, 'clip': [round(v, 1) for v in sub]})
        if y1 >= clip.y1:
            break
        y = y1 - overlap
        i += 1
    return parts
