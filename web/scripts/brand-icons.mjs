// Every icon of the app, drawn from the insat app icon in
// public/insat-app-icon.svg (the logo kit as delivered is in brand/): the PNG
// favicon, the iOS home-screen icon (full bleed, since iOS rounds it itself),
// and the desktop app's icon set (the tile at 824 of 1024, Apple's icon grid,
// cut into every size by the Tauri CLI). Run it after changing the icon.
//
//   From client: npm run brand:icons

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const mark = fs.readFileSync(path.join(root, 'public/insat-app-icon.svg'), 'utf8');
const src = `data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`;
const tile = /<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(mark)[1];

const browser = await chromium.launch();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insat-icons-'));

/** The mark as a size x size PNG, `inset` px in from each edge, over `background`. */
async function render(file, size, { inset = 0, background = 'transparent' } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const side = size - 2 * inset;
  await page.setContent(`<body style="margin:0;background:${background}"><img src="${src}" width="${side}" height="${side}" style="display:block;margin:${inset}px"></body>`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: file, omitBackground: background === 'transparent' });
  await page.close();
}

try {
  await render(path.join(root, 'public/insat.png'), 512);
  await render(path.join(root, 'public/apple-touch-icon.png'), 180, { background: tile });

  const source = path.join(tmp, 'app-icon.png');
  await render(source, 1024, { inset: 100 });
  execFileSync('npx', ['tauri', 'icon', source, '-o', path.join(tmp, 'icons')], { cwd: root, stdio: 'ignore' });
  // Replace the icons the app ships, leaving out the platforms it has no project for.
  const icons = path.join(root, 'src-tauri/icons');
  const replaced = fs.readdirSync(icons).filter((name) => fs.existsSync(path.join(tmp, 'icons', name)));
  for (const name of replaced) fs.copyFileSync(path.join(tmp, 'icons', name), path.join(icons, name));
  console.log(`public/insat.png, public/apple-touch-icon.png, ${replaced.length} desktop icons`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
