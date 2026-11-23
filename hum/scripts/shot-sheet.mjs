#!/usr/bin/env node
/**
 * Render the shot prototype (/shot.html, see src/dev/shot.ts) in a headless browser and save a
 * contact sheet of stills, so it can be checked without opening the page.
 *
 *   node scripts/shot-sheet.mjs --out /path/sheet.png
 *
 * Options
 *   --at 0.5,3,5.2,...          seconds into the run of shots (default: a tour of every shot)
 *   --strip 5.1,0.05,8          8 frames from 5.1 s, 0.05 s apart (to check motion across a cut)
 *   --clip /footage.local/a.mp4,/footage.local/b.mp4   clips the dev server can serve
 *   --words "LOUDER THAN THE DARK"   --look <id>   --at-song 42.5
 *   --style poster  --seed 3  --colour flat   the footage style, its arrangement and its colour
 *   --treatment mosh            how the picture is broken down (none, mosh, sort, cells, readout, collage, auto)
 *   --photo /footage.local/p.jpg,...   photos as stills   --zoom 1.4   push the picture in
 *   --hash 5,1,3,5               checksums of the frames at these times, drawn in that order (seek check)
 *   --size 720x1280             picture size (default 9:16)
 *   --cols 6  --cell 300        sheet layout
 *   --port 5178                 the dev server's port
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const port = opt('port', '5178');
const [w, h] = opt('size', '720x1280').split('x').map(Number);
const qs = new URLSearchParams({ w: String(w), h: String(h) });
for (const [k, name] of [['clip', 'clip'], ['words', 'words'], ['look', 'look'], ['style', 'style'], ['seed', 'seed'], ['colour', 'colour'], ['at-song', 'at'], ['treatment', 'treatment'], ['photo', 'photo'], ['zoom', 'zoom']]) if (opt(k)) qs.set(name, opt(k));
const out = opt('out', `${process.cwd()}/shot-sheet.png`);
const cols = Number(opt('cols', '6'));
const cell = Number(opt('cell', '300'));

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('This script needs playwright-core. Install it once with:  npm i --no-save playwright-core');
  process.exit(2);
}
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 700)}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  // no hot reload: someone may be saving files in this checkout while the sheet renders
  await page.route('**/@vite/client', (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `
        export function createHotContext() { return { accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, on() {}, off() {}, send() {}, data: {} }; }
        const sheets = new Map();
        export function updateStyle(id, css) { let s = sheets.get(id); if (!s) { s = document.createElement('style'); s.setAttribute('data-vite-dev-id', id); document.head.appendChild(s); sheets.set(id, s); } s.textContent = css; }
        export function removeStyle(id) { const s = sheets.get(id); if (s) { s.remove(); sheets.delete(id); } }
        export function injectQuery(url) { return url; }
        export class ErrorOverlay {}
      `,
    }),
  );
  await page.goto(`http://localhost:${port}/shot.html?${qs}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__shot, null, { timeout: 60000 });
  const ready = await page.evaluate(() => window.__shot.ready);
  if (!ready.ok) {
    console.error(`BOOT FAILED: ${ready.error}`);
    if (logs.length) console.error(logs.slice(0, 12).join('\n'));
    process.exit(1);
  }
  const info = await page.evaluate(() => window.__shot.info());
  let times;
  if (opt('strip')) {
    const [t0, dt, n] = opt('strip').split(',').map(Number);
    times = Array.from({ length: n }, (_, i) => Math.round((t0 + i * dt) * 1000) / 1000);
  } else if (opt('at')) {
    times = opt('at').split(',').map(Number);
  } else {
    // a tour: a few moments from every shot, more of them just after it starts
    times = info.shots.flatMap((s) => [0.04, 0.2, 0.45, 0.7, 0.93].map((f) => Math.round((s.from + (s.to - s.from) * f) * 100) / 100));
  }
  if (opt('hash')) {
    const hs = await page.evaluate((ts) => window.__shot.hashes(ts), opt('hash').split(',').map(Number));
    console.log(JSON.stringify(hs));
    await browser.close();
    process.exit(0);
  }
  const t0 = Date.now();
  const url = await page.evaluate((o) => window.__shot.shots(o.times, o.cols, o.cell), { times, cols, cell });
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  const after = await page.evaluate(() => window.__shot.info());
  console.log(`${w}x${h} · ${times.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${out}`);
  console.log(`run ${info.length.toFixed(1)} s · shots: ${info.shots.map((s) => `${s.kind} ${s.from}–${s.to}${s.flip ? ' (mirrored)' : ''}`).join(' | ')}`);
  if (after.errors.length) console.log('ERRORS\n' + after.errors.join('\n'));
  if (logs.length) console.log('CONSOLE\n' + [...new Set(logs)].slice(0, 12).join('\n'));
  if (!after.errors.length && !logs.length) console.log('no errors');
} finally {
  await browser.close();
}
