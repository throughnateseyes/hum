#!/usr/bin/env node
/** Inside shots as a film, one after another: node scripts/inside-film.mjs --out a.mp4 --cells cells.json [--w 960 --h 540 --fps 24 --port 5242] */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const fps = +opt('fps', 24);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(fps), '-i', '-', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', opt('out', 'inside.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PE', e.message));
await page.exposeFunction('__frame', (jpg) => void ff.stdin.write(Buffer.from(jpg.split(',')[1], 'base64')));
await page.goto(`http://127.0.0.1:${opt('port', '5242')}/inside.html`);
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
for (const c of JSON.parse(readFileSync(opt('cells'), 'utf8'))) console.log(c.clip, c.moment, await page.evaluate(([c, f, w, h]) => window.__inside.film(c, f, w, h), [c, fps, +opt('w', 960), +opt('h', 540)]));
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
