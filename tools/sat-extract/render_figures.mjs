// Draws the figures of questions taken from the College Board bank's own HTML
// (cb_html.py) as PNG images, which is how the app shows a figure: an SVG
// figure as the bank serves it, a table from its cells, its math set by KaTeX
// as the app sets it (web/src/MathText.jsx), in the app's serif.
//
// Usage: node render_figures.mjs <manifest.json>
//   the manifest: [{ "out": "/path/figure.png", "svg": "<svg ...>" } | { "out": ..., "table": {title, header_rows, rows} }, ...]
// Prints one JSON line per figure: { out, width, height } or { out, error }.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const katex = require('katex');
const { chromium } = require('playwright');

const SCALE = 2; // device pixels per CSS pixel: as crisp as the figures cropped from the PDFs
const asset = (p) => pathToFileURL(require.resolve(p)).href;

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Record text (math in \( \)) as HTML, the math rendered by KaTeX. */
function rich(text) {
  return String(text).split(/(\\\([\s\S]*?\\\))/).map((part, i) => (i % 2
    ? katex.renderToString(part.slice(2, -2), { throwOnError: true, strict: 'ignore' })
    : escape(part))).join('');
}

function tableHtml(table) {
  const head = table.header_rows || 0;
  const rows = table.rows.map((row, r) => `<tr>${row.map((cell) => {
    const c = typeof cell === 'string' ? { text: cell } : cell;
    const tag = r < head ? 'th' : 'td';
    const span = `${c.colspan ? ` colspan="${c.colspan}"` : ''}${c.rowspan ? ` rowspan="${c.rowspan}"` : ''}`;
    return `<${tag}${span}>${rich(c.text)}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table>${table.title ? `<caption>${rich(table.title)}</caption>` : ''}${rows}</table>`;
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${asset('katex/dist/katex.min.css')}">
<link rel="stylesheet" href="${asset('@fontsource-variable/source-serif-4/index.css')}">
<style>
  html, body { margin: 0; background: #fff; }
  #figure { display: inline-block; padding: 12px; background: #fff; color: #000;
            font: 17px/1.35 'Source Serif 4 Variable', Georgia, serif; font-variant-numeric: lining-nums; }
  table { border-collapse: collapse; }
  caption { font-weight: 600; padding: 0 0 8px; }
  th, td { border: 1px solid #000; padding: 6px 12px; text-align: center; vertical-align: middle; }
  th { font-weight: 600; }
  svg { display: block; }
</style></head><body><div id="figure">${body}</div></body></html>`;

async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const tab = await browser.newPage({ deviceScaleFactor: SCALE });
  // The page is loaded from a file, so its stylesheets and fonts (local files) load with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figures-'));
  const file = path.join(dir, 'figure.html');
  try {
    for (const fig of manifest) {
      try {
        // An SVG is placed in the HTML as served, where the HTML parser
        // restores the case of its attributes (the bank writes `viewbox`).
        const body = fig.svg ? fig.svg : tableHtml(fig.table);
        fs.writeFileSync(file, page(body));
        await tab.goto(pathToFileURL(file).href, { waitUntil: 'load' });
        await tab.evaluate(() => document.fonts.ready);
        const box = await tab.$('#figure');
        await box.screenshot({ path: fig.out });
        const { width, height } = await box.boundingBox();
        console.log(JSON.stringify({ out: fig.out, width: Math.round(width * SCALE), height: Math.round(height * SCALE) }));
      } catch (err) {
        console.log(JSON.stringify({ out: fig.out, error: err.message.split('\n')[0] }));
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
