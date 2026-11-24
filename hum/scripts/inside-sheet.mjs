#!/usr/bin/env node
/** Contact sheets of inside shots (src/dev/inside.ts): node scripts/inside-sheet.mjs --out a.jpg --cells cells.json [--w 1280 --h 720 --cols 4 --cell 480 --port 5242] */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PE', e.message));
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(m.text().slice(0, 400)));
await page.goto(`http://127.0.0.1:${opt('port', '5242')}/inside.html`);
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
if (args.includes('--scenes')) console.log(JSON.stringify(await page.evaluate(() => window.__inside.scenes()), null, 1));
else {
  const cells = JSON.parse(readFileSync(opt('cells'), 'utf8'));
  const r = await page.evaluate(([c, o]) => window.__inside.sheet(c, o), [cells, { w: +opt('w', 1280), h: +opt('h', 720), cols: +opt('cols', 4), cell: +opt('cell', 480) }]);
  writeFileSync(opt('out', 'inside.jpg'), Buffer.from(r.sheet.split(',')[1], 'base64'));
  for (const i of r.info) console.log(i.clip, i.moment, JSON.stringify(i.puts));
  console.log(r.errors.join('\n'));
}
await browser.close();
