"""Render a .docx to PDF with its inline images, for reading page by page.

PyMuPDF opens .docx natively but drops inline pictures, and the Word
conversions in DSAT (Tests 14-16) set every equation as an inline JPEG, so the
native rendering loses the math. These documents only use paragraphs, runs and
inline pictures (no tables, text boxes or floating shapes), so a direct
document.xml -> HTML -> PDF pass keeps everything that matters: text, bold,
italic, underline, super/subscripts, line breaks and the pictures in place.

Usage: python3 docx_render.py <in.docx> <out.pdf>
"""

import html
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pymupdf

NS = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
}
W = '{%s}' % NS['w']
EMU_PER_PT = 12700


def rels(z):
    root = ET.fromstring(z.read('word/_rels/document.xml.rels'))
    return {r.get('Id'): r.get('Target') for r in root.findall('rel:Relationship', NS)}


def on(el, tag):
    """A run property is on when present without w:val="0"/"false"/"none"."""
    x = el.find(f'w:{tag}', NS) if el is not None else None
    if x is None:
        return False
    return x.get(W + 'val', 'true') not in ('0', 'false', 'none')


def run_html(r, relmap):
    rpr = r.find('w:rPr', NS)
    parts = []
    for child in r:
        tag = child.tag.split('}')[1]
        if tag == 't':
            parts.append(html.escape(child.text or ''))
        elif tag == 'tab':
            parts.append('&#160;&#160;&#160;&#160;')
        elif tag in ('br', 'cr'):
            parts.append('<br/>')
        elif tag == 'drawing':
            blip = child.find('.//a:blip', NS)
            ext = child.find('.//wp:extent', NS)
            if blip is None:
                continue
            target = relmap.get(blip.get('{%s}embed' % NS['r']), '')
            name = Path(target).name
            w = int(ext.get('cx')) / EMU_PER_PT if ext is not None else None
            h = int(ext.get('cy')) / EMU_PER_PT if ext is not None else None
            size = f' width="{w:.1f}" height="{h:.1f}"' if w and h else ''
            parts.append(f'<img src="{html.escape(name)}"{size}/>')
    out = ''.join(parts)
    if not out:
        return ''
    va = rpr.find('w:vertAlign', NS) if rpr is not None else None
    if va is not None and va.get(W + 'val') == 'superscript':
        out = f'<sup>{out}</sup>'
    elif va is not None and va.get(W + 'val') == 'subscript':
        out = f'<sub>{out}</sub>'
    if on(rpr, 'u'):
        out = f'<u>{out}</u>'
    if on(rpr, 'i'):
        out = f'<i>{out}</i>'
    if on(rpr, 'b'):
        out = f'<b>{out}</b>'
    return out


def to_html(z):
    relmap = rels(z)
    body = ET.fromstring(z.read('word/document.xml')).find('w:body', NS)
    paras = []
    for p in body.iter(W + 'p'):
        inner = ''.join(run_html(r, relmap) for r in p.iter(W + 'r'))
        jc = p.find('w:pPr/w:jc', NS)
        align = jc.get(W + 'val') if jc is not None else ''
        style = ' style="text-align:center"' if align == 'center' else ''
        paras.append(f'<p{style}>{inner or "&#160;"}</p>')
    css = ('body { font-family: serif; font-size: 11pt; line-height: 1.35; }'
           ' p { margin: 0 0 5pt 0; } sup, sub { font-size: 8pt; }')
    return f'<html><head><style>{css}</style></head><body>{"".join(paras)}</body></html>'


def render(docx, out_pdf):
    z = zipfile.ZipFile(docx)
    with tempfile.TemporaryDirectory() as tmp:
        for n in z.namelist():
            if n.startswith('word/media/'):
                with z.open(n) as src, open(Path(tmp) / Path(n).name, 'wb') as dst:
                    shutil.copyfileobj(src, dst)
        story = pymupdf.Story(html=to_html(z), archive=pymupdf.Archive(tmp))
        mediabox = pymupdf.paper_rect('a4')
        where = mediabox + (54, 54, -54, -54)
        writer = pymupdf.DocumentWriter(str(out_pdf))
        more = True
        while more:
            dev = writer.begin_page(mediabox)
            more, _ = story.place(where)
            story.draw(dev)
            writer.end_page()
        writer.close()
    return pymupdf.open(out_pdf).page_count


if __name__ == '__main__':
    print(render(sys.argv[1], sys.argv[2]), 'pages')
