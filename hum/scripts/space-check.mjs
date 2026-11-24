#!/usr/bin/env node
/**
 * The lyric spacing check: every kit × medium × test line × frame shape, measured against the rules
 * in src/render/lyricSpace.ts (safe area, plate padding) plus the font-level checks (letter pairs
 * that touch, stacked rows that meet). Writes a table of everything that breaks a rule and a contact
 * sheet of the offenders per shape. See src/dev/space.ts.
 *
 *   node scripts/space-check.mjs --port 5198 --out /path/dir --label before
 *   node scripts/space-check.mjs --port 5198 --out dir --kits print --mediums big --shapes 16x9 --all
 *
 * Shapes: 9x16 (1080x1920), 4x5 (1080x1350), 1x1 (1080x1080), 16x9 (1920x1080), and what Fill makes of a
 * whole screen: 9x19 (a phone), 16x10 (a laptop), 5x4 (a window), 21x9 (a wide monitor).
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const flag = (k) => args.includes(`--${k}`);
const port = opt('port', '5198');
const out = opt('out', `${process.cwd()}/space`);
const label = opt('label', 'run');
const list = (k) => (opt(k) ? opt(k).split(',') : undefined);
const SHAPES = { '9x16': [1080, 1920], '4x5': [1080, 1350], '1x1': [1080, 1080], '16x9': [1920, 1080], '9x19': [1080, 2340], '16x10': [1920, 1200], '5x4': [1350, 1080], '21x9': [2520, 1080] };
const shapes = list('shapes') ?? Object.keys(SHAPES);
mkdirSync(out, { recursive: true });

const { chromium } = await import('playwright-core');
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const all = [];
let voices = null;
try {
  for (const shape of shapes) {
    const [w, h] = SHAPES[shape];
    const page = await browser.newPage({ viewport: { width: Math.min(w, 1600), height: Math.min(h, 1400) }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text().slice(0, 300)}`));
    await page.route('**/api/director', (r) => r.fulfill({ status: 501, contentType: 'application/json', body: '{"error":"no_key"}' }));
    await page.route('**/@vite/client', (r) =>
      r.fulfill({
        contentType: 'application/javascript',
        body: `export function createHotContext() { return { accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, on() {}, off() {}, send() {}, data: {} }; }
          export function updateStyle(id, css) { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
          export function removeStyle() {} export function injectQuery(u) { return u; } export class ErrorOverlay {}`,
      }),
    );
    await page.goto(`http://localhost:${port}/solo.html?space=1&w=${w}&h=${h}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => !!window.__space, null, { timeout: 60000 });
    const ready = await page.evaluate(() => window.__space.ready);
    if (!ready.ok) throw new Error(`boot failed: ${ready.error}\n${logs.join('\n')}`);
    if (!voices) voices = await page.evaluate(() => window.__space.voices());
    const res = await page.evaluate((o) => window.__space.run(o), { kits: list('kits'), mediums: list('mediums'), lines: list('lines'), all: flag('all') });
    for (const r of res.rows) all.push({ shape, ...r });
    if (res.sheet) writeFileSync(`${out}/${label}-sheet-${shape}.png`, Buffer.from(res.sheet.split(',')[1], 'base64'));
    if (logs.length) console.log(logs.slice(0, 8).join('\n'));
    await page.close();
  }
} finally {
  await browser.close();
}

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) : '-');
const bad = all.filter((r) => r.offences.length);
const kits = [...new Set(all.map((r) => r.kit))];
let md = `# Lyric spacing: ${label}\n\n${all.length} cases measured, ${bad.length} break a rule.\n\n## Offending cases per kit and shape\n\n| kit | ${shapes.join(' | ')} | total |\n|---|${shapes.map(() => '---').join('|')}|---|\n`;
for (const k of kits) {
  const n = shapes.map((s) => bad.filter((r) => r.kit === k && r.shape === s).length);
  const tot = shapes.map((s) => all.filter((r) => r.kit === k && r.shape === s).length);
  md += `| ${k} | ${n.map((x, i) => `${x}/${tot[i]}`).join(' | ')} | ${n.reduce((a, b) => a + b, 0)} |\n`;
}
const vbad = (voices ?? []).filter((v) => v.offences.length);
md += `\n## Voices (letter pairs, stacked rows)\n\n${vbad.length ? '| kit | role | face | leading | row gap (em) | offences |\n|---|---|---|---|---|---|\n' + vbad.map((v) => `| ${v.kit} | ${v.role} | ${v.family} | ${v.leading} | ${v.rowGap} | ${v.offences.join('; ')} |`).join('\n') : 'No voice breaks a rule.'}\n`;
md += `\n## Every offending case\n\nEdges: the smallest distance of any ink, plate or ornament to each edge, as a share of the frame's short side.\n\n| shape | kit | medium | line | edges l/t/r/b % | what breaks |\n|---|---|---|---|---|---|\n`;
for (const r of bad) md += `| ${r.shape} | ${r.kit} | ${r.medium} | ${r.line}${r.medium === 'knockout' ? ` @${r.t.toFixed(1)}` : ''} | ${pct(r.edge.l)}/${pct(r.edge.t)}/${pct(r.edge.r)}/${pct(r.edge.b)} | ${r.offences.slice(0, 3).join('; ')}${r.offences.length > 3 ? ` (+${r.offences.length - 3})` : ''} |\n`;
const ex = [...new Set(all.flatMap((r) => r.exempt))];
if (ex.length) md += `\nNamed exceptions seen (not counted): ${ex.join(', ')}\n`;
writeFileSync(`${out}/${label}-table.md`, md);
writeFileSync(`${out}/${label}-rows.json`, JSON.stringify({ rows: all, voices }, null, 1));
console.log(md.split('## Every offending case')[0]);
console.log(`→ ${out}/${label}-table.md`);
