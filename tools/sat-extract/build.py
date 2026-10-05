"""Build the final dataset from the raw transcription records.

Raw records (OUT/out/...) stay exactly as the readers wrote them; everything
here is a pure function of them plus the source PDFs, so it can be re-run at
any time:
  - labels (section, domain, skill, difficulty) joined in from the index
  - answers normalized (a grid-in "30, -30" means either value is correct)
  - every figure cropped from the source page to a PNG next to the dataset

Usage: python3 build.py cb        -> OUT/dataset/cb.jsonl, OUT/dataset/figures/cb/*.png
       python3 build.py original  -> OUT/dataset/original.jsonl (originals that passed a blind solve)
"""

import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf

from common import CB_ROOT, DSAT_ROOT, OUT, read_json, read_jsonl, write_jsonl

FIG_DPI = 220   # figures are shown at up to ~360 px tall; 2x that keeps them crisp
PAD_PX = 4      # the reader's bbox is in rendered pixels; allow a little slack


def figures_of(rec):
    f = rec.get('figure')
    return f if isinstance(f, list) else [f] if f else []


def split_values(v):
    """'30, -30' -> ['30', '-30'];  '1,296' stays whole (a thousands separator)."""
    return [p.strip() for p in re.split(r',\s+|\s+or\s+', str(v)) if p.strip()]


ENTERABLE = re.compile(r'-?(\d+\.?\d*|\.\d+)(/\d+)?')


def enterable(value):
    """A grid-in value as a student would type it: no thousands separators, no
    units or degree signs. Returns None when the value cannot be typed at all
    (the source printed something like "36\u03c0")."""
    v = str(value).strip().replace('\u2212', '-').replace('\u00b0', '')
    v = re.sub(r'(\d),(?=\d{3}(?!\d))', r'\1', v)
    return v if ENTERABLE.fullmatch(v) else None


def normalize_answer(rec, flags):
    """Letter for multiple choice; for grid-in the first enterable value plus
    every accepted form, with anything a student could not type flagged."""
    if rec.get('answer_type') != 'grid-in':
        return rec.get('answer'), []
    raw = split_values(rec.get('answer') or '') + [x for acc in (rec.get('accepted') or []) for x in split_values(acc)]
    accepted = []
    for a in raw:
        e = enterable(a)
        if e is None:
            flags.append(f'grid-in-not-enterable: {a!r}')
        elif e not in accepted:
            accepted.append(e)
    return (accepted[0] if accepted else (raw[0] if raw else '')), accepted


def trim_rect(page, rect, probe_dpi=150, dark=170, speck=6, gap=3):
    """Shrink a crop past stray marks at its edges: a reader's bbox, padded,
    can catch the period of a choice label ("A.") or the end of a sentence next
    to the figure. An edge run of ink at most `speck` px wide, separated from
    the rest by at least `gap` px of white, is dropped (sizes at probe_dpi)."""
    pix = page.get_pixmap(matrix=pymupdf.Matrix(probe_dpi / 72, probe_dpi / 72), clip=rect,
                          colorspace=pymupdf.csGRAY)
    w, h, px = pix.width, pix.height, pix.samples
    if not w or not h:
        return rect
    # Whether each column / row holds any ink; slicing keeps this at C speed.
    cols = [min(px[x::w]) < dark for x in range(w)]
    rows = [min(px[y * w:(y + 1) * w]) < dark for y in range(h)]

    def keep(ink):
        groups, start = [], None
        for i, on in enumerate(ink + [False]):
            if on and start is None:
                start = i
            elif not on and start is not None:
                groups.append([start, i])
                start = None
        if not groups:
            return 0, len(ink)
        while len(groups) > 1 and groups[0][1] - groups[0][0] <= speck and groups[1][0] - groups[0][1] >= gap:
            groups.pop(0)
        while len(groups) > 1 and groups[-1][1] - groups[-1][0] <= speck and groups[-1][0] - groups[-2][1] >= gap:
            groups.pop()
        return groups[0][0], groups[-1][1]

    x0, x1 = keep(cols)
    y0, y1 = keep(rows)
    k, pad = 72 / probe_dpi, 4
    return pymupdf.Rect(rect.x0 + max(0, x0 - pad) * k, rect.y0 + max(0, y0 - pad) * k,
                        rect.x0 + min(w, x1 + pad) * k, rect.y0 + min(h, y1 + pad) * k)


def crop_figure(fig, images, pdf_path, out_path):
    """Crop a reader's figure bbox (pixels of one rendered image) from the PDF."""
    im = next((i for i in images if Path(i['path']).name == fig.get('image')), None)
    if im is None or not fig.get('bbox'):
        return None
    x0, y0, x1, y1 = fig['bbox']
    k = 72 / im['dpi']
    cx, cy = im['clip'][0], im['clip'][1]
    rect = pymupdf.Rect(cx + (x0 - PAD_PX) * k, cy + (y0 - PAD_PX) * k,
                        cx + (x1 + PAD_PX) * k, cy + (y1 + PAD_PX) * k)
    page = pymupdf.open(pdf_path)[im['page']]
    rect &= pymupdf.Rect(im['clip'])
    if rect.is_empty or rect.width < 8 or rect.height < 8:
        return None
    rect = trim_rect(page, rect)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(FIG_DPI / 72, FIG_DPI / 72), clip=rect)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pix.save(str(out_path))
    return {'width': pix.width, 'height': pix.height}


ROMAN = {'1': 'I', '2': 'II', '3': 'III', '4': 'IV'}


def restore_roman_labels(question, choices, flags):
    """The College Board export flattened Roman-numeral statement lists
    ("I.", "II.") into "1.", "2.", while the choices still say "I only" or
    "I and II". Put the numerals back so the choices refer to something."""
    refers = any(re.search(r'\b(I|II|III)\b', str(c)) for c in choices)
    lines = question.split('\n')
    numbered = [i for i, l in enumerate(lines) if re.match(r'^[1-4]\. ', l)]
    if not refers or len(numbered) < 2:
        return question
    for i in numbered:
        lines[i] = ROMAN[lines[i][0]] + lines[i][1:]
    flags.append('restored-numbering: statement labels 1., 2. restored to I., II. (the choices use Roman numerals)')
    return '\n'.join(lines)


def compose(parts, out_path, labels=None, columns=1):
    """Lay several figure PNGs out as one image (an item holds one figure).
    With labels, each part gets its letter above it, for figures that are the
    answer choices."""
    ims = [pymupdf.Pixmap(str(p)) for p in parts]
    gap, label_h = 24, (34 if labels else 0)
    rows = [ims[i:i + columns] for i in range(0, len(ims), columns)]
    col_w = [max((r[c].width for r in rows if c < len(r)), default=0) for c in range(columns)]
    width = sum(col_w) + gap * (columns - 1)
    heights = [max(im.height for im in r) + label_h for r in rows]
    height = sum(heights) + gap * (len(rows) - 1)
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    y = 0
    k = 0
    for r, h in zip(rows, heights):
        x = 0
        for c, im in enumerate(r):
            if labels:
                page.insert_text((x + 2, y + 24), labels[k], fontsize=24, fontname='hebo')
            page.insert_image(pymupdf.Rect(x, y + label_h, x + im.width, y + label_h + im.height), pixmap=im)
            x += col_w[c] + gap
            k += 1
        y += h + gap
    page.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False).save(str(out_path))


def question_asset(qid, figs, fig_dir, prefix):
    """One image for the question: its only figure, or a composition."""
    have = [f for f in figs if f.get('asset')]
    if not have:
        return None
    stem = [f for f in have if not f.get('choice')]
    choice = sorted((f for f in have if f.get('choice')), key=lambda f: f['choice'])
    if len(have) == 1 and not choice:
        return have[0]['asset']
    out = fig_dir / f'{qid}.png'
    parts = [OUT / 'dataset' / f['asset'] for f in stem]
    if choice:
        grid = fig_dir / f'{qid}-choices.png'
        compose([OUT / 'dataset' / f['asset'] for f in choice], grid,
                labels=[f['choice'] for f in choice], columns=2 if len(choice) == 4 else 1)
        parts.append(grid)
    compose(parts, out)
    return f'{prefix}/{qid}.png'


def build_cb():
    index = {q['id']: q for q in read_json(OUT / 'cb' / 'index.json')}
    render = read_json(OUT / 'cb' / 'render.json', {})
    fig_dir = OUT / 'dataset' / 'figures' / 'cb'
    rows, missing = [], []
    for qid, q in index.items():
        p = OUT / 'out' / 'cb' / f'{qid}.json'
        if not p.exists():
            missing.append(qid)
            continue
        rec = json.loads(p.read_text(encoding='utf8'))
        flags = list(rec.get('flags') or [])
        answer, accepted = normalize_answer(rec, flags)
        # A reviewer's verdict (SPEC.md, "Adjudication jobs") settles a question
        # the source left without a key, or whose key was disputed.
        adj = read_json(OUT / 'out' / 'adjudicate' / f'cb_{qid}.json')
        if adj:
            verdict = adj.get('verdict')
            rec = {**rec, **(adj.get('corrections') or {})} if verdict == 'transcription-error' else rec
            if verdict in ('key-wrong', 'transcription-error') and adj.get('answer'):
                flags = [f for f in flags if not f.startswith('source-error: no answer key')]
                flags.append(f"key-from-review: {'no key in the source' if answer is None else f'source key {answer}'}, "
                             f"reviewer's answer {adj['answer']}")
                answer = str(adj['answer']).strip()
                if rec.get('answer_type') == 'grid-in':
                    accepted = [e for e in (enterable(a) for a in (adj.get('accepted') or [answer])) if e]
                    answer = accepted[0] if accepted else answer
            elif verdict == 'ambiguous':
                flags.append(f"ambiguous: {adj.get('note', '')}")
        # The bank printed no rationale (its keyless questions): one written in
        # its style (SPEC.md, "Explanation-writing jobs") stands in, marked as such.
        rationale = rec.get('rationale') or ''
        if not rationale:
            written = read_json(OUT / 'out' / 'cb' / 'written' / f'cb_{qid}.json')
            if written and written.get('agrees') and written.get('rationale'):
                rationale = written['rationale']
                flags.append('explanation-written')
        figs = []
        for n, fig in enumerate(figures_of(rec), 1):
            name = f'{qid}-{n}.png'
            size = crop_figure(fig, render.get(qid, []), CB_ROOT / q['file'], fig_dir / name)
            figs.append({k: v for k, v in {
                'kind': fig.get('kind'),
                'choice': fig.get('choice'),
                'description': fig.get('description', ''),
                'table': fig.get('table'),
                'asset': f'figures/cb/{name}' if size else None,
                'size': size,
            }.items() if v is not None})
        asset = question_asset(qid, figs, fig_dir, 'figures/cb')
        rows.append({
            'uid': f'cb:{qid}',
            'collection': 'cb-bank',
            'source_id': qid,
            'section': q['section'],
            'domain': q['domain'],
            'skill': q['skill'],
            'difficulty': q['pdf_difficulty'] or q['folder_difficulty'],
            'passage': rec.get('passage') if q['section'] == 'rw' else None,
            'question': restore_roman_labels(rec.get('question') or '', rec.get('choices') or [], flags),
            'answer_type': rec.get('answer_type'),
            'choices': rec.get('choices') or [],
            'answer': answer,
            'accepted': accepted,
            'rationale': rationale,
            'figures': figs,
            'figure_asset': asset,
            'flags': flags,
            'check': rec.get('check'),
            'method': rec.get('method', 'vision'),
            'source': {'file': q['file'], 'pages': [r['page'] + 1 for r in q['regions']]},
        })
    write_jsonl(OUT / 'dataset' / 'cb.jsonl', rows)
    by = {}
    for r in rows:
        by[r['section']] = by.get(r['section'], 0) + 1
    print(f"{len(rows)} questions ({by}), {sum(len(r['figures']) for r in rows)} figures; "
          f'{len(missing)} still without a record', file=sys.stderr)
    return rows


# ---------------------------------------------------------------------------
# DSAT practice tests
# ---------------------------------------------------------------------------

FORMAT_COUNTS = {'33/27': {'rw': 33, 'math': 27}, '27/22': {'rw': 27, 'math': 22}}
OR_WORDS = re.compile(r'\s*(?:,(?!\d{3}(?!\d))|\bor\b|\ub610\ub294)\s*')  # ',' (not a thousands separator), 'or', Korean 'or'


def key_values(v):
    """A key entry as a list of accepted values: 'C', ['3', '3/10'], '5/2 or 2.5' (also in Korean)."""
    vals = v if isinstance(v, list) else [v]
    out = []
    for x in vals:
        for part in OR_WORDS.split(str(x or '')):
            part = part.strip()
            if part and part not in out:
                out.append(part)
    return out


def sequence_modules(records, test_format):
    """Assign (section, module) to one test's records in reading order.

    Numbering restarts at every module, and sections run Reading and Writing
    first, so a drop in the question number (or a change of section) opens the
    next module. A reader's own module label, when it read a heading, wins
    over the inference; disagreements are flagged. Books that number a whole
    section straight through (the Word conversions) are split in two at the
    format's module size afterwards."""
    per = FORMAT_COUNTS.get(test_format, {})
    out, cur_sec, cur_mod, last_num = [], None, 0, 0
    for r in records:
        sec = r.get('section')
        num = int(r.get('number') or 0)
        if sec != cur_sec:
            cur_sec, cur_mod, last_num = sec, 1, 0
        elif num < last_num:
            cur_mod += 1
        stated = r.get('module')
        mod = cur_mod
        if stated in (1, 2) and stated != cur_mod:
            r.setdefault('flags', []).append(f'module-conflict: reader saw module {stated}, numbering implies {cur_mod}')
            mod = stated
            cur_mod = stated
        last_num = num
        out.append((sec, mod, num, r))
    # Straight-through numbering: one "module" holding twice the module size.
    fixed = []
    for sec in ('rw', 'math'):
        items = [x for x in out if x[0] == sec]
        size = per.get(sec)
        mods = {m for _, m, _, _ in items}
        if size and mods == {1} and max((n for _, _, n, _ in items), default=0) > size:
            items = [(s, 1 if n <= size else 2, n if n <= size else n - size, r) for s, _, n, r in items]
        elif size:
            # A second module numbered on from the first (28-54 after 1-27) is
            # renumbered from 1, the way keys and explanations number it.
            second = [n for _, m, n, _ in items if m == 2]
            if second and min(second) > size:
                items = [(s, m, n - size if m == 2 else n, r) for s, m, n, r in items]
        fixed += items
    return fixed


def build_dsat():
    from dsat_sources import TESTS
    render = read_json(OUT / 'dsat' / 'render.json', {})
    by_name = {Path(im['path']).name + '|' + k.split('/')[0]: im for k, ims in render.items() for im in ims}
    fig_dir = OUT / 'dataset' / 'figures' / 'dsat'
    rows, tests = [], {}
    for test, spec in TESTS.items():
        if spec.get('duplicate_of'):
            tests[test] = {'duplicate_of': spec['duplicate_of'], 'note': spec.get('note', '')}
            continue
        tdir = OUT / 'out' / 'dsat' / f't{test:02d}'

        def load(prefix):
            recs = []
            for p in sorted(tdir.glob(f'{prefix}*-p*-q*.json')):
                r = json.loads(p.read_text(encoding='utf8'))
                name = p.stem.split('-p')[0]
                r['_order'] = (name, int(r.get('page') or 0), int(r.get('number') or 0))
                recs.append(r)
            recs.sort(key=lambda r: r['_order'])
            return recs

        book = sequence_modules(load('book'), spec.get('format'))
        explain = {(s, m, n): r for s, m, n, r in sequence_modules(load('explain'), spec.get('format'))}
        key_file = OUT / 'out' / 'dsat' / 'keys' / f't{test:02d}.json'
        key = {}
        if key_file.exists():
            kd = json.loads(key_file.read_text(encoding='utf8'))
            size = FORMAT_COUNTS.get(spec.get('format'), {})
            for m in kd.get('modules', []):
                for n, v in m.get('answers', {}).items():
                    n = int(n)
                    mod = m.get('module')
                    if mod is None and size.get(m['section']):   # one continuous list
                        mod, n = (1, n) if n <= size[m['section']] else (2, n - size[m['section']])
                    key[(m['section'], mod or 1, n)] = key_values(v)

        seen = {}
        for sec, mod, num, r in book:
            k = (sec, mod, num)
            if k in seen:   # read twice across a job boundary: keep the fuller reading
                if len(json.dumps(r)) <= len(json.dumps(seen[k])):
                    continue
            seen[k] = r
        test_rows = []
        for (sec, mod, num), r in sorted(seen.items(), key=lambda kv: (kv[0][0] != 'rw', kv[0][1], kv[0][2])):
            flags = list(r.get('flags') or [])
            ex = explain.get((sec, mod, num))
            keyed = key.get((sec, mod, num)) or (key_values(ex.get('answer')) if ex and ex.get('answer') else [])
            if not keyed:
                flags.append('no-key')
            is_grid = r.get('answer_type') == 'grid-in'
            answer = keyed[0] if keyed else None
            accepted = []
            if is_grid:
                for a in keyed + (ex.get('accepted') or [] if ex else []):
                    for x in key_values(a):
                        e = enterable(x)
                        if e is None:
                            flags.append(f'grid-in-not-enterable: {x!r}')
                        elif e not in accepted:
                            accepted.append(e)
                answer = accepted[0] if accepted else answer
            solved = key_values(r.get('solved_answer'))
            check = {'solved': r.get('solved_answer'), 'key': keyed or None}
            if keyed and solved:
                agree = same_answer(solved, keyed, is_grid)
                check['status'] = 'agree' if agree else 'disagree'
                if not agree:
                    flags.append(f'key-disagrees-with-solution: key {keyed}, solved {solved}')
            else:
                check['status'] = 'unchecked'
            if ex and keyed and ex.get('answer') and not same_answer(key_values(ex['answer']), keyed, is_grid):
                flags.append(f"key-disagrees-with-explanation: key {keyed}, explanation {ex['answer']}")
            uid = f'dsat:t{test:02d}:{sec}:m{mod}:q{num:02d}'
            # A reviewer's verdict on a disagreement (SPEC.md, "Adjudication jobs")
            # settles it: the flag that sent it to review is replaced by the outcome.
            adj = read_json(OUT / 'out' / 'adjudicate' / f"{uid.replace(':', '_')}.json")
            if adj:
                r = {**r, **(adj.get('corrections') or {})} if adj.get('verdict') == 'transcription-error' else r
                flags = [f for f in flags if not f.startswith('key-disagrees')]
                verdict = adj.get('verdict')
                check['adjudication'] = {'verdict': verdict, 'note': adj.get('note', '')}
                if verdict in ('key-wrong', 'transcription-error') and adj.get('answer'):
                    if verdict == 'key-wrong':
                        flags.append(f'key-corrected: source key {keyed}, corrected to {adj["answer"]}')
                    answer = str(adj['answer']).strip()
                    if is_grid:
                        accepted = [e for e in (enterable(a) for a in (adj.get('accepted') or [answer])) if e]
                        answer = accepted[0] if accepted else answer
                    check['status'] = 'agree'
                elif verdict == 'key-correct':
                    check['status'] = 'agree'
                    # A reviewer may list forms the key leaves out (151/6 beside
                    # the key's 25.16 and 25.17); the SAT accepts them too.
                    if is_grid:
                        for a in adj.get('accepted') or []:
                            e = enterable(a)
                            if e and e not in accepted:
                                accepted.append(e)
                elif verdict == 'ambiguous':
                    flags.append(f"ambiguous: {adj.get('note', '')}")
                    check['status'] = 'ambiguous'
            # The source gave no explanation: one written in the College Board's
            # style (SPEC.md, "Explanation-writing jobs") stands in, marked as such.
            rationale = (ex or {}).get('rationale') or r.get('rationale') or ''
            if not rationale:
                written = read_json(OUT / 'out' / 'dsat' / 'written' / f"{uid.replace(':', '_')}.json")
                if written and written.get('agrees') and written.get('rationale'):
                    rationale = written['rationale']
                    flags.append('explanation-written')
            figs = []
            for n, fig in enumerate(figures_of(r), 1):
                im = by_name.get(f"{fig.get('image')}|t{test:02d}")
                name = f'{uid.replace(":", "_")}-{n}.png'
                size = None
                if im:
                    src = Path(im['source'])
                    src = src if src.is_absolute() else DSAT_ROOT / src
                    size = crop_figure(fig, [im], src, fig_dir / name)
                figs.append({k: v for k, v in {
                    'kind': fig.get('kind'), 'choice': fig.get('choice'),
                    'description': fig.get('description', ''), 'table': fig.get('table'),
                    'asset': f'figures/dsat/{name}' if size else None, 'size': size,
                }.items() if v is not None})
            asset = question_asset(uid.replace(':', '_'), figs, fig_dir, 'figures/dsat')
            test_rows.append({
                'uid': uid, 'collection': 'dsat', 'test': test, 'section': sec, 'module': mod,
                'module_label': r.get('module_label'), 'number': num,
                'domain': r.get('domain'), 'skill': r.get('skill'), 'difficulty': r.get('difficulty'),
                'passage': r.get('passage') if sec == 'rw' else None,
                'question': r.get('question'), 'answer_type': r.get('answer_type'),
                'choices': r.get('choices') or [], 'answer': answer, 'accepted': accepted,
                'rationale': rationale,
                'figures': figs, 'figure_asset': asset, 'flags': flags, 'check': check,
                'source': {'file': spec['book'], 'page': r.get('page'), 'record': r.get('uid')},
            })
        counts = {}
        for x in test_rows:
            counts.setdefault(f"{x['section']}:m{x['module']}", 0)
            counts[f"{x['section']}:m{x['module']}"] += 1
        expected = FORMAT_COUNTS.get(spec.get('format'), {})
        tests[test] = {
            'format': spec.get('format'), 'note': spec.get('note', ''), 'counts': counts,
            'expected_per_module': expected,
            'key_entries': len(key), 'explained': len(explain),
            'disagreements': sum(1 for x in test_rows if x['check'].get('status') == 'disagree'),
        }
        rows += test_rows
    # The same question printed in two tests (Test 9 and the linear editions,
    # for instance) keeps one explanation: a copy without one borrows it.
    def identity(r):
        norm = lambda v: re.sub(r'[^a-z0-9]', '', str(v or '').lower())
        return norm(r.get('passage')) + '|' + norm(r.get('question')) + '|' + '|'.join(norm(c) for c in r.get('choices') or [])
    explained = {}
    for r in rows:
        if r.get('rationale'):
            explained.setdefault(identity(r), r['rationale'])
    for r in rows:
        if not r.get('rationale') and identity(r) in explained:
            r['rationale'] = explained[identity(r)]
            r['flags'] = [*r.get('flags', []), 'explanation-borrowed: the same question in another test']
    write_jsonl(OUT / 'dataset' / 'dsat.jsonl', rows)
    from common import write_json
    write_json(OUT / 'dataset' / 'dsat-tests.json', tests)
    print(f'{len(rows)} DSAT questions across {sum(1 for t in tests.values() if "counts" in t)} tests', file=sys.stderr)
    for t, info in tests.items():
        if 'counts' in info:
            print(f"  t{t:02d} {info['format']}: {info['counts']}  key={info['key_entries']} "
                  f"explained={info['explained']} disagree={info['disagreements']}", file=sys.stderr)
    return rows


LETTER_REF = re.compile(r'\b(?:[Cc]hoices?|[Oo]ptions?)\s*\(?[A-D]\)?(?![A-Za-z])')


def malformed(q):
    """Why an original question cannot be served, or None."""
    choices = q.get('choices') or []
    if q.get('section') not in ('rw', 'math') or not q.get('domain') or not q.get('skill'):
        return 'missing section, domain or skill'
    if q.get('difficulty') not in ('easy', 'medium', 'hard'):
        return f"difficulty {q.get('difficulty')!r}"
    if not (q.get('question') or '').strip():
        return 'no question'
    if len(choices) != 4 or len({str(c).strip() for c in choices}) != 4 or not all(str(c).strip() for c in choices):
        return 'needs four distinct choices'
    if q.get('answer') not in ('A', 'B', 'C', 'D'):
        return f"answer {q.get('answer')!r}"
    rationale = q.get('rationale')
    if not isinstance(rationale, dict) or not (rationale.get('correct') or '').strip():
        return 'no explanation for the correct answer'
    wrong = [letter for letter in 'ABCD' if letter != q['answer']]
    if any(not (rationale.get(letter) or '').strip() for letter in wrong):
        return 'a wrong choice has no explanation'
    # Choices are shuffled per student, so a letter in an explanation would
    # point at the wrong choice.
    if any(LETTER_REF.search(rationale.get(k) or '') for k in ('correct', *wrong)):
        return 'an explanation refers to a choice by letter'
    return None


def build_original():
    """Original questions that passed a blind solve: the writer's output
    (OUT/out/original/<name>.jsonl) joined with the verifiers' answers
    (<name>.verify-NN.jsonl). A question is kept only when the two agree.
    A verifier may write to <name>.blind-NN.jsonl first; the batch is read only
    once an editor has applied any fixes its notes call for and promoted that
    file to .verify-NN, so a batch still being written or edited is never read."""
    src_dir = OUT / 'out' / 'original'
    rows, report, pending = [], [], []
    for path in sorted(src_dir.glob('*.jsonl')):
        if '.verify-' in path.name or '.blind-' in path.name:
            continue
        name = path.stem
        checks = sorted(src_dir.glob(f'{name}.verify-*.jsonl'))
        if not checks:
            pending.append(name)
            continue
        blind = {}
        for check_file in checks:
            for line in read_jsonl(check_file):
                blind[line.get('index')] = line
        tally = {'written': 0, 'kept': 0, 'unverified': 0, 'dropped': []}
        for index, q in enumerate(read_jsonl(path)):
            tally['written'] += 1
            problem = malformed(q)
            if problem:
                tally['dropped'].append(f'{index}: {problem}')
                continue
            check = blind.get(index)
            if check is None:
                tally['unverified'] += 1
                continue
            if check.get('answer') != q['answer']:
                note = f": {check['note']}" if check.get('note') else ''
                tally['dropped'].append(f"{index} ({q['skill']}): key {q['answer']}, blind answer {check.get('answer')}{note}")
                continue
            tally['kept'] += 1
            rows.append({
                'uid': f'original:{name}:{index}', 'collection': 'original', 'job': name, 'index': index,
                'section': q['section'], 'domain': q['domain'], 'skill': q['skill'], 'difficulty': q['difficulty'],
                'passage': q.get('passage') if q['section'] == 'rw' else None,
                'question': q['question'], 'answer_type': 'multiple-choice',
                'choices': q['choices'], 'answer': q['answer'], 'accepted': [],
                'rationale': q['rationale'], 'figures': [], 'figure_asset': None, 'flags': [],
                'check': {'status': 'agree', 'blind': check.get('answer'), 'note': check.get('note') or ''},
            })
        report.append((name, tally))
    write_jsonl(OUT / 'dataset' / 'original.jsonl', rows)
    print(f'{len(rows)} original questions kept', file=sys.stderr)
    for name, t in report:
        print(f"  {name}: written {t['written']}, kept {t['kept']}, unverified {t['unverified']}, "
              f"dropped {len(t['dropped'])}", file=sys.stderr)
        for line in t['dropped']:
            print(f'    {line}', file=sys.stderr)
    if pending:
        print(f'  pending verification: {", ".join(pending)}', file=sys.stderr)
    return rows


def same_answer(given, keyed, is_grid):
    """Whether any of two lists of answers agree: letters exactly, grid-ins as numbers."""
    if any(g == k for g in given for k in keyed):
        return True
    if not is_grid:
        return False
    return any(_num(g) is not None and _num(k) is not None and abs(_num(g) - _num(k)) < 1e-6
               for g in given for k in keyed)


def _num(v):
    # Neither a thousands separator nor a degree sign is part of the value: key
    # "1,188" and solution "1188" agree, as do "27°" and "27".
    s = re.sub(r'(\d),(?=\d{3}(?!\d))', r'\1', str(v).strip().replace('\u2212', '-')).rstrip('\u00b0')
    m = re.fullmatch(r'(-?\d*\.?\d+)/(-?\d*\.?\d+)', s)
    try:
        return float(m.group(1)) / float(m.group(2)) if m else float(s)
    except (ValueError, ZeroDivisionError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('collection', choices=['cb', 'dsat', 'original'])
    args = ap.parse_args()
    {'cb': build_cb, 'dsat': build_dsat, 'original': build_original}[args.collection]()


if __name__ == '__main__':
    main()
