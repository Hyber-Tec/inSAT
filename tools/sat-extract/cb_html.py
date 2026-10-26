"""The College Board bank's own HTML (fetched by cb_api.py) as dataset records.

The bank serves a question as HTML: prose in paragraphs, math as MathML,
figures as inline SVG with a written description, tables as HTML tables. This
reads it into the record SPEC.md describes, in the conventions the
transcriptions follow, so a question from here and one transcribed from the PDF
export read the same: math in LaTeX (`\\( \\)`, a line of its own as `\\[ \\]`),
`<u>` for underlined text, `• ` notes, "Text 1" and "Text 2" lines, `______`
blanks, verse one line each, straight quotes, dashes as printed. Plain numbers
in prose stay text ("in 1995", "$5.25", "40%"), as a transcriber writes them.

The bank's markup is regular and small: the MathML of all 3,311 questions it
serves as HTML uses 15 elements, and anything else raises, so a new shape is
seen rather than silently mangled.
"""

import re
import unicodedata
from fractions import Fraction
from html.parser import HTMLParser

from cb_rw import clean, SUP, SUB

LETTERS = 'ABCD'

# ---------------------------------------------------------------------------
# A small DOM. html.parser leaves nesting as written (the bank puts figures
# inside paragraphs), which is what this needs; SVG is cut out first and kept
# verbatim, since the parser would lowercase its attribute names.
# ---------------------------------------------------------------------------

VOID = {'br', 'img', 'hr', 'col', 'wbr', 'input', 'meta', 'link', 'mspace', 'none', 'mprescripts'}


class Node:
    __slots__ = ('tag', 'attrs', 'children', 'parent')

    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs or {}), [], parent

    def cls(self):
        return set((self.attrs.get('class') or '').split())

    def style(self):
        return (self.attrs.get('style') or '').replace(' ', '').lower()

    def elements(self):
        return [c for c in self.children if isinstance(c, Node)]

    def text(self):
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children)

    def find(self, tag):
        for c in self.elements():
            if c.tag == tag:
                return c
            hit = c.find(tag)
            if hit:
                return hit
        return None


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.cur = Node('#root')

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent  # a stray end tag closes nothing

    def handle_data(self, data):
        self.cur.children.append(data)


SVG = re.compile(r'<svg\b[\s\S]*?</svg>', re.I)


def parse(html):
    """The DOM of an HTML fragment, and the SVG cut out of it (an <svgref n> stands in)."""
    svgs = []

    def cut(m):
        svgs.append(m.group(0))
        return f'<svgref n="{len(svgs) - 1}"></svgref>'

    b = _Builder()
    b.feed(SVG.sub(cut, html or ''))
    b.close()
    return b.root, svgs


# ---------------------------------------------------------------------------
# MathML to LaTeX
# ---------------------------------------------------------------------------

SYMBOL = {
    '\u2212': '-', '\u2013': '-', '\u00d7': r'\times', '\u00f7': r'\div', '\u00b7': r'\cdot', '\u22c5': r'\cdot',
    '\u2264': r'\le', '\u2265': r'\ge', '\u2260': r'\ne', '\u00b1': r'\pm', '\u2248': r'\approx', '\u223c': r'\sim',
    '\u2245': r'\cong', '\u2220': r'\angle', '\u25b3': r'\triangle', '\u2206': r'\Delta', '\u0394': r'\Delta',
    '\u22a5': r'\perp', '\u2225': r'\parallel', '\u2218': r'\circ', '\u2192': r'\to', '\u221e': r'\infty',
    '\u2026': r'\ldots', '\u2032': "'", '\u2033': "''", '%': r'\%', '$': r'\$', '{': r'\{', '}': r'\}',
    '<': '<', '>': '>', '\u03c0': r'\pi', '\u03b8': r'\theta', '\u03b1': r'\alpha', '\u03b2': r'\beta',
    '\u03bb': r'\lambda', '\u03bc': r'\mu', '\u03c3': r'\sigma', '\u03c1': r'\rho', '\u03c9': r'\omega',
    '\u03c6': r'\phi', '\u2113': r'\ell', '\U0001d4c1': r'\ell', '\u2061': '', '\u2062': '', '\u2063': '', '\u200a': '', '\u200b': '',
}
BINARY = {'+', '-', '=', '<', '>', r'\le', r'\ge', r'\ne', r'\approx', r'\times', r'\cdot', r'\div', r'\pm', r'\to', r'\sim', r'\cong', r'\parallel', r'\perp'}
FUNCTIONS = {'sin', 'cos', 'tan', 'log', 'ln'}
ACCENTS = {'\u00af': r'\overline', '\u203e': r'\overline', '_': r'\overline', '\u2192': r'\overrightarrow',
           '\u2194': r'\overleftrightarrow', '\u2322': r'\overset{\frown}', '\u23dc': r'\overset{\frown}'}
OPEN = {'(': '(', '[': '[', '{': r'\{', '|': '|', '': ''}
CLOSE = {')': ')', ']': ']', '}': r'\}', '|': '|', '': ''}


def _chars(s):
    """Symbols of a token as LaTeX; plain characters stay themselves."""
    s = unicodedata.normalize('NFC', s.replace('\xa0', ' '))
    return ''.join(SYMBOL.get(c, c) for c in s)


def _number(s):
    """A number as LaTeX: a thousands comma braced, so math mode does not space it."""
    s = s.replace('\xa0', '').replace(' ', '').replace('\u2212', '-')
    return re.sub(r'(?<=\d),(?=\d{3}(?!\d))', '{,}', s)


def _group(t):
    """`t` as a base or argument that takes a script: braced unless one token."""
    return t if re.fullmatch(r'\\[A-Za-z]+|[A-Za-z0-9.]|\d+(?:\.\d+)?|\(.*\)|\|.*\|', t) and _balanced(t) else '{' + t + '}'


def _balanced(t):
    depth = 0
    for i, c in enumerate(t):
        depth += c in '({'
        depth -= c in ')}'
        if depth == 0 and 0 < i < len(t) - 1 and t[0] == '(':
            return False  # "(a)(b)": the first parenthesis closes before the end
    return depth == 0


class Tex:
    """Tokens joined into readable LaTeX: binary operators spaced, a unary
    minus tight, a comma followed by a space, a command kept apart from a
    letter after it."""

    def __init__(self):
        self.parts = []  # (text, kind): kind 'op', 'open', 'close', 'comma', 'atom'

    def add(self, text, kind='atom'):
        if text:
            self.parts.append((text, kind))

    def str(self):
        out = ''
        prev = None
        bars = 0  # absolute-value bars written as single tokens: they open and close in turn
        for t, kind in self.parts:
            if t == '|' and kind == 'atom':
                kind = 'open' if bars % 2 == 0 else 'close'
                bars += 1
            if kind == 'op' and t in BINARY:
                unary = t in ('-', '+', r'\pm') and (prev is None or prev in ('op', 'open', 'comma'))
                if unary:
                    out = out + (' ' if prev == 'op' and not out.endswith(' ') else '') + t
                    prev = 'unary'
                    continue
                out = out.rstrip() + ' ' + t + ' '
            elif kind == 'comma':
                out = out.rstrip() + ', '
            else:
                if out and re.search(r'\\[A-Za-z]+$', out) and re.match(r'[A-Za-z0-9]', t):
                    out += ' '
                out += t
            prev = kind if kind != 'op' or t in BINARY else 'atom'
        return re.sub(r' {2,}', ' ', out)


EDGE_SPACE = re.compile(r'^(?:\\ |\s)+|(?:\\ |\s)+$')


def tex(node):
    """A MathML element (or <math>) as LaTeX, without delimiters."""
    t = Tex()
    _tex(node, t)
    # A space the bank typed at either end of an expression is not part of it.
    return EDGE_SPACE.sub('', t.str())


def edges(node):
    """The spaces a <math> carries at its start and end: the bank sometimes
    puts the space between a word and the math inside the math."""
    t = Tex()
    _tex(node, t)
    raw = t.str()
    return (' ' if re.match(r'\\ |\s', raw) else ''), (' ' if re.search(r'(?:\\ |\s)$', raw) else '')


def _tex(node, out):
    if isinstance(node, str):
        s = node.strip()
        if s:
            out.add(_chars(s))
        return
    tag = node.tag
    kids = node.elements()
    if tag in ('math', 'mrow', 'mstyle', 'mpadded', 'semantics'):
        for c in node.children:
            if isinstance(c, Node) and c.tag == 'annotation':
                continue
            _tex(c, out)
    elif tag == 'mi':
        s = node.text().strip().replace('\xa0', ' ')
        variant = node.attrs.get('mathvariant')
        if variant == 'script' and s == 'l':
            out.add(r'\ell')
        elif variant == 'script':
            out.add(r'\mathcal{' + s + '}')
        elif s in FUNCTIONS:
            out.add('\\' + s)
        elif len(s) > 1 and not re.fullmatch(r'[\u0370-\u03ff\u2113$]+', s):
            out.add(r'\text{' + s + '}')
        else:
            out.add(_chars(s))
    elif tag == 'mn':
        s = node.text().strip()
        if s:
            out.add(_number(s))
    elif tag == 'mo':
        s = node.text().replace('\xa0', ' ')
        if not s.strip():
            if s:
                out.add(r'\ ')
            return
        s = s.strip()
        sym = ''.join(SYMBOL.get(c, c) for c in s)
        if s == '\u00b0':
            out.add(r'^{\circ}')
        elif sym in BINARY:
            out.add(sym, 'op')
        elif s in ('(', '[', '{'):
            out.add(OPEN[s], 'open')
        elif s in (')', ']', '}'):
            out.add(CLOSE[s], 'close')
        elif s == ',':
            out.add(',', 'comma')
        else:
            out.add(sym, 'op' if sym.startswith('\\') else 'atom')
    elif tag == 'mtext':
        s = node.text().replace('\xa0', ' ')
        if s.strip() in FUNCTIONS:
            out.add('\\' + s.strip())
        elif s.strip():
            out.add(r'\text{' + s.replace('{', r'\{').replace('}', r'\}').replace('$', r'\$').replace('%', r'\%') + '}')
        elif s:
            out.add(r'\ ')
    elif tag == 'mspace':
        out.add(r'\ ')
    elif tag in ('msup', 'msub', 'msubsup'):
        if len(kids) != (3 if tag == 'msubsup' else 2):
            raise ValueError(f'{tag} with {len(kids)} children')
        base = _group(tex(kids[0]))
        if tag == 'msup':
            script = kids[1]
            st = tex(script).strip()
            if st in ("'", "''"):
                out.add(base + st)
            elif st in (r'\circ', '\u00b0', r'^{\circ}'):
                out.add(base + r'^{\circ}')
            else:
                out.add(base + '^{' + st + '}')
        elif tag == 'msub':
            out.add(base + '_{' + tex(kids[1]) + '}')
        else:
            out.add(base + '_{' + tex(kids[1]) + '}^{' + tex(kids[2]) + '}')
    elif tag == 'mfrac':
        if len(kids) != 2:
            raise ValueError(f'mfrac with {len(kids)} children')
        num, den = tex(kids[0]), tex(kids[1])
        if node.attrs.get('bevelled') == 'true':
            out.add(_group(num) + '/' + _group(den))
        else:
            out.add(r'\frac{' + num + '}{' + den + '}')
    elif tag == 'msqrt':
        out.add(r'\sqrt{' + _join(kids) + '}')
    elif tag == 'mroot':
        if len(kids) != 2:
            raise ValueError(f'mroot with {len(kids)} children')
        out.add(r'\sqrt[' + tex(kids[1]) + ']{' + tex(kids[0]) + '}')
    elif tag == 'mfenced':
        opening = node.attrs.get('open', '(')
        closing = node.attrs.get('close', ')')
        seps = re.sub(r'\s', '', node.attrs.get('separators', ','))
        out.add(OPEN.get(opening, opening), 'open')
        for i, k in enumerate(kids):
            if i:
                sep = seps[min(i - 1, len(seps) - 1)] if seps else ''
                if sep == ',':
                    out.add(',', 'comma')
                elif sep:
                    out.add(_chars(sep))
            _tex(k, out)
        out.add(CLOSE.get(closing, closing), 'close')
    elif tag == 'mover':
        if len(kids) != 2:
            raise ValueError(f'mover with {len(kids)} children')
        accent = kids[1].text().strip()
        cmd = ACCENTS.get(accent)
        if not cmd:
            raise ValueError(f'mover accent {accent!r}')
        out.add(cmd + '{' + tex(kids[0]) + '}')
    elif tag == 'menclose':
        notation = node.attrs.get('notation', '')
        inner = _join(kids)
        if notation == 'top':
            out.add(r'\overline{' + inner + '}')
        elif notation == 'radical':
            out.add(r'\sqrt{' + inner + '}')
        else:
            raise ValueError(f'menclose notation {notation!r}')
    else:
        raise ValueError(f'MathML element <{tag}>')


def _join(kids):
    t = Tex()
    for k in kids:
        _tex(k, t)
    return EDGE_SPACE.sub('', t.str())


# Math that is only a plain number in prose stays text, as transcribers write
# it: "in 1995", "$270", "40%", "0.55 million". A signed number, a variable or
# anything with an operator stays math.
PLAIN = re.compile(r'(?:\\\$)?(?:\d[\d{,}]*(?:\.\d+)?|\.\d+)(?:\\%)?')
# So does math that is only words, numbers and units: the bank sets "in
# degrees Fahrenheit (°F)", "67°F", "$63" and "4%" as MathML text.
TEXTUAL_MO = {'(', ')', '\u00b0', '%', '$', ''}


def textual(node):
    """The words of a <math> that holds only text, numbers, units, °, %, $ and parentheses, else None."""
    words = []

    def walk(n):
        if isinstance(n, str):
            if n.strip():
                raise ValueError
            return
        if n.tag in ('math', 'mrow', 'mstyle'):
            for c in n.children:
                walk(c)
        elif n.tag == 'mfenced' and n.attrs.get('open', '(') == '(' and n.attrs.get('close', ')') == ')':
            words.append(('mo', '('))
            for c in n.children:
                walk(c)
            words.append(('mo', ')'))
        elif n.tag in ('mn', 'mtext') or (n.tag == 'mo' and n.text().replace('\xa0', ' ').strip() in TEXTUAL_MO):
            words.append((n.tag, n.text().replace('\xa0', ' ')))
        elif n.tag == 'mspace':
            words.append(('mspace', ' '))
        else:
            raise ValueError

    try:
        walk(node)
    except ValueError:
        return None
    if not any(tag == 'mtext' and t.strip() for tag, t in words):
        return None  # "54°" stays math, as the transcriptions set a degree sign: 54^{\circ}
    return re.sub(r'\s+', ' ', ''.join(t for _, t in words)).strip()


def math_span(node):
    """An inline <math> as record text: `\\(...\\)`, or plain text where it is only that."""
    lead, trail = edges(node)
    words = textual(node)
    if words is not None:
        return lead + words + trail
    t = tex(node)
    if PLAIN.fullmatch(t) or t in ('\\$', '\\%'):
        return lead + t.replace('{,}', ',').replace('\\$', '$').replace('\\%', '%') + trail
    return f'{lead}\\({t}\\){trail}' if t else lead + trail


def aligned(rows):
    """Equations stacked as one system, aligned on their relation signs; None
    unless every row has one."""
    out = []
    for t in rows:
        depth = 0
        for i, c in enumerate(t):
            depth += c == '{'
            depth -= c == '}'
            if depth == 0 and re.match(r'=|<|>|\\(?:le|ge|ne)(?![A-Za-z])', t[i:]):
                out.append(t[:i].rstrip() + ' &' + t[i:])
                break
        else:
            return None
    return r'\begin{aligned} ' + r' \\ '.join(out) + r' \end{aligned}'


# ---------------------------------------------------------------------------
# HTML to the record's text
# ---------------------------------------------------------------------------

BLOCK = {'p', 'div', 'li', 'ul', 'ol', 'blockquote', 'figure', 'table', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
         'section', 'thead', 'tbody', 'tfoot', 'tr'}
ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI']


def hidden(node):
    """Text for a screen reader only: the word "blank" after a blank, a figure's long description."""
    return 'sr-only' in node.cls()


def inline(node, math_section=False):
    """An inline subtree as one line of record text."""
    if isinstance(node, str):
        # The bank sometimes types an apostrophe as a prime ("It′s").
        return re.sub(r'(?<=[A-Za-z])\u2032(?=[A-Za-z])', "'", re.sub(r'\s+', ' ', node))
    if hidden(node):
        return ''
    tag = node.tag
    if tag == 'math':
        return math_span(node)
    if tag == 'br':
        return '\n'
    if tag in ('sup', 'sub'):
        # Outside math a script is an isotope's mass or a formula's count
        # ("14C", "CO2"), set as the transcriptions set it: Unicode scripts.
        s = ''.join(inline(c, math_section) for c in node.children).strip()
        if s and all(c in '0123456789+-=()' for c in s):
            return s.translate(SUP if tag == 'sup' else SUB)
        return s
    body = ''.join(inline(c, math_section) for c in node.children)
    if tag in ('em', 'i') and math_section and re.fullmatch(r'\s*[A-Za-z]\s*', body):
        # A variable the bank set in italics rather than MathML ("the value of y").
        lead, letter, trail = re.match(r'(\s*)(\S)(\s*)$', body).groups()
        return f'{lead}\\({letter}\\){trail}'
    underlined = tag == 'u' or 'text-decoration:underline' in node.style()
    if underlined and body.strip():
        lead, core, trail = re.match(r'(\s*)(.*?)(\s*)$', body, re.S).groups()
        return f'{lead}<u>{core}</u>{trail}'
    return body


def tidy(text):
    """Lines of record text: the transcriptions' normalization, spaces tight
    inside <u>, and a word the bank typed against math ("\\(a\\)for") set
    apart, an ordinal ("the \\(n\\)th term") excepted."""
    lines = [clean(l) for l in text.split('\n')]
    text = '\n'.join(l for l in lines if l)
    text = re.sub(r'<u>\s+', '<u>', text)
    text = re.sub(r'\s+</u>', '</u>', text)
    text = re.sub(r'\\\)(?=[A-Za-z])(?!(?:th|st|nd|rd)\b)', r'\\) ', text)
    return re.sub(r'(?<=[A-Za-z])\\\(', r' \\(', text)


def equations(node):
    """The equations of a paragraph that holds nothing but math, one per line
    (a <br> starts the next), else None."""
    lines = [[]]

    def walk(n):
        for c in n.children:
            if isinstance(c, str):
                if c.strip():
                    raise ValueError
            elif c.tag == 'math':
                lines[-1].append(c)
            elif c.tag == 'br':
                lines.append([])
            elif not hidden(c):
                if c.tag in ('svgref', 'figure', 'table'):
                    raise ValueError
                walk(c)

    try:
        walk(node)
    except ValueError:
        return None
    return [line for line in lines if line and any(tex(m) for m in line)] or None


class Blocks:
    """A fragment read in order into lines (text, or an equation set on its
    own line) and figures."""

    def __init__(self, svgs, math_section=False):
        self.svgs = svgs
        self.math_section = math_section
        self.entries = []  # ('text', line) | ('eq', the <math> elements of one equation)
        self.figures = []
        self._buf = []

    def flush(self):
        text = tidy(''.join(self._buf))
        self._buf = []
        self.entries.extend(('text', line) for line in text.split('\n') if line)

    def walk(self, node):
        if isinstance(node, str):
            self._buf.append(inline(node))
            return
        tag = node.tag
        if hidden(node):
            return
        if tag == 'svgref':
            self.flush()
            self.figures.append(svg_figure(self.svgs[int(node.attrs['n'])], node.parent))
            return
        if tag in ('figure', 'table'):
            self.flush()
            table = node if tag == 'table' else node.find('table')
            if table is not None:
                self.figures.append(table_figure(table, self.math_section))
            else:
                for c in node.children:
                    self.walk(c)
            return
        if tag == 'math':
            self._buf.append(math_span(node))
            return
        if tag == 'span' and node.attrs.get('role') == 'heading':
            # "Text 1" / "Text 2" of a pair of passages: a line of its own.
            self.flush()
            self._buf.append(node.text())
            self.flush()
            return
        if tag not in BLOCK:
            if any(isinstance(c, Node) and (c.tag in BLOCK or c.tag == 'svgref') for c in node.children):
                for c in node.children:
                    self.walk(c)
            else:
                self._buf.append(inline(node, self.math_section))
            return
        self.flush()
        if tag in ('p', 'div'):
            eqs = equations(node)
            if eqs:
                self.entries.extend(('eq', e) for e in eqs)
                return
        if tag in ('ul', 'ol'):
            roman = tag == 'ol' and 'upper-roman' in node.style()
            items = [c for c in node.elements() if c.tag == 'li']
            for i, li in enumerate(items):
                before = len(self.entries)
                for c in li.children:
                    self.walk(c)
                self.flush()
                if len(self.entries) > before and self.entries[before][0] == 'text':
                    mark = f'{ROMAN[i]}. ' if roman else f'{i + 1}. ' if tag == 'ol' else '\u2022 '
                    self.entries[before] = ('text', mark + self.entries[before][1])
            return
        for c in node.children:
            self.walk(c)
        self.flush()

    def lines(self, display=True):
        """The lines as record text. Consecutive equations are one system,
        aligned on their relation signs; `display` sets an equation on its own
        line (`\\[ \\]`), else inline (a choice, a table cell)."""
        self.flush()
        out = []
        i = 0
        while i < len(self.entries):
            kind, value = self.entries[i]
            if kind == 'text':
                out.append(value)
                i += 1
                continue
            j = i
            while j < len(self.entries) and self.entries[j][0] == 'eq':
                j += 1
            group = [v for _, v in self.entries[i:j]]
            if not display and len(group) == 1 and len(group[0]) == 1:
                out.append(math_span(group[0][0]))  # a choice that is a number, a price or a percent stays text
                i = j
                continue
            texs = [' '.join(t for t in (tex(m) for m in nodes) if t) for nodes in group]
            system = aligned(texs) if len(texs) > 1 else None
            for t in [system] if system else texs:
                out.append(f'\\[ {t} \\]' if display else f'\\({t}\\)')
            i = j
        return out


def read(html, math_section=False, display=True):
    """(lines, figures) of an HTML fragment."""
    root, svgs = parse(html)
    b = Blocks(svgs, math_section)
    b.walk(root)
    return b.lines(display), b.figures


def paragraphs(html, math_section=False):
    """An explanation's paragraphs: each block of the fragment one paragraph."""
    root, svgs = parse(html)
    out = []
    run = []

    def emit(nodes):
        b = Blocks(svgs, math_section)
        for n in nodes:
            b.walk(n)
        text = '\n'.join(b.lines())
        if text:
            out.append(text)

    for c in root.children:
        if isinstance(c, Node) and c.tag in BLOCK:
            if run:
                emit(run)
                run = []
            emit([c])
        else:
            run.append(c)
    if run:
        emit(run)
    return out


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------

GRAPH_WORDS = re.compile(r'\b(graph|scatterplot|histogram|dot plot|box plot|bar graph|line graph|plane|axis|number line)\b', re.I)


def svg_figure(svg, parent):
    """An SVG figure: the markup as served, and the description the bank wrote
    for it (its label and, where it has one, the long description beside it)."""
    label = re.search(r'aria-label="([^"]*)"', svg[:svg.find('>') + 1])
    title = re.search(r'<title[^>]*>([\s\S]*?)</title>', svg)
    short = clean(label.group(1)) if label else clean(re.sub(r'<[^>]+>', '', title.group(1))) if title else ''
    short = re.sub(r'\s*Refer to (?:the )?long description\.?', '', short).strip()
    long = []
    figure = parent
    while figure is not None and figure.tag != 'figure':
        figure = figure.parent
    if figure is not None:
        for c in figure.elements():
            if hidden(c):
                long.append(' '.join(l for l in tidy(_words(c)).split('\n') if l))
    description = ' '.join(x for x in [short, *long] if x)
    return {'kind': 'graph' if GRAPH_WORDS.search(description) else 'diagram', 'svg': svg,
            'label': short, 'description': description, 'table': None}


def _words(node):
    """Every word of a subtree, screen-reader text included, a line per list item."""
    if isinstance(node, str):
        return re.sub(r'\s+', ' ', node)
    if node.tag == 'math':
        return math_span(node)
    inner = ''.join(_words(c) for c in node.children)
    return f'\n{inner}' if node.tag in ('li', 'p') else inner


def table_figure(table, math_section=False):
    """A table as SPEC.md's structured cells (spans kept), its caption as the title."""
    caption = table.find('caption')
    title = None
    if caption is not None:
        b = Blocks([], math_section)
        for c in caption.children:
            b.walk(c)
        title = ' '.join(b.lines(display=False)) or None
    head_rows = 0
    rows = []
    for part in [c for c in table.elements() if c.tag in ('thead', 'tbody', 'tfoot', 'tr')]:
        trs = [part] if part.tag == 'tr' else [c for c in part.elements() if c.tag == 'tr']
        for tr in trs:
            cells = []
            for cell in [c for c in tr.elements() if c.tag in ('td', 'th')]:
                b = Blocks([], math_section)
                for c in cell.children:
                    b.walk(c)
                text = ' '.join(b.lines(display=False))
                span = {k: int(cell.attrs[k]) for k in ('colspan', 'rowspan')
                        if str(cell.attrs.get(k, '')).isdigit() and int(cell.attrs[k]) > 1}
                cells.append({'text': text, **span} if span else text)
            rows.append(cells)
            if part.tag == 'thead':
                head_rows += 1
    flat = '; '.join(', '.join(c['text'] if isinstance(c, dict) else c for c in r) for r in rows)
    return {'kind': 'table', 'svg': None, 'label': None, 'description': (f'Table titled {title}. ' if title else 'Table. ') + flat,
            'table': {'title': title, 'header_rows': head_rows, 'rows': rows}}


def table_text(table):
    """A table as a choice's text: its rows, cell by cell."""
    return '; '.join(', '.join(c['text'] if isinstance(c, dict) else c for c in r) for r in table['rows'])


# ---------------------------------------------------------------------------
# Grid-in answers
# ---------------------------------------------------------------------------

ENTRY = re.compile(r'(-?)(\d*\.?\d+)(?:/(\d*\.?\d+))?')


def value(entry):
    """The exact value of a grid-in entry ("7/6", "-.25", "1,296"), or None."""
    m = ENTRY.fullmatch(str(entry).strip().replace('\u2212', '-').replace(',', ''))
    if not m:
        return None
    v = Fraction(m.group(2))
    if m.group(3):
        if not Fraction(m.group(3)):
            return None
        v /= Fraction(m.group(3))
    return -v if m.group(1) else v


def as_entry(text):
    """Explanation text naming one value ("\\(\\frac{7}{6}\\)", "-.25", "1,296") as an entry, or None."""
    t = re.sub(r'\\[()\[\]]', '', text).strip().rstrip('.')
    m = re.fullmatch(r'(-?)\\frac\{(\d+)\}\{(\d+)\}', t)
    if m:
        t = f'{m.group(1)}{m.group(2)}/{m.group(3)}'
    t = t.replace('{,}', ',').replace(',', '')
    return t if value(t) is not None else None


def consistent(entry, exact):
    """Whether an entry is one of the bank's answers: equal to a fraction, or a
    decimal rounded or cut short from it."""
    v = value(entry)
    if v is None:
        return False
    if '/' in entry or '.' not in entry:
        return any(v == x for x in exact)
    step = Fraction(1, 10 ** len(entry.split('.')[1]))
    return any(abs(v - x) < step for x in exact)


NOTE = re.compile(r'Note that (.+?) (?:are|is) (?:examples? of )?(?:ways?|the only ways?) to enter (?:a|the) correct answer')
STATED = re.compile(r'The correct answer is (\\\(.+?\\\)|\S+)')


def grid_answer(listed, rationale, flags):
    """A grid-in's answer and every entry that scores: the bank's own list, and
    the forms its explanation names ("Note that 7/6, 1.166, and 1.167 are
    examples of ways to enter a correct answer"), each checked against the
    bank's values (an explanation's typo is flagged, not accepted). The answer
    shown is the one the explanation states."""
    exact = [v for v in (value(a) for a in listed) if v is not None]
    accepted = [a.replace(',', '') for a in listed]
    note = NOTE.search(rationale)
    if note:
        for part in re.split(r',\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+', note.group(1)):
            entry = as_entry(part)
            if entry is None or entry in accepted:
                continue
            if consistent(entry, exact):
                accepted.append(entry)
            else:
                flags.append(f'source-error: the explanation lists {entry} among the ways to enter the answer; left out')
    stated = STATED.search(rationale)
    entry = as_entry(stated.group(1)) if stated else None
    answer = next((a for a in accepted if entry is not None and value(a) == value(entry) and a == entry), None) \
        or next((a for a in accepted if entry is not None and value(a) == value(entry)), None) or accepted[0]
    return answer, [answer] + [a for a in accepted if a != answer]


# ---------------------------------------------------------------------------
# One question
# ---------------------------------------------------------------------------

def record(qid, item, section):
    """The bank's question `item` (get-question's answer) as a SPEC.md record."""
    math = section == 'math'
    flags = []
    stim_lines, stim_figs = read(item.get('stimulus') or '', math)
    stem_lines, stem_figs = read(item.get('stem') or '', math)
    rationale = '\n\n'.join(paragraphs(item.get('rationale') or '', math))
    figures = stim_figs + stem_figs
    choices = []
    if item.get('type') == 'mcq':
        options = item.get('answerOptions') or []
        if len(options) != 4:
            raise ValueError(f'{len(options)} options')
        for letter, opt in zip(LETTERS, options):
            lines, figs = read(opt.get('content') or '', math, display=False)
            if figs:
                if len(figs) != 1 or lines:
                    raise ValueError('a choice with text and a figure')
                fig = {**figs[0], 'choice': letter}
                figures.append(fig)
                lines = [table_text(fig['table']) if fig['table'] else fig['label'] or fig['description']]
            choices.append(' '.join(lines))
        key = (item.get('correct_answer') or [None])[0]
        keyed = [LETTERS[i] for i, o in enumerate(options) if o.get('id') in (item.get('keys') or [])]
        if key not in LETTERS or keyed != [key]:
            raise ValueError(f'key {key!r} against option ids {keyed}')
        drawn = [f for f in figures if f.get('choice') and f['svg']]
        if drawn and len({choices[LETTERS.index(f['choice'])] for f in drawn}) < len(drawn):
            # The bank's labels do not tell the graphs apart ("Graph of a
            # system of 2 lines ..." four times): a choice names its graph in
            # the picture of them, labeled A to D in this order.
            for f in drawn:
                choices[LETTERS.index(f['choice'])] = f"{'Graph' if f['kind'] == 'graph' else 'Figure'} {f['choice']}"
        if any(f.get('choice') for f in figures):
            flags.append('figure-in-choices')
        answer, accepted, answer_type = key, [], 'multiple-choice'
    elif item.get('type') == 'spr':
        listed = [str(a).strip() for a in item.get('correct_answer') or [] if str(a).strip()]
        if not listed or any(value(a) is None for a in listed):
            raise ValueError(f'grid-in answers {listed}')
        answer, accepted = grid_answer(listed, rationale, flags)
        answer_type = 'grid-in'
    else:
        raise ValueError(f"question type {item.get('type')!r}")
    question = stem_lines
    passage = stim_lines
    if math:  # a math question has no passage: what it reads before the stem is part of the question
        question, passage = stim_lines + stem_lines, []
    return {
        'uid': f'cb:{qid}',
        'passage': '\n'.join(passage) or None,
        'question': '\n'.join(question),
        'answer_type': answer_type,
        'choices': choices,
        'answer': answer,
        'accepted': accepted,
        'rationale': rationale,
        'figure': figures or None,
        'check': {'status': 'source', 'note': "the College Board's own key and explanation, from its question bank"},
        'flags': flags,
        'method': 'html',
    }
