"""OCR every rendered DSAT page with Tesseract.

The OCR text is not a source of data: it is noisy, and it cannot read math. It
serves two purposes: finding where each module starts (module title pages have
distinctive text), and giving the validator an independent reading of the
prose to compare each transcription against.

Usage: python3 dsat_ocr.py   -> OUT/dsat/ocr/<image stem>.txt (skips pages already done)
"""

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import OUT, read_json


def ocr(im):
    path = Path(im['path'])
    out = OUT / 'dsat' / 'ocr' / f"{path.parent.name}-{path.stem}.txt"
    if out.exists():
        return 0
    res = subprocess.run(['tesseract', str(path), '-', '--dpi', str(int(im['dpi'])), '--psm', '3'],
                         capture_output=True, text=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(res.stdout, encoding='utf8')
    return 1


def main():
    manifest = read_json(OUT / 'dsat' / 'render.json')
    images = [im for v in manifest.values() for im in v]
    done = 0
    with ThreadPoolExecutor(6) as ex:
        for i, n in enumerate(ex.map(ocr, images), 1):
            done += n
            if i % 200 == 0:
                print(f'{i}/{len(images)}', file=sys.stderr, flush=True)
    print(f'{len(images)} pages, {done} newly read', file=sys.stderr)


if __name__ == '__main__':
    main()
