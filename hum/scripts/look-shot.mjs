#!/usr/bin/env node
/**
 * Render a Hum scene against the scripted test song in a headless browser and save a contact sheet.
 *
 *   node scripts/look-shot.mjs --mod /src/scenes/shader/foo.ts --export foo --out /path/sheet.png
 *   node scripts/look-shot.mjs --scene liquid-marble            (a registered scene)
 *   node scripts/look-shot.mjs --preset marble-dream            (a built-in look)
 *
 * Options
 *   --at 4,14,28,32.1,33,40     song times to capture (default: a tour of the song)
 *   --strip 32,0.05,9           9 frames from 32 s, 0.05 s apart (to check motion on a hit)
 *   --from 24                   start the scene at 24 s instead of 0 (faster for late moments)
 *   --portrait                  720x1280 instead of 1280x720;  --size 1080x1080 for anything else
 *   --look file.json            { palette: "<id>" | {bg,fg,accent,accent2,muted}, sceneParams, effects, modulations }
 *   --cols 3  --cell 560        sheet layout
 *   --port 5173                 the dev server's port
 *
 * Test song (120 bpm): 0-8 intro (quiet) · 8-24 verse · 24-32 build · 32 DROP · 32-48 chorus · 48-56 break · 56-64 outro
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const flag = (k) => args.includes(`--${k}`);

const port = opt('port', '5173');
const size = flag('portrait') ? '720x1280' : opt('size', '1280x720');
const [w, h] = size.split('x').map(Number);
const qs = new URLSearchParams({ w: String(w), h: String(h) });
for (const k of ['mod', 'export', 'scene', 'preset', 'windows']) if (opt(k)) qs.set(k, opt(k));
if (opt('look')) qs.set('look', readFileSync(opt('look'), 'utf8'));
if (!opt('mod') && !opt('scene') && !opt('preset')) {
  console.error('need --mod <path> [--export name], --scene <id> or --preset <id>');
  process.exit(2);
}

let times = (opt('at', '3,10,16.02,22,28,31.5,32.06,32.6,36,44.02,52,60')).split(',').map(Number);
if (opt('strip')) {
  const [t0, dt, n] = opt('strip').split(',').map(Number);
  times = Array.from({ length: n }, (_, i) => Math.round((t0 + i * dt) * 1000) / 1000);
}
const out = opt('out', `${process.cwd()}/sheet.png`);

// playwright-core drives your installed Chrome; it is not a dependency of the app
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('This script needs playwright-core. Install it once with:  npm i -D playwright-core');
  process.exit(2);
}
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'],
});
try {
  const page = await browser.newPage({ viewport: { width: Math.min(w, 1600), height: Math.min(h, 1400) }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 700)}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  // No hot reload in this page: other people are saving files in the same checkout, and the dev
  // server would reload us mid-render. Serve a do-nothing stand-in for Vite's client.
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
  await page.goto(`http://localhost:${port}/solo.html?${qs}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__solo, null, { timeout: 60000 });
  const ready = await page.evaluate(() => window.__solo.ready);
  if (!ready.ok) {
    console.error('BOOT FAILED\n' + ready.errors.join('\n'));
    if (logs.length) console.error(logs.slice(0, 12).join('\n'));
    process.exit(1);
  }
  const res = await page.evaluate(
    (o) => window.__solo.shots(o),
    { times, from: opt('from') ? Number(opt('from')) : 0, cols: opt('cols') ? Number(opt('cols')) : undefined, cell: opt('cell') ? Number(opt('cell')) : undefined },
  );
  writeFileSync(out, Buffer.from(res.sheet.split(',')[1], 'base64'));
  console.log(`scene ${ready.scene} · ${w}x${h} · ${times.length} frames → ${out}`);
  console.log(`frame cost ≈ ${res.ms} ms at ${w}x${h} on ${res.gpu}${res.ms > 9 ? "  ← HEAVY: aim for under 8 ms" : ""}`);
  if (res.errors.length) console.log('ERRORS\n' + res.errors.join('\n'));
  const extra = logs.filter((l) => !res.errors.some((e) => l.includes(e.slice(0, 40))));
  if (extra.length) console.log('CONSOLE\n' + [...new Set(extra)].slice(0, 10).join('\n'));
  if (!res.errors.length && !extra.length) console.log('no errors');
} finally {
  await browser.close();
}
