/**
 * Retro Desktop — the song lives on an old home computer. A blue-sky-and-green-hill wallpaper,
 * grey bevelled windows with title bars, a taskbar with a clock, a chunky pixel arrow, and the
 * song's title set huge across the top like a poster. The feeling is nostalgia with a lump in the
 * throat: funny and vulnerable at once, a machine full of things nobody said
 * ("you have +99 unsaid things").
 *
 * Every window is an instrument. A notes window types the sung line letter by letter with a
 * blinking caret (without lyrics it types the song's facts and the part playing now); a player
 * shows the real song time, a live spectrum and a progress bar; in a paint window a pen scribbles
 * the level while the waveform draws across it; a volume pop-up's meter is the level; a folder of
 * unsent files moves its selection on the hats. The cursor travels on the beat and clicks on kicks
 * (the button under it visibly presses and its window comes to front). Snares and new sections
 * pop error dialogs with short messages that fit the part.
 *
 * The song's arc is how cluttered the desktop is (feel.intensity): a quiet part is wallpaper, one
 * notes window and the clock, clouds drifting on the shared wind and a sky following the time of
 * day; a chorus is a desk full of windows. Tension fills a progress dialog ("loading feelings… 73%")
 * and makes the windows shake; the drop flashes the wallpaper and drags an error dialog across the
 * screen leaving dozens of copies behind it (the classic cascade), which fade with the afterglow.
 * A break closes the windows one by one, each zooming back into the taskbar.
 *
 * Canvas 2D, drawn on a pixel grid of whole "units" (short side ≈ 260 units) so the chrome stays
 * crisp and chunky at any size. Sky, hill, icons, cursor, clouds and grain are cached offscreen.
 *
 * Palette roles: bg = wallpaper sky (and, deepened toward the ink, the title bars) ·
 * fg = poster type, text and outlines · accent = the green hill and the LCD read-outs ·
 * accent2 = alerts: warning icons, the paint pen, the hot end of the meters ·
 * muted = window grey (its lightness decides whether the windows are a daytime or a night UI).
 */
import { defineCanvasScene } from '../../core/sceneHelpers';
import { bool, num } from '../../core/uniforms';
import type { LyricLine, Palette, ParamDef } from '../../core/types';
import { useStudio } from '../../state/store';
import { FONT_MONO, FONT_SANS, currentLyric, fmtClock, songInfo } from '../three/songInfo';

const params: ParamDef[] = [
  { id: 'clutter', label: 'Clutter', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How many windows open at a given loudness' },
  { id: 'ui', label: 'UI size', group: 'Shape', type: 'number', min: 0.7, max: 1.5, step: 0.05, default: 1, hint: 'Size of the pixel grid the desktop is drawn on' },
  { id: 'poster', label: 'Poster type', group: 'Shape', type: 'number', min: 0, max: 1.4, step: 0.01, default: 1, hint: 'Size of the big title over the desktop (0 hides it)' },
  { id: 'cursor', label: 'Cursor speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'shake', label: 'Tension shake', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How hard windows rattle as a build winds up' },
  { id: 'errors', label: 'Error pop-ups', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How readily snares pop error dialogs' },
  { id: 'cascade', label: 'Drop cascade', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'Length of the trail of dialogs dragged across the screen on a drop' },
  { id: 'flash', label: 'Drop flash', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'phone', label: 'Hanging phone', group: 'Shape', type: 'bool', default: true, hint: 'A red handset dangling on its cord: sways on the wind, jumps on kicks, rings as a build winds up' },
  { id: 'grain', label: 'Scan grain', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'A slightly soft, scanned-print texture over everything' },
];

/* ───────────────────────── colour ───────────────────────── */

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const damp = (c: number, t: number, k: number, dt: number) => c + (t - c) * (1 - Math.exp(-k * dt));
function rgb(s: string): RGB {
  let h = (s || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a >= 1 ? 1 : a <= 0 ? 0 : a.toFixed(3)})`;
const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
function hash(a: number, b = 0) {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n & 0xffff) / 65535;
}

/** every colour the desktop uses, derived from the five palette colours */
interface Tones {
  key: string;
  night: boolean;
  skyTop: string;
  skyLow: string;
  haze: string;
  hill: RGB;
  hillHi: RGB;
  hillLo: RGB;
  hillFar: string;
  cloud: RGB;
  grey: string;
  hi: string;
  lo: string;
  dk: string;
  paper: string;
  ink: string;
  inkSoft: string;
  title: string;
  title2: string;
  titleOff: string;
  titleOff2: string;
  titleText: string;
  /** fills and selections: the title colour on a daytime UI, a lighter tint of it at night */
  sel: string;
  alert: string;
  alertDk: string;
  alertHi: string;
  lcd: string;
  lcdText: string;
  lcdDim: string;
  poster: string;
  shadow: string;
  flash: string;
  label: string;
  labelShadow: string;
  folder: string;
  stars: string;
  rawBg: RGB;
}

function makeTones(p: Palette, dayQ: number): Tones {
  const bg = rgb(p.bg);
  const fg = rgb(p.fg);
  const ac = rgb(p.accent);
  const ac2 = rgb(p.accent2);
  const mu = rgb(p.muted);
  const dark = lum(fg) < lum(bg) ? fg : bg;
  const lightUI = lum(mu) > 0.42;
  const night = lum(bg) < 0.22;
  // dawn and dusk deepen the sky; noon opens it up
  const dusk = clamp01(Math.abs(dayQ - 0.5) * 2.6 - 0.25);
  const skyTop = night ? mix(bg, BLACK, 0.3) : mix(bg, dark, 0.12 + 0.3 * dusk);
  const skyLow = night ? mix(mix(bg, ac2, 0.1), WHITE, 0.04) : mix(mix(bg, WHITE, 0.42 - 0.18 * dusk), ac2, 0.2 * dusk);
  const ink = lightUI ? (lum(fg) < lum(bg) ? fg : bg) : lum(fg) > lum(bg) ? fg : bg;
  const title = mix(bg, dark, night ? 0.1 : 0.55);
  return {
    key: '',
    night,
    skyTop: css(skyTop),
    skyLow: css(skyLow),
    haze: css(mix(skyLow, WHITE, night ? 0.05 : 0.25)),
    hill: ac,
    hillHi: mix(ac, mix(WHITE, ac2, 0.12), night ? 0.12 : 0.32),
    hillLo: mix(ac, BLACK, 0.38),
    hillFar: css(mix(mix(ac, skyLow, 0.5), dark, 0.05)),
    cloud: night ? mix(bg, fg, 0.16) : mix(skyLow, WHITE, 0.82),
    grey: css(mu),
    hi: css(lightUI ? mix(mu, WHITE, 0.72) : mix(mu, WHITE, 0.22)),
    lo: css(mix(mu, BLACK, lightUI ? 0.32 : 0.35)),
    dk: css(mix(mu, BLACK, lightUI ? 0.72 : 0.75)),
    paper: css(lightUI ? mix(mu, WHITE, 0.88) : mix(mu, BLACK, 0.55)),
    ink: css(ink),
    inkSoft: css(mix(ink, mu, 0.45)),
    title: css(title),
    title2: css(mix(title, mix(bg, WHITE, 0.25), night ? 0.6 : 0.75)),
    titleOff: css(mix(mu, BLACK, 0.3)),
    titleOff2: css(mix(mu, WHITE, 0.25)),
    titleText: css(mix(WHITE, mu, 0.06)),
    sel: css(lightUI ? title : mix(mix(bg, fg, 0.5), ac, 0.15)),
    alert: css(ac2),
    alertDk: css(mix(ac2, BLACK, 0.42)),
    alertHi: css(mix(ac2, WHITE, 0.45)),
    lcd: css(mix(dark, BLACK, 0.3)),
    lcdText: css(lum(ac) < 0.25 ? mix(ac, WHITE, 0.5) : ac),
    lcdDim: css(mix(mix(dark, BLACK, 0.3), ac, 0.22)),
    poster: css(fg),
    shadow: css(mix(dark, BLACK, 0.5), 0.32),
    flash: css(night ? mix(fg, WHITE, 0.4) : WHITE),
    label: css(night ? fg : WHITE),
    labelShadow: css(mix(dark, BLACK, 0.4), 0.55),
    folder: css(mix(ac2, WHITE, 0.45)),
    stars: css(mix(fg, WHITE, 0.3)),
    rawBg: bg,
  };
}

/* ───────────────────────── pixel art ───────────────────────── */

// the pointer, row by row: X = outline, . = fill
const ARROW = [
  'X',
  'XX',
  'X.X',
  'X..X',
  'X...X',
  'X....X',
  'X.....X',
  'X......X',
  'X.......X',
  'X........X',
  'X.....XXXXX',
  'X..X..X',
  'X.X X..X',
  'XX  X..X',
  'X    X..X',
  '     X..X',
  '      XX',
];

const MESSAGES: Record<string, string[]> = {
  intro: ['starting up… please wait while we remember everything.', 'welcome back. it has been a while.'],
  verse: ['heart.exe is not responding.', 'unsaid_things.txt is too large to open.', 'memory low: too many memories.', 'cannot delete “you”: file is in use.'],
  chorus: ['are you sure you want to feel this?', 'a fatal nostalgia has occurred.', 'too many windows open in your chest.', 'do you want to save changes to yourself?'],
  build: ['warning: feelings approaching capacity.', 'do not turn off your heart while updating.', 'something is about to happen.'],
  drop: ['are you sure you want to feel this?', 'too late to turn back.', 'everything is open at once.', 'a fatal nostalgia has occurred.'],
  bridge: ['the feeling you requested could not be found.', 'connection lost. try again later?'],
  break: ['it’s quiet now. close all windows?', 'the feeling you requested could not be found.', 'connection lost. try again later?'],
  outro: ['it is now safe to turn off your heart.', 'shutting down… thank you for staying.'],
};
const BUTTONS = ['ok', 'ok', 'yes', 'cancel', 'retry'];
const ERR_TITLES = ['heart.exe', 'error', 'feelings.exe', 'warning', 'memory'];
const FILES = ['miss_you.txt', 'sorry_v3.doc', 'unsent (12).txt', 'us_summer.bmp', 'voicemail.wav', 'dont_open.zip', 'call_back.txt'];

/* ───────────────────────── state ───────────────────────── */

type Kind = 'notes' | 'player' | 'volume' | 'paint' | 'feelings' | 'progress';
interface Win {
  kind: Kind;
  title: string;
  /** intensity it opens at (the notes window is always open) */
  th: number;
  /** open animation 0..1 (zooms out of / back into its taskbar button) */
  a: number;
  want: boolean;
  /** seconds left of the clicked button looking pressed */
  press: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Err {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  icon: number;
  btn: string;
  life: number;
  press: number;
}
interface Cloud {
  x0: number;
  y: number;
  s: number;
  spd: number;
  v: number;
}
interface St {
  cw: number;
  ch: number;
  U: number;
  W: number;
  H: number;
  layoutKey: string;
  wallKey: string;
  sky: HTMLCanvasElement;
  hill: HTMLCanvasElement;
  icons: HTMLCanvasElement;
  iconsKey: string;
  clouds: HTMLCanvasElement[];
  cloudKey: string;
  cloudList: Cloud[];
  arrow: HTMLCanvasElement;
  arrowKey: string;
  handset: { c: HTMLCanvasElement; ox: number; oy: number } | null;
  grain: HTMLCanvasElement;
  trail: HTMLCanvasElement;
  sprite: HTMLCanvasElement;
  spriteKey: string;
  doodle: HTMLCanvasElement;
  wins: Win[];
  errs: Err[];
  tones: Tones | null;
  tonesKey: string;
  // cursor (units)
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  target: Win | Err | null;
  click: number;
  lastBeat: number;
  lastMove: number;
  // song
  prevSec: number;
  prevSince: number;
  casc: number;
  stamp: number;
  cascOn: boolean;
  snares: number;
  sel: number;
  swatch: number;
  hatT: number;
  // typing
  lastLine: number;
  history: string[];
  factIdx: number;
  // paint pen
  penX: number;
  penY: number;
  balloon: number;
  /** the phone's swing (radians) and its angular velocity */
  swing: number;
  swingV: number;
  rng: number;
  t: number;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
const c2d = (c: HTMLCanvasElement) => c.getContext('2d')!;
function rand(st: St) {
  st.rng = (st.rng * 1664525 + 1013904223) >>> 0;
  return st.rng / 4294967296;
}

const WINS: { kind: Kind; title: string; th: number }[] = [
  { kind: 'notes', title: 'unsaid.txt - notes', th: -1 },
  { kind: 'player', title: 'player', th: 0.3 },
  { kind: 'volume', title: 'sound', th: 0.42 },
  { kind: 'paint', title: 'untitled - paint', th: 0.54 },
  { kind: 'feelings', title: 'my feelings', th: 0.68 },
  { kind: 'progress', title: 'copying feelings…', th: 9 },
];

/* window rects, as [x fraction of desk, y fraction of desk, width, height] in units, for a
   landscape and a portrait desk; anything between blends the two */
const LAND: Record<Kind, [number, number, number, number]> = {
  notes: [0.28, 0.42, 170, 94],
  player: [0.67, 0.58, 136, 74],
  volume: [0.05, 0.6, 66, 64],
  paint: [0.6, 0.1, 172, 116],
  feelings: [0.04, 0.12, 112, 86],
  progress: [0.5, 0.36, 168, 54],
};
const PORT: Record<Kind, [number, number, number, number]> = {
  notes: [0.06, 0.29, 210, 108],
  player: [0.38, 0.78, 150, 74],
  volume: [0.05, 0.68, 66, 64],
  paint: [0.22, 0.5, 196, 128],
  feelings: [0.4, 0.13, 136, 86],
  progress: [0.5, 0.42, 168, 54],
};
const TBH = 16; // taskbar height (units)

function layout(st: St) {
  const { W, H } = st;
  const deskH = H - TBH;
  const pt = clamp01((1.45 - W / H) / 0.9);
  for (const w of st.wins) {
    const L = LAND[w.kind];
    const P = PORT[w.kind];
    const ww = Math.min(Math.round(lerp(L[2], P[2], pt)), W - 6);
    const hh = Math.min(Math.round(lerp(L[3], P[3], pt)), deskH - 6);
    let x = lerp(L[0], P[0], pt) * W;
    let y = lerp(L[1], P[1], pt) * deskH;
    if (w.kind === 'progress') {
      x -= ww / 2;
    }
    w.w = ww;
    w.h = hh;
    w.x = Math.round(Math.min(Math.max(3, x), W - ww - 3));
    w.y = Math.round(Math.min(Math.max(3, y), deskH - hh - 3));
  }
}

/* ───────────────────────── cached layers ───────────────────────── */

function horizonY(st: St, x: number) {
  // the main hill's ridge (units): a long soft swell, higher on the left
  const { W, H } = st;
  const deskH = H - TBH;
  const portrait = W < H;
  const base = deskH * (portrait ? 0.6 : 0.6);
  const u = x / W;
  return base - Math.sin(u * Math.PI * 0.9 + 0.35) * deskH * 0.11 + u * deskH * 0.05;
}

function buildWall(st: St, T: Tones) {
  const { cw, ch, U, W, H } = st;
  st.sky.width = cw;
  st.sky.height = ch;
  st.hill.width = cw;
  st.hill.height = ch;
  const s = c2d(st.sky);
  const hy = horizonY(st, W * 0.5) * U;
  const g = s.createLinearGradient(0, 0, 0, hy + 30 * U);
  g.addColorStop(0, T.skyTop);
  g.addColorStop(0.75, T.skyLow);
  g.addColorStop(1, T.haze);
  s.fillStyle = g;
  s.fillRect(0, 0, cw, ch);
  if (T.night) {
    // a few pixel stars
    s.fillStyle = T.stars;
    for (let i = 0; i < 70; i++) {
      const x = Math.floor(hash(i, 3) * W) * U;
      const y = Math.floor(hash(i, 7) * H * 0.55) * U;
      s.globalAlpha = 0.25 + 0.6 * hash(i, 11);
      s.fillRect(x, y, U, U);
    }
    s.globalAlpha = 1;
  }

  const h = c2d(st.hill);
  h.clearRect(0, 0, cw, ch);
  // far hill on the right
  h.fillStyle = T.hillFar;
  h.beginPath();
  h.moveTo(W * 0.3 * U, ch);
  for (let x = W * 0.3; x <= W + 4; x += 4) {
    const u = (x - W * 0.3) / (W * 0.7);
    h.lineTo(x * U, (horizonY(st, x) - Math.sin(u * Math.PI) * (H - TBH) * 0.07 - 4) * U);
  }
  h.lineTo(cw, ch);
  h.closePath();
  h.fill();
  // the main hill
  const top = (horizonY(st, W * 0.25) - 6) * U;
  const hg = h.createLinearGradient(0, top, 0, ch);
  hg.addColorStop(0, css(T.hillHi));
  hg.addColorStop(0.3, css(T.hill));
  hg.addColorStop(1, css(T.hillLo));
  h.fillStyle = hg;
  h.beginPath();
  h.moveTo(0, ch);
  for (let x = 0; x <= W + 4; x += 3) h.lineTo(x * U, horizonY(st, x) * U);
  h.lineTo(cw, ch);
  h.closePath();
  h.fill();
  // a sunlit sweep across the slope and a darker fold below it
  h.save();
  h.clip();
  const rg = h.createRadialGradient(cw * 0.32, top + ch * 0.06, 0, cw * 0.32, top + ch * 0.06, cw * 0.45);
  rg.addColorStop(0, css(T.hillHi, 0.55));
  rg.addColorStop(1, css(T.hillHi, 0));
  h.fillStyle = rg;
  h.fillRect(0, 0, cw, ch);
  h.fillStyle = css(T.hillLo, 0.35);
  h.beginPath();
  h.moveTo(0, ch * 0.86);
  h.bezierCurveTo(cw * 0.3, ch * 0.78, cw * 0.6, ch * 0.92, cw, ch * 0.8);
  h.lineTo(cw, ch);
  h.lineTo(0, ch);
  h.fill();
  h.restore();
}

function buildClouds(st: St, T: Tones) {
  const U = st.U;
  st.clouds = [];
  for (let k = 0; k < 3; k++) {
    const cw = 110 * U;
    const chh = 40 * U;
    const c = canvas(cw, chh);
    const g = c2d(c);
    for (let i = 0; i < 9; i++) {
      const px = (0.15 + 0.7 * hash(i, k * 13 + 1)) * cw;
      const py = (0.45 + 0.25 * (hash(i, k * 13 + 5) - 0.5)) * chh + (Math.abs(i - 4) / 4) * chh * 0.12;
      const r = (0.14 + 0.16 * hash(i, k * 13 + 9)) * cw * (1 - Math.abs(px / cw - 0.5) * 0.9);
      const rg = g.createRadialGradient(px, py, 0, px, py, r);
      rg.addColorStop(0, css(T.cloud, 0.85));
      rg.addColorStop(0.55, css(T.cloud, 0.45));
      rg.addColorStop(1, css(T.cloud, 0));
      g.fillStyle = rg;
      g.fillRect(0, 0, cw, chh);
    }
    st.clouds.push(c);
  }
}

function buildGrain(st: St) {
  // a soft, scanned-print grain: light and dark specks and a faint horizontal scan
  const tile = 256;
  const c = canvas(tile, tile);
  const g = c2d(c);
  const img = g.createImageData(tile, tile);
  for (let i = 0; i < tile * tile; i++) {
    const v = hash(i, 91);
    const y = Math.floor(i / tile);
    const scan = y % 3 === 0 ? 18 : 0;
    const val = v > 0.5 ? 255 : 0;
    img.data[i * 4] = val;
    img.data[i * 4 + 1] = val;
    img.data[i * 4 + 2] = val;
    img.data[i * 4 + 3] = Math.abs(v - 0.5) * 2 > 0.7 ? 60 + scan : scan;
  }
  g.putImageData(img, 0, 0);
  st.grain = c;
}

function buildArrow(st: St, T: Tones) {
  const px = Math.max(1, Math.round(st.U * 1.5));
  const c = canvas(12 * px + px, 17 * px + px);
  const g = c2d(c);
  // soft drop shadow first
  g.fillStyle = T.shadow;
  ARROW.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== ' ') g.fillRect((x + 1) * px, (y + 1) * px, px, px);
  });
  ARROW.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') continue;
      g.fillStyle = ch === 'X' ? T.ink : T.paper;
      g.fillRect(x * px, y * px, px, px);
    }
  });
  st.arrow = c;
}

/** desktop icons down the left edge */
function buildIcons(st: St, T: Tones) {
  const { cw, ch, U, W, H } = st;
  st.icons.width = cw;
  st.icons.height = ch;
  const g = c2d(st.icons);
  g.clearRect(0, 0, cw, ch);
  const portrait = W < H;
  const labels = ['my feelings', 'unsent.txt', 'old songs', 'trash'];
  const x0 = 6;
  const y0 = portrait ? Math.round((H - TBH) * 0.24) : 8;
  for (let i = 0; i < labels.length; i++) {
    const cx = x0 + 14;
    const y = y0 + i * 34;
    if ((y + 30) * U > (H - TBH) * U) break;
    const r = (x: number, yy: number, w: number, h: number, col: string) => {
      g.fillStyle = col;
      g.fillRect((cx - 8 + x) * U, (y + yy) * U, w * U, h * U);
    };
    if (i === 0) {
      r(0, 3, 7, 2, T.folder);
      r(0, 4, 16, 11, T.folder);
      r(0, 14, 16, 1, T.lo);
      r(15, 4, 1, 11, T.lo);
      r(0, 6, 16, 1, T.hi);
    } else if (i === 1) {
      r(2, 1, 12, 15, T.paper);
      r(2, 1, 12, 1, T.ink);
      r(2, 15, 12, 1, T.ink);
      r(2, 1, 1, 15, T.ink);
      r(13, 1, 1, 15, T.ink);
      for (let k = 0; k < 5; k++) r(4, 4 + k * 2, 5 + ((k * 3) % 4), 1, T.inkSoft);
    } else if (i === 2) {
      // a disc
      g.fillStyle = T.hi;
      g.beginPath();
      g.arc(cx * U, (y + 8) * U, 7.5 * U, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = T.lo;
      g.beginPath();
      g.arc(cx * U, (y + 8) * U, 2.5 * U, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = T.alert;
      g.globalAlpha = 0.5;
      g.fillRect((cx + 1) * U, (y + 2) * U, 4 * U, U);
      g.globalAlpha = 1;
    } else {
      r(3, 2, 10, 2, T.lo);
      r(4, 4, 8, 12, T.grey);
      r(4, 4, 1, 12, T.hi);
      r(11, 4, 1, 12, T.dk);
      r(4, 15, 8, 1, T.dk);
      r(6, 6, 1, 8, T.lo);
      r(9, 6, 1, 8, T.lo);
    }
    g.font = `500 ${Math.round(6.5 * U)}px ${FONT_SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = T.labelShadow;
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 1.5]]) g.fillText(labels[i], cx * U + dx * U * 0.6, (y + 19) * U + dy * U * 0.6);
    g.fillStyle = T.label;
    g.fillText(labels[i], cx * U, (y + 19) * U);
  }
}

/* ───────────────────────── chrome ───────────────────────── */

function bevel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, U: number, T: Tones, inset = false, fill = T.grey) {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  g.fillStyle = inset ? T.lo : T.hi;
  g.fillRect(x, y, w, U);
  g.fillRect(x, y, U, h);
  g.fillStyle = inset ? T.hi : T.dk;
  g.fillRect(x, y + h - U, w, U);
  g.fillRect(x + w - U, y, U, h);
}

/** a sunken field (text areas, LCDs, progress troughs) */
function well(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, U: number, T: Tones, fill: string) {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  g.fillStyle = T.lo;
  g.fillRect(x, y, w, U);
  g.fillRect(x, y, U, h);
  g.fillStyle = T.hi;
  g.fillRect(x, y + h - U, w, U);
  g.fillRect(x + w - U, y, U, h);
}

function button(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, U: number, T: Tones, label: string, pressed: boolean, font: string) {
  bevel(g, x, y, w, h, U, T, pressed);
  if (!pressed) {
    g.fillStyle = T.ink;
    g.fillRect(x, y + h, w + U, U);
    g.fillRect(x + w, y, U, h);
  }
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = T.ink;
  const o = pressed ? U : 0;
  g.fillText(label, Math.round(x + w / 2 + o), Math.round(y + h / 2 + o));
}

/** frame, title bar and caption buttons; returns the client rect (px) */
function chrome(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  U: number,
  T: Tones,
  title: string,
  active: boolean,
  small: boolean,
) {
  g.fillStyle = T.shadow;
  g.fillRect(x + 3 * U, y + 3 * U, w, h);
  bevel(g, x, y, w, h, U, T);
  g.fillStyle = T.lo;
  g.fillRect(x + U, y + h - 2 * U, w - 2 * U, U);
  g.fillRect(x + w - 2 * U, y + U, U, h - 2 * U);
  const tbH = 11 * U;
  const tx = x + 2 * U;
  const ty = y + 2 * U;
  const tw = w - 4 * U;
  const grad = g.createLinearGradient(tx, 0, tx + tw, 0);
  grad.addColorStop(0, active ? T.title : T.titleOff);
  grad.addColorStop(1, active ? T.title2 : T.titleOff2);
  g.fillStyle = grad;
  g.fillRect(tx, ty, tw, tbH);
  // a tiny window glyph and the caption
  g.fillStyle = T.titleText;
  g.fillRect(tx + 2 * U, ty + 3 * U, 5 * U, 5 * U);
  g.fillStyle = active ? T.title : T.titleOff;
  g.fillRect(tx + 3 * U, ty + 5 * U, 3 * U, 2 * U);
  g.font = `700 ${Math.round(6.5 * U)}px ${FONT_SANS}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = T.titleText;
  const maxT = tw - (small ? 22 : 40) * U;
  let cap = title;
  while (cap.length > 3 && g.measureText(cap).width > maxT) cap = cap.slice(0, -2);
  if (cap !== title) cap = cap.trimEnd() + '…';
  g.fillText(cap, tx + 9 * U, ty + tbH / 2 + U * 0.5);
  // caption buttons: _ □ x (just x on dialogs)
  const bw = 9 * U;
  const bh = 8 * U;
  const by = ty + 1.5 * U;
  const n = small ? 1 : 3;
  for (let i = 0; i < n; i++) {
    const bx = tx + tw - (i + 1) * (bw + U) - U;
    bevel(g, bx, by, bw, bh, U, T);
    g.fillStyle = T.ink;
    const k = small ? 0 : 2 - i;
    if (i === 0) {
      // x
      for (let d = 0; d < 4; d++) {
        g.fillRect(bx + (2.5 + d) * U, by + (2 + d) * U, U, U);
        g.fillRect(bx + (5.5 - d) * U, by + (2 + d) * U, U, U);
      }
    } else if (k === 1) {
      g.fillRect(bx + 2 * U, by + 2 * U, 5 * U, U);
      g.fillRect(bx + 2 * U, by + 2 * U, U, 4 * U);
      g.fillRect(bx + 6 * U, by + 2 * U, U, 4 * U);
      g.fillRect(bx + 2 * U, by + 5 * U, 5 * U, U);
    } else {
      g.fillRect(bx + 2 * U, by + 5 * U, 4 * U, U);
    }
  }
  return { x: x + 3 * U, y: ty + tbH + 2 * U, w: w - 6 * U, h: h - tbH - 7 * U };
}

function warnIcon(g: CanvasRenderingContext2D, x: number, y: number, s: number, U: number, T: Tones, kind: number) {
  // kind 0: warning triangle · 1: stop disc with an x · 2: question disc
  if (kind === 0) {
    g.fillStyle = T.ink;
    g.beginPath();
    g.moveTo(x + s / 2, y - U);
    g.lineTo(x + s + U, y + s);
    g.lineTo(x - U, y + s);
    g.closePath();
    g.fill();
    g.fillStyle = T.alert;
    g.beginPath();
    g.moveTo(x + s / 2, y + U);
    g.lineTo(x + s - U * 0.6, y + s - U);
    g.lineTo(x + U * 0.6, y + s - U);
    g.closePath();
    g.fill();
    const bw = Math.max(U, Math.round(s / 8));
    g.fillStyle = T.ink;
    g.fillRect(Math.round(x + s / 2 - bw / 2), Math.round(y + s * 0.32), bw, Math.round(s * 0.36));
    g.fillRect(Math.round(x + s / 2 - bw / 2), Math.round(y + s * 0.74), bw, bw);
    return;
  }
  const r = s / 2;
  g.fillStyle = T.ink;
  g.beginPath();
  g.arc(x + r, y + r, r + U * 0.7, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = kind === 1 ? T.alert : T.title;
  g.beginPath();
  g.arc(x + r, y + r, r - U * 0.3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = T.titleText;
  if (kind === 1) {
    const n = Math.max(3, Math.round(s / U / 2.2));
    for (let d = 0; d < n; d++) {
      const o = (d - (n - 1) / 2) * U;
      g.fillRect(Math.round(x + r + o - U / 2), Math.round(y + r + o - U / 2), U, U);
      g.fillRect(Math.round(x + r - o - U / 2), Math.round(y + r + o - U / 2), U, U);
    }
  } else {
    g.font = `800 ${Math.round(s * 0.75)}px ${FONT_SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('?', x + r, y + r + U * 0.5);
  }
}

function speaker(g: CanvasRenderingContext2D, x: number, y: number, U: number, col: string, waves: number) {
  g.fillStyle = col;
  g.fillRect(x, y + 3 * U, 3 * U, 4 * U);
  for (let i = 0; i < 4; i++) g.fillRect(x + (3 + i) * U, y + (3 - i) * U, U, (4 + 2 * i) * U);
  for (let k = 0; k < waves; k++) {
    const ox = x + (9 + k * 2.5) * U;
    const hgt = 4 + k * 2.5;
    g.fillRect(ox, y + (5 - hgt / 2) * U, U, hgt * U);
  }
}

/** the red handset, drawn once into a sprite (hanging by its mouthpiece end, origin at the cord) */
function buildHandset(U: number, T: Tones) {
  const s = U * 1.15;
  const ox = 18 * s;
  const oy = 3 * s;
  const c = canvas(Math.ceil(46 * s + 4 * U), Math.ceil(80 * s + 4 * U));
  const g = c2d(c);
  g.translate(ox, oy);
  g.rotate(-0.12);
  const body = (w: number, col: string, dx = 0) => {
    g.strokeStyle = col;
    g.lineCap = 'round';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(4 * s + dx, 8 * s);
    g.quadraticCurveTo(-11 * s + dx, 36 * s, 4 * s + dx, 64 * s);
    g.stroke();
  };
  const cup = (y: number, col: string, grow: number) => {
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(-3 * s - grow, y - grow, 22 * s + 2 * grow, 15 * s + 2 * grow, 6 * s + grow);
    g.fill();
  };
  g.save();
  g.translate(3 * U, 3 * U);
  body(12 * s, T.shadow);
  cup(0, T.shadow, 0);
  cup(57 * s, T.shadow, 0);
  g.restore();
  body(13.5 * s, T.alertDk);
  cup(0, T.alertDk, 0.9 * s);
  cup(57 * s, T.alertDk, 0.9 * s);
  body(11 * s, T.alert);
  cup(0, T.alert, 0);
  cup(57 * s, T.alert, 0);
  body(2.4 * s, T.alertHi, -3 * s);
  g.fillStyle = T.alertHi;
  g.fillRect(-1 * s, 2 * s, 3 * s, 9 * s);
  g.fillRect(-1 * s, 59 * s, 3 * s, 9 * s);
  // holes in the cups' faces
  g.fillStyle = T.alertDk;
  for (let i = 0; i < 3; i++) {
    g.fillRect(14 * s, (3 + i * 3.2) * s, 2 * s, 2 * s);
    g.fillRect(14 * s, (60 + i * 3.2) * s, 2 * s, 2 * s);
  }
  return { c, ox, oy };
}

/** the coiled cord from the top edge and the handset at its end (px) */
function phone(g: CanvasRenderingContext2D, st: St, ax: number, len: number, ang: number, ring: number, U: number, T: Tones, t: number) {
  g.save();
  g.translate(ax, -2 * U);
  g.rotate(ang);
  g.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) {
    g.lineWidth = Math.max(1, (pass ? 0.7 : 1.6) * U);
    g.strokeStyle = pass ? T.alertHi : T.alertDk;
    g.beginPath();
    for (let y = 0; y <= len; y += 1.5 * U) {
      const x = Math.sin(y / (2.2 * U)) * 3.2 * U - pass * 0.6 * U;
      if (y === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // it buzzes while ringing
  const hs = st.handset;
  if (hs) {
    const buzz = ring > 0.02 ? Math.sin(t * 90) * ring * 1.5 * U : 0;
    g.imageSmoothingEnabled = true;
    g.drawImage(hs.c, Math.round(buzz - hs.ox), Math.round(len - hs.oy));
  }
  if (ring > 0.15) {
    const s = U * 1.15;
    g.fillStyle = T.ink;
    g.globalAlpha = Math.min(1, ring * 1.5);
    const cy = len + 34 * s;
    for (let k = 0; k < 3; k++) {
      const o = (k - 1) * 7 * s;
      g.fillRect(-22 * s, cy + o, 6 * s, U);
      g.fillRect(30 * s, cy + o + (k - 1) * 2 * s, 6 * s, U);
    }
    g.globalAlpha = 1;
  }
  g.restore();
}

/* ───────────────────────── text helpers ───────────────────────── */

const wrapCache = new Map<string, string[]>();
function wrap(g: CanvasRenderingContext2D, s: string, maxW: number, font: string): string[] {
  const key = `${font}|${maxW | 0}|${s}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  g.font = font;
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > maxW && cur) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  if (!out.length) out.push('');
  if (wrapCache.size > 400) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

function syncedLines(): LyricLine[] | null {
  try {
    const l = useStudio.getState().lyrics;
    return l?.synced && l.lines.length ? l.lines : null;
  } catch {
    return null;
  }
}

/** how many characters of a lyric line have been sung by `t` (word timings when there are any) */
function sungChars(line: LyricLine, t: number) {
  const len = line.text.length;
  if (line.words?.length) {
    let chars = 0;
    let pos = 0;
    for (const w of line.words) {
      const idx = line.text.indexOf(w.text, pos);
      const start = idx >= 0 ? idx : pos;
      const end = start + w.text.length;
      pos = end;
      if (t >= w.end) chars = end + 1;
      else if (t >= w.t) {
        chars = start + Math.ceil(((t - w.t) / Math.max(0.05, w.end - w.t)) * w.text.length);
        break;
      } else break;
    }
    return Math.min(len, chars);
  }
  const p = (t - line.t) / Math.max(0.4, (line.end - line.t) * 0.8);
  return Math.min(len, Math.max(0, Math.floor(p * len)));
}

/* ───────────────────────── the scene ───────────────────────── */

export const retroDesktop = defineCanvasScene<St>({
  id: 'retro-desktop',
  name: 'Retro Desktop',
  description:
    'An old home computer as the place the song lives: a blue-sky, green-hill wallpaper, grey bevelled windows and the song title set huge like a poster. A notes window types the sung line, a player, paint and volume window read the music, the cursor clicks on kicks and snares pop error dialogs; quiet parts are an empty desk, a chorus fills it, and a drop drags an error dialog across the screen in a cascade of copies.',
  category: 'field',
  style: 'world',
  tags: ['nostalgic', 'retro', 'playful', 'lyrics', 'pop', 'indie', 'lofi', 'melancholic', 'tender', 'glitch', 'typographic', 'upbeat'],
  params,
  light: true,
  showsLyrics: true,
  modulations: [
    { source: 'energy', param: 'clutter', amount: 0.15 },
    { source: 'build', param: 'shake', amount: 0.25 },
  ],
  scale: 0.75,
  setup(_ctx, w, h) {
    const st: St = {
      cw: w,
      ch: h,
      U: 1,
      W: w,
      H: h,
      layoutKey: '',
      wallKey: '',
      sky: canvas(w, h),
      hill: canvas(w, h),
      icons: canvas(w, h),
      iconsKey: '',
      clouds: [],
      cloudKey: '',
      cloudList: [],
      arrow: canvas(1, 1),
      arrowKey: '',
      handset: null,
      grain: canvas(1, 1),
      trail: canvas(w, h),
      sprite: canvas(1, 1),
      spriteKey: '',
      doodle: canvas(1, 1),
      wins: WINS.map((d) => ({ ...d, a: d.th < 0 ? 1 : 0, want: d.th < 0, press: 0, x: 0, y: 0, w: 10, h: 10 })),
      errs: [],
      tones: null,
      tonesKey: '',
      cx: 0,
      cy: 0,
      tx: 0,
      ty: 0,
      target: null,
      click: 0,
      lastBeat: -1,
      lastMove: 0,
      prevSec: -2,
      prevSince: 99,
      casc: 99,
      stamp: 0,
      cascOn: false,
      snares: 0,
      sel: 0,
      swatch: 0,
      hatT: 0,
      lastLine: -1,
      history: [],
      factIdx: -1,
      penX: 0,
      penY: 0,
      balloon: 0,
      swing: 0,
      swingV: 0,
      rng: 20251118,
      t: 0,
    };
    for (let i = 0; i < 6; i++) st.cloudList.push({ x0: hash(i, 1), y: 0.06 + 0.5 * hash(i, 2), s: 0.6 + 0.8 * hash(i, 3), spd: 0.5 + hash(i, 4), v: i % 3 });
    buildGrain(st);
    return st;
  },
  draw(g, f, st) {
    const P = f.params;
    const a = f.audio;
    const fe = f.feel;
    const dt = Math.min(Math.max(f.dt, 0), 0.05);
    st.t += dt;
    const cw = f.width;
    const ch = f.height;

    /* grid and layout */
    const short = Math.min(cw, ch);
    const U = Math.max(1, Math.round((short / 260) * num(P, 'ui', 1)));
    const lk = `${cw}x${ch}@${U}`;
    if (lk !== st.layoutKey) {
      st.layoutKey = lk;
      st.cw = cw;
      st.ch = ch;
      st.U = U;
      st.W = Math.floor(cw / U);
      st.H = Math.floor(ch / U);
      st.trail.width = cw;
      st.trail.height = ch;
      st.wallKey = '';
      st.iconsKey = '';
      st.cloudKey = '';
      st.arrowKey = '';
      st.spriteKey = '';
      layout(st);
      st.cx = st.tx = st.W * 0.55;
      st.cy = st.ty = (st.H - TBH) * 0.6;
      st.errs.length = 0;
    }
    const { W, H } = st;
    const deskH = H - TBH;
    const pal = f.palette;
    const pk = `${pal.bg}${pal.fg}${pal.accent}${pal.accent2}${pal.muted}`;
    const dayQ = Math.round(fe.day * 24) / 24;
    const tk = `${pk}|${dayQ}`;
    if (tk !== st.tonesKey || !st.tones) {
      st.tones = makeTones(pal, dayQ);
      st.tones.key = tk;
      st.tonesKey = tk;
    }
    const T = st.tones;
    if (st.wallKey !== `${tk}|${lk}`) {
      st.wallKey = `${tk}|${lk}`;
      buildWall(st, T);
    }
    if (st.cloudKey !== `${tk}|${lk}`) {
      st.cloudKey = `${tk}|${lk}`;
      buildClouds(st, T);
    }
    if (st.iconsKey !== `${pk}|${lk}`) {
      st.iconsKey = `${pk}|${lk}`;
      buildIcons(st, T);
    }
    if (st.arrowKey !== `${pk}|${lk}`) {
      st.arrowKey = `${pk}|${lk}`;
      buildArrow(st, T);
      st.handset = buildHandset(U, T);
    }

    const fUI = `500 ${Math.round(6.5 * U)}px ${FONT_SANS}`;
    const fUIb = `700 ${Math.round(6.5 * U)}px ${FONT_SANS}`;
    const fMono = `500 ${Math.round(7 * U)}px ${FONT_MONO}`;
    const info = songInfo();
    const secs = f.analysis?.sections;
    const secLabel = fe.section ?? 'verse';

    /* the song's state */
    const clutter = num(P, 'clutter', 0.5);
    const inten = clamp01(fe.intensity + (clutter - 0.5) * 0.45);
    const tension = fe.tension;
    const errAmt = num(P, 'errors', 0.6);
    // a drop just landed (and we saw it happen, not a seek into the chorus)
    const dropNow = fe.sinceDrop < 0.08 && st.prevSince > 0.5 && st.t > 0.2;
    st.prevSince = fe.sinceDrop;
    if (a.snareHit) st.snares++;

    /* windows open and close with the intensity (each at its own level, so a break closes them one by one) */
    for (const w of st.wins) {
      if (w.kind === 'notes') continue;
      if (w.kind === 'progress') w.want = tension > (w.want ? 0.06 : 0.14) || fe.sinceDrop < 0.7;
      else w.want = inten > w.th + (w.want ? -0.05 : 0.04) || fe.sinceDrop < 0.15;
      const speed = w.want ? 4.5 : 3.2;
      w.a = clamp01(w.a + (w.want ? dt : -dt) * speed);
      if (w.press > 0) w.press -= dt;
    }
    const isOpen = (w: Win) => w.a >= 0.999;

    /* error dialogs: snares in a busy part, every new section, a burst on the drop */
    const spawnErr = (msgPool: string[], life: number) => {
      const font = fUI;
      const ew = Math.min(150, W - 12);
      const lines = wrap(g, msgPool[Math.floor(rand(st) * msgPool.length)], (ew - 40) * U, font);
      const eh = 13 + 8 + lines.length * 9 + 18;
      const e: Err = {
        w: ew,
        h: eh,
        x: Math.round(4 + rand(st) * Math.max(1, W - ew - 8)),
        y: Math.round(4 + rand(st) * Math.max(1, deskH - eh - 8)),
        title: ERR_TITLES[Math.floor(rand(st) * ERR_TITLES.length)],
        lines,
        icon: Math.floor(rand(st) * 3),
        btn: BUTTONS[Math.floor(rand(st) * BUTTONS.length)],
        life,
        press: 0,
      };
      st.errs.push(e);
      if (st.errs.length > 14) st.errs.shift();
    };
    const pool = MESSAGES[secLabel] ?? MESSAGES.verse;
    if (fe.sectionIndex !== st.prevSec) {
      if (st.prevSec !== -2 && fe.sectionIndex >= 0 && errAmt > 0.02) spawnErr(pool, 4.5);
      st.prevSec = fe.sectionIndex;
    }
    const maxErr = Math.floor(inten * inten * 8 * errAmt * (1 - 0.65 * tension) + (fe.release > 0.3 ? 2 : 0));
    if (a.snareHit && inten > 0.55 && tension < 0.3 && st.errs.length < maxErr && rand(st) < 0.35 + 0.5 * errAmt) spawnErr(pool, 1.6 + rand(st) * 2.2);
    if (dropNow) {
      for (let i = 0; i < 3 && errAmt > 0.02; i++) spawnErr(MESSAGES.drop, 2.5 + i * 0.7);
      st.casc = 0;
      st.stamp = 0;
      st.cascOn = true;
      c2d(st.trail).clearRect(0, 0, cw, ch);
    }
    for (let i = st.errs.length - 1; i >= 0; i--) {
      const e = st.errs[i];
      e.life -= dt * (inten < 0.3 ? 1.6 : 1);
      if (e.press > 0) e.press -= dt;
      if (e.life <= 0) st.errs.splice(i, 1);
    }

    /* the cursor: a new target on each beat, a click on each kick */
    const hot = (o: Win | Err): [number, number] => {
      if ('kind' in o) {
        switch (o.kind) {
          case 'notes':
            return [o.x + o.w * 0.62, o.y + 7];
          case 'player':
            return [o.x + 22, o.y + o.h - 11];
          case 'volume':
            return [o.x + o.w * 0.5 + 2, o.y + 23];
          case 'paint':
            return [o.x + o.w * 0.6, o.y + o.h * 0.5];
          case 'feelings':
            return [o.x + o.w * 0.45, o.y + 26 + (st.sel % 6) * 9];
          case 'progress':
            return [o.x + o.w - 26, o.y + o.h - 11];
        }
      }
      return [o.x + o.w / 2, o.y + o.h - 11];
    };
    const beatNow = a.beatCount !== st.lastBeat;
    if (beatNow) st.lastBeat = a.beatCount;
    const wander = st.t - st.lastMove > 2.2;
    if ((beatNow && a.playing && (a.beatCount % (inten > 0.6 ? 1 : 2) === 0)) || wander || !st.target) {
      const cands: (Win | Err)[] = [...st.errs, ...st.wins.filter(isOpen)];
      if (cands.length) {
        const pick = cands[Math.floor(hash(a.beatCount + Math.floor(st.t * 3), 17) * cands.length)];
        st.target = pick;
        const [hx, hy] = hot(pick);
        st.tx = hx;
        st.ty = hy;
        st.lastMove = st.t;
      }
    }
    const cs = num(P, 'cursor', 0.6);
    st.cx = damp(st.cx, st.tx, 2 + 14 * cs * (0.4 + inten), dt);
    st.cy = damp(st.cy, st.ty, 2 + 14 * cs * (0.4 + inten), dt);
    if (st.click > 0) st.click -= dt;
    if (a.kickHit) {
      st.click = 0.2;
      const tg = st.target;
      if (tg && Math.hypot(st.cx - st.tx, st.cy - st.ty) < 30) {
        if ('kind' in tg) {
          tg.press = 0.14;
          const i = st.wins.indexOf(tg);
          if (i >= 0 && tg.kind !== 'progress') {
            st.wins.splice(i, 1);
            st.wins.splice(st.wins.length - 1, 0, tg);
          }
        } else {
          tg.press = 0.14;
          tg.life = Math.min(tg.life, 0.15);
        }
      }
    }
    // keep the progress dialog on top of the windows
    const pi = st.wins.findIndex((w) => w.kind === 'progress');
    if (pi >= 0 && pi !== st.wins.length - 1) st.wins.push(st.wins.splice(pi, 1)[0]);
    if (a.hatHit && st.t - st.hatT > 0.11) {
      st.hatT = st.t;
      st.sel++;
      if (st.sel % 3 === 0) st.swatch++;
    }

    /* ── wallpaper ── */
    g.imageSmoothingEnabled = true;
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(st.sky, 0, 0);
    const hy0 = horizonY(st, W * 0.5);
    for (const c of st.cloudList) {
      const spr = st.clouds[c.v];
      if (!spr) continue;
      const cwU = 110 * c.s;
      const span = W + cwU;
      const x = ((((c.x0 * span + fe.windX * fe.windPhase * 5 * c.spd + st.t * 0.6 * c.spd) % span) + span) % span) - cwU;
      const y = c.y * hy0 - 14 * c.s;
      g.drawImage(spr, Math.round(x * U), Math.round(y * U), Math.round(cwU * U), Math.round(40 * c.s * U));
    }
    g.drawImage(st.hill, 0, 0);
    if (tension > 0.01) {
      g.fillStyle = T.lcd;
      g.globalAlpha = tension * 0.22;
      g.fillRect(0, 0, cw, ch);
      g.globalAlpha = 1;
    }
    const flashAmt = num(P, 'flash', 0.7) * Math.exp(-fe.sinceDrop * 3.2) * (fe.sinceDrop < 3 ? 1 : 0);
    if (flashAmt > 0.01) {
      g.fillStyle = T.flash;
      g.globalAlpha = Math.min(0.92, flashAmt);
      g.fillRect(0, 0, cw, ch);
      g.globalAlpha = 1;
    }
    g.drawImage(st.icons, 0, 0);
    g.imageSmoothingEnabled = false;

    /* ── windows ── */
    const shakeAmt = num(P, 'shake', 0.5) * Math.pow(tension, 1.4) * 2.4;
    const topWin = [...st.wins].reverse().find((w) => isOpen(w) && w.kind !== 'progress') ?? null;
    const taskBtn = (w: Win): [number, number, number, number] => {
      const open = st.wins.filter((o) => o.a > 0 && o.kind !== 'progress');
      const n = Math.max(1, open.length);
      const avail = W - 40 - 64;
      const bw = Math.max(18, Math.min(58, Math.floor(avail / n) - 2));
      const i = Math.max(0, WINS.findIndex((d) => d.kind === w.kind));
      return [40 + Math.min(i, n - 1) * (bw + 2), H - TBH + 2, bw, TBH - 4];
    };
    const lines = syncedLines();
    for (let wi = 0; wi < st.wins.length; wi++) {
      const w = st.wins[wi];
      if (w.a <= 0) continue;
      if (w.a < 0.999) {
        // zoom outline between the taskbar button and the window
        const [bx, by, bw, bh] = taskBtn(w);
        g.strokeStyle = T.ink;
        g.lineWidth = U;
        for (let k = 0; k < 3; k++) {
          const tt = clamp01(w.a - k * 0.14);
          if (tt <= 0) continue;
          const x = lerp(bx, w.x, tt);
          const y = lerp(by, w.y, tt);
          const ww = lerp(bw, w.w, tt);
          const hh = lerp(bh, w.h, tt);
          g.globalAlpha = 1 - k * 0.3;
          g.strokeRect(Math.round(x) * U + U / 2, Math.round(y) * U + U / 2, Math.round(ww) * U, Math.round(hh) * U);
        }
        g.globalAlpha = 1;
        continue;
      }
      const jx = shakeAmt > 0.05 ? Math.round((hash(wi, Math.floor(st.t * 24)) - 0.5) * 2 * shakeAmt) : 0;
      const jy = shakeAmt > 0.05 ? Math.round((hash(wi + 9, Math.floor(st.t * 24)) - 0.5) * 2 * shakeAmt) : 0;
      const X = (w.x + jx) * U;
      const Y = (w.y + jy) * U;
      const WW = w.w * U;
      const HH = w.h * U;
      const active = w === topWin || w.kind === 'progress';
      let title = w.title;
      if (w.kind === 'notes' && tension > 0.45) title = 'unsaid.txt (not responding)';
      const cl = chrome(g, X, Y, WW, HH, U, T, title, active, w.kind === 'volume' || w.kind === 'progress');
      const pressed = w.press > 0;
      g.save();
      g.beginPath();
      g.rect(cl.x, cl.y, cl.w, cl.h);
      g.clip();
      switch (w.kind) {
        case 'notes': {
          // menu row, then a sunken page the line is typed into
          g.font = fUI;
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillStyle = T.ink;
          let mx0 = cl.x + 3 * U;
          for (const m of ['file', 'edit', 'search', 'help']) {
            g.fillText(m, mx0, cl.y + 4 * U);
            mx0 += g.measureText(m).width + 7 * U;
          }
          const px = cl.x;
          const py = cl.y + 9 * U;
          const pw = cl.w;
          const ph = cl.h - 9 * U;
          well(g, px, py, pw, ph, U, T, T.paper);
          // what to type
          let cur = '';
          let shown = 0;
          // the sung line when there is one; before the first line (and without lyrics) the song's facts
          let facts = !lines;
          if (lines) {
            const lyr = currentLyric(a.time);
            if (lyr) {
              if (lyr.i !== st.lastLine) {
                if (st.lastLine >= 0 && lines[st.lastLine]) st.history.push(lines[st.lastLine].text);
                st.lastLine = lyr.i;
              }
              if (st.factIdx >= 0) st.factIdx = -1;
              cur = lyr.text;
              shown = sungChars(lines[lyr.i], a.time);
            } else if (st.lastLine >= 0 && lines[st.lastLine] && a.time < lines[st.lastLine].end + 6) {
              cur = lines[st.lastLine].text;
              shown = cur.length;
            } else facts = true;
          }
          if (facts) {
            const bar = (4 * 60) / Math.max(60, a.bpm || 120);
            const slot = bar * 2;
            const idx = Math.floor(a.time / slot);
            const mood = f.analysis?.character?.mood ?? f.analysis?.tags?.slice(0, 2).join(', ') ?? 'something';
            const list = [
              `${info.title}`,
              `by ${info.artist}`,
              `${Math.round(a.bpm || 120)} bpm · ${fmtClock(a.duration || f.analysis?.duration || 0)}`,
              `now playing: the ${secLabel}`,
              `feeling: ${mood}`,
              'you have +99 unsaid things',
              'note to self: call back.',
            ];
            if (idx !== st.factIdx) {
              if (st.factIdx >= 0) st.history.push(list[st.factIdx % list.length]);
              else if (st.lastLine >= 0 && lines?.[st.lastLine]) {
                st.history.push(lines[st.lastLine].text);
                st.lastLine = -1;
              }
              st.factIdx = idx;
            }
            cur = list[idx % list.length];
            shown = Math.min(cur.length, Math.floor(((a.time - idx * slot) / (slot * 0.55)) * cur.length));
          }
          if (st.history.length > 8) st.history.splice(0, st.history.length - 8);
          const lh = 9 * U;
          const maxW = pw - 8 * U;
          const curLines = wrap(g, cur, maxW, fMono);
          const rows: { s: string; old: boolean }[] = [];
          for (const hl of st.history) for (const s of wrap(g, hl, maxW, fMono)) rows.push({ s, old: true });
          let left = shown;
          let caretRow = -1;
          let caretX = 0;
          g.font = fMono;
          curLines.forEach((s, i) => {
            const n = Math.max(0, Math.min(s.length, left));
            left -= s.length + 1;
            rows.push({ s: s.slice(0, n), old: false });
            if (n < s.length || i === curLines.length - 1) {
              if (caretRow < 0) {
                caretRow = rows.length - 1;
                caretX = g.measureText(s.slice(0, n)).width;
              }
            }
          });
          // drop trailing empty reveal rows so the caret sits on the last typed letter
          while (rows.length > 1 && !rows[rows.length - 1].old && rows[rows.length - 1].s === '' && caretRow < rows.length - 1) rows.pop();
          const fit = Math.max(1, Math.floor((ph - 6 * U) / lh));
          const startRow = Math.max(0, rows.length - fit);
          g.textAlign = 'left';
          g.textBaseline = 'top';
          for (let r = startRow; r < rows.length; r++) {
            g.fillStyle = rows[r].old ? T.inkSoft : T.ink;
            g.fillText(rows[r].s, px + 4 * U, py + 3 * U + (r - startRow) * lh);
          }
          const blink = a.playing ? a.beatPhase < 0.5 : Math.floor(st.t * 2) % 2 === 0;
          if (blink && caretRow >= startRow) {
            g.fillStyle = T.ink;
            g.fillRect(Math.round(px + 4 * U + caretX + U), py + 3 * U + (caretRow - startRow) * lh, U, 8 * U);
          }
          // scroll bar
          g.fillStyle = T.grey;
          g.fillRect(px + pw - 8 * U, py + U, 7 * U, ph - 2 * U);
          bevel(g, px + pw - 8 * U, py + U + Math.round((ph - 14 * U) * clamp01(fe.songT)), 7 * U, 12 * U, U, T);
          break;
        }
        case 'player': {
          const lx = cl.x + 2 * U;
          const ly = cl.y + U;
          const lw = cl.w - 4 * U;
          const lh2 = cl.h - 20 * U;
          well(g, lx, ly, lw, lh2, U, T, T.lcd);
          // time read-out
          g.font = `600 ${Math.round(11 * U)}px ${FONT_MONO}`;
          g.textAlign = 'left';
          g.textBaseline = 'top';
          g.fillStyle = T.lcdText;
          g.fillText(fmtClock(a.time), lx + 4 * U, ly + 3 * U);
          g.font = `500 ${Math.round(5.5 * U)}px ${FONT_MONO}`;
          g.fillStyle = T.lcdText;
          g.globalAlpha = 0.7;
          const marquee = `${info.title} — ${info.artist}   ·   `;
          const mw = g.measureText(marquee).width;
          const mx = -((st.t * 12 * U) % mw);
          g.save();
          g.beginPath();
          g.rect(lx + 2 * U, ly + 15 * U, lw * 0.5, 8 * U);
          g.clip();
          g.fillText(marquee + marquee + marquee, lx + 4 * U + mx, ly + 16 * U);
          g.restore();
          g.globalAlpha = 1;
          // spectrum
          const sx = lx + lw * 0.52;
          const sw2 = lw * 0.46;
          const bars = 14;
          const bwid = Math.max(U, Math.floor(sw2 / bars) - U);
          const segH = 2 * U;
          const maxSeg = Math.floor((lh2 - 6 * U) / (segH + U));
          for (let b = 0; b < bars; b++) {
            const i0 = Math.floor(Math.pow(b / bars, 1.4) * 110);
            const i1 = Math.max(i0 + 1, Math.floor(Math.pow((b + 1) / bars, 1.4) * 110));
            let v = 0;
            for (let k = i0; k < i1; k++) v = Math.max(v, a.spectrum[k] ?? 0);
            const lit = Math.round(clamp01(v * 1.15) * maxSeg);
            for (let s = 0; s < maxSeg; s++) {
              g.fillStyle = s < lit ? (s >= maxSeg - 2 ? T.alert : T.lcdText) : T.lcdDim;
              g.fillRect(Math.round(sx + b * (bwid + U)), ly + lh2 - 3 * U - (s + 1) * (segH + U), bwid, segH);
            }
          }
          // progress bar
          const dur = a.duration || f.analysis?.duration || 1;
          const by = cl.y + cl.h - 17 * U;
          well(g, cl.x + 2 * U, by, cl.w - 4 * U, 5 * U, U, T, T.paper);
          g.fillStyle = T.sel;
          g.fillRect(cl.x + 3 * U, by + U, Math.round((cl.w - 6 * U) * clamp01(a.time / dur)), 3 * U);
          // transport
          const labels = ['▶', '❚❚', '■', '▶▶'];
          labels.forEach((lab, i) => {
            button(g, cl.x + (2 + i * 17) * U, cl.y + cl.h - 10 * U, 15 * U, 9 * U, U, T, lab, i === 0 && (pressed || a.kick > 0.85), `600 ${Math.round(5 * U)}px ${FONT_SANS}`);
          });
          g.font = fUI;
          g.textAlign = 'right';
          g.textBaseline = 'middle';
          g.fillStyle = T.ink;
          g.fillText(`-${fmtClock(Math.max(0, dur - a.time))}`, cl.x + cl.w - 3 * U, cl.y + cl.h - 5.5 * U);
          break;
        }
        case 'volume': {
          const sbw = 26 * U;
          const sbx = Math.round(cl.x + cl.w / 2 - sbw / 2);
          bevel(g, sbx, cl.y + U, sbw, 15 * U, U, T, pressed);
          speaker(g, sbx + 6 * U + (pressed ? U : 0), cl.y + 3.5 * U + (pressed ? U : 0), U, T.ink, 1 + Math.round(a.level * 2.4));
          g.font = fUIb;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillStyle = T.ink;
          g.fillText('volume', cl.x + cl.w / 2, cl.y + 22 * U);
          const segs = 10;
          const mw = cl.w - 8 * U;
          const sw3 = Math.floor(mw / segs);
          const lit = Math.round(clamp01(a.level * 1.2) * segs);
          well(g, cl.x + 3 * U, cl.y + cl.h - 14 * U, mw + 2 * U, 10 * U, U, T, T.paper);
          for (let s = 0; s < segs; s++) {
            g.fillStyle = s < lit ? (s >= segs - 2 ? T.alert : T.sel) : T.hi;
            g.fillRect(cl.x + 4 * U + s * sw3 + U, cl.y + cl.h - 12 * U, sw3 - U * 1.5, 6 * U);
          }
          break;
        }
        case 'paint': {
          // tool column
          const tc = 2;
          const tsz = 10 * U;
          for (let i = 0; i < 10; i++) {
            const tx = cl.x + U + (i % tc) * (tsz + U);
            const ty = cl.y + U + Math.floor(i / tc) * (tsz + U);
            if (ty + tsz > cl.y + cl.h - 14 * U) break;
            const on = i === st.swatch % 10;
            bevel(g, tx, ty, tsz, tsz, U, T, on);
            g.fillStyle = T.ink;
            const cx = tx + 3 * U;
            const cy = ty + 3 * U;
            switch (i % 5) {
              case 0:
                g.fillRect(cx, cy + 3 * U, 4 * U, U);
                g.fillRect(cx + 3 * U, cy, U, 4 * U);
                break;
              case 1:
                g.strokeStyle = T.ink;
                g.lineWidth = U;
                g.strokeRect(cx + U / 2, cy + U / 2, 4 * U, 3 * U);
                break;
              case 2:
                for (let d = 0; d < 4; d++) g.fillRect(cx + d * U, cy + (3 - d) * U, U, U);
                break;
              case 3:
                g.beginPath();
                g.arc(cx + 2 * U, cy + 2 * U, 2 * U, 0, Math.PI * 2);
                g.fill();
                break;
              default:
                g.font = `800 ${Math.round(6 * U)}px ${FONT_SANS}`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText('A', cx + 2 * U, cy + 2.5 * U);
            }
          }
          const ax = cl.x + tc * (tsz + U) + 2 * U;
          const ay = cl.y + U;
          const aw = cl.x + cl.w - ax - U;
          const ah = cl.h - 15 * U;
          well(g, ax, ay, aw, ah, U, T, T.paper);
          // the pen scribbles the level onto a page that keeps it
          const dw = Math.max(1, Math.round(aw - 2 * U));
          const dh = Math.max(1, Math.round(ah - 2 * U));
          if (st.doodle.width !== dw || st.doodle.height !== dh) {
            st.doodle.width = dw;
            st.doodle.height = dh;
            st.penX = 0;
            st.penY = dh / 2;
          }
          const dg = c2d(st.doodle);
          const nx = st.penX + dt * dw * 0.09 * (0.6 + inten);
          const ny = dh * (0.78 - 0.6 * clamp01(a.level * 1.1)) + Math.sin(st.t * 7.3) * a.mid * dh * 0.08;
          dg.strokeStyle = T.alert;
          dg.lineWidth = Math.max(1, U * 1.2);
          dg.lineCap = 'round';
          dg.beginPath();
          dg.moveTo(st.penX, st.penY);
          dg.lineTo(Math.min(nx, dw), ny);
          dg.stroke();
          st.penX = nx;
          st.penY = ny;
          if (st.penX > dw) {
            // a new page: the old scribble fades back
            dg.fillStyle = T.paper;
            dg.globalAlpha = 0.65;
            dg.fillRect(0, 0, dw, dh);
            dg.globalAlpha = 1;
            st.penX = 0;
          }
          g.drawImage(st.doodle, ax + U, ay + U);
          // the live waveform drawn across it
          g.strokeStyle = T.sel;
          g.lineWidth = U;
          g.beginPath();
          const wv = a.waveform;
          const nPts = 64;
          for (let i = 0; i <= nPts; i++) {
            const v = wv[Math.floor((i / nPts) * 511)] ?? 0;
            const x = ax + U + (i / nPts) * dw;
            const y = ay + U + dh * 0.5 + v * dh * 0.4;
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
          // pen tip
          g.fillStyle = T.ink;
          g.fillRect(Math.round(ax + U + st.penX - U), Math.round(ay + U + st.penY - U), 2 * U, 2 * U);
          // swatches
          const sy = cl.y + cl.h - 12 * U;
          const swc = [T.ink, T.inkSoft, T.alert, T.title, T.title2, css(T.hill), css(T.hillHi), T.grey, T.hi, T.paper, T.folder, T.skyLow];
          bevel(g, cl.x + U, sy, 11 * U, 11 * U, U, T, true);
          g.fillStyle = swc[st.swatch % swc.length];
          g.fillRect(cl.x + 3 * U, sy + 2 * U, 7 * U, 7 * U);
          for (let i = 0; i < swc.length; i++) {
            const x = cl.x + (14 + (i >> 1) * 7) * U;
            const y = sy + (i & 1) * 6 * U;
            if (x + 6 * U > cl.x + cl.w) break;
            g.fillStyle = T.lo;
            g.fillRect(x, y, 6 * U, 5 * U);
            g.fillStyle = swc[i];
            g.fillRect(x + U, y + U, 4 * U, 3 * U);
          }
          break;
        }
        case 'feelings': {
          g.font = fUI;
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillStyle = T.ink;
          g.fillText(`${FILES.length} objects · 0 bytes free`, cl.x + 3 * U, cl.y + 4 * U);
          well(g, cl.x, cl.y + 9 * U, cl.w, cl.h - 9 * U, U, T, T.paper);
          const rows = Math.floor((cl.h - 12 * U) / (9 * U));
          for (let r = 0; r < Math.min(rows, FILES.length); r++) {
            const y = cl.y + 11 * U + r * 9 * U;
            const sel = r === st.sel % Math.min(rows, FILES.length);
            if (sel) {
              g.fillStyle = T.sel;
              g.fillRect(cl.x + 12 * U, y, cl.w - 16 * U, 8 * U);
            }
            g.fillStyle = r % 3 === 1 ? T.folder : T.hi;
            g.fillRect(cl.x + 4 * U, y + U, 5 * U, 6 * U);
            g.fillStyle = T.lo;
            g.fillRect(cl.x + 4 * U, y + 6 * U, 5 * U, U);
            g.fillStyle = sel ? T.titleText : T.ink;
            g.fillText(FILES[r], cl.x + 14 * U, y + 4.5 * U);
          }
          break;
        }
        case 'progress': {
          const done = fe.sinceDrop < 0.7;
          const pct = done ? 100 : Math.min(99, Math.round(tension * 100));
          g.font = fUI;
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          g.fillStyle = T.ink;
          const dots = '.'.repeat(1 + (Math.floor(st.t * 3) % 3));
          g.fillText(done ? 'done. here it comes.' : `loading feelings${dots}  ${pct}%`, cl.x + 4 * U, cl.y + 5 * U);
          const bx = cl.x + 3 * U;
          const by = cl.y + 11 * U;
          const bw = cl.w - 6 * U;
          well(g, bx, by, bw, 9 * U, U, T, T.paper);
          const blocks = Math.floor((bw - 4 * U) / (6 * U));
          const lit = Math.round((pct / 100) * blocks);
          g.fillStyle = T.sel;
          for (let i = 0; i < lit; i++) g.fillRect(bx + 2 * U + i * 6 * U, by + 2 * U, 5 * U, 5 * U);
          button(g, cl.x + cl.w - 40 * U, cl.y + cl.h - 11 * U, 36 * U, 10 * U, U, T, 'cancel', pressed, fUI);
          break;
        }
      }
      g.restore();
    }

    /* ── poster type over the desk ── */
    const posterAmt = num(P, 'poster', 1);
    if (posterAmt > 0.01) {
      const portrait = W < H * 0.9;
      const title = info.title && info.title !== 'Untitled' ? info.title : 'unsaid things';
      const words = title.split(/\s+/).filter(Boolean);
      let cut = 1;
      if (words.length > 2) {
        let best = 1e9;
        for (let k = 1; k < words.length; k++) {
          const d = Math.abs(words.slice(0, k).join(' ').length - words.slice(k).join(' ').length * 0.8);
          if (d < best) {
            best = d;
            cut = k;
          }
        }
      }
      const l1 = words.length > 1 ? words.slice(0, cut).join(' ') : title;
      const l2 = words.length > 1 ? words.slice(cut).join(' ') : '';
      const phoneOn = bool(P, 'phone', true);
      const x0 = portrait ? cw * 0.06 : Math.max(46 * U, cw * 0.2 * Math.min(1, (W / H - 0.9) * 1.6 + 0.35));
      // the right edge the type may reach: short of the hanging phone on a wide frame
      const right = phoneOn ? cw * (portrait ? 0.85 : 0.83) : cw * 0.95;
      const maxW = (right - x0) * (portrait ? 1 : 0.8);
      let px = short * 0.2 * posterAmt;
      g.font = `800 ${px.toFixed(1)}px ${FONT_SANS}`;
      g.letterSpacing = `${(-0.06 * px).toFixed(1)}px`;
      const w1 = g.measureText(l1).width;
      if (w1 > maxW) px *= maxW / w1;
      if (l2) {
        const p2 = px * 0.6;
        g.font = `800 ${p2.toFixed(1)}px ${FONT_SANS}`;
        g.letterSpacing = `${(-0.055 * p2).toFixed(1)}px`;
        const w2 = g.measureText(l2).width;
        if (w2 > right - x0) px *= (right - x0) / w2;
      }
      const px2 = px * 0.6;
      const y1 = (portrait ? ch * 0.035 : ch * 0.03) + px * 0.82;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = T.poster;
      g.font = `800 ${px.toFixed(1)}px ${FONT_SANS}`;
      g.letterSpacing = `${(-0.06 * px).toFixed(1)}px`;
      g.fillText(l1, Math.round(x0), Math.round(y1));
      const w1b = g.measureText(l1).width;
      if (l2) {
        g.font = `800 ${px2.toFixed(1)}px ${FONT_SANS}`;
        g.letterSpacing = `${(-0.055 * px2).toFixed(1)}px`;
        const w2 = g.measureText(l2).width;
        const x2 = Math.min(right - w2, x0 + Math.max(w1b * 0.42, w1b - w2 * 0.55));
        g.fillText(l2, Math.round(Math.max(x0, x2)), Math.round(y1 + px2 * 0.98));
      }
      g.letterSpacing = '0px';
      g.font = `500 ${Math.round(Math.max(9, short * 0.028))}px ${FONT_MONO}`;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText(`${info.artist.toLowerCase()}.`, Math.round(cw * (bool(P, 'phone', true) ? (W < H * 0.9 ? 0.84 : 0.875) : 0.96)), Math.round(ch * 0.04));
    }

    /* ── the phone nobody picks up ── */
    {
      const k = 26;
      const windT = fe.windX * (0.05 + 0.1 * fe.gust) + Math.sin(fe.windPhase * 1.7) * 0.05 * (0.3 + fe.gust);
      st.swingV += (-(st.swing - windT) * k - st.swingV * 2.2) * dt;
      if (a.kickHit) st.swingV += (hash(a.beatCount, 5) - 0.5) * 0.9 * (0.4 + inten);
      if (dropNow) st.swingV += 2.4;
      st.swing += st.swingV * dt;
      st.swing = Math.max(-0.7, Math.min(0.7, st.swing));
    }
    if (bool(P, 'phone', true)) {
      const portrait = W < H * 0.9;
      const ax = (portrait ? 0.88 : 0.9) * cw;
      const len = (portrait ? 0.2 : 0.24) * ch + (a.kick * 3 + Math.sin(st.t * 1.1) * 1.5) * U;
      const ring = clamp01((tension - 0.15) * 1.6);
      phone(g, st, ax, len, st.swing, ring, U, T, st.t);
    }

    /* ── the drop cascade: a dialog dragged across the screen, leaving its copies ── */
    if (st.spriteKey !== `${pk}|${lk}`) {
      st.spriteKey = `${pk}|${lk}`;
      const sw = Math.min(132, W - 20);
      const sh = 50;
      st.sprite = canvas(sw * U + 3 * U, sh * U + 3 * U);
      const sg = c2d(st.sprite);
      const cl = chrome(sg, 0, 0, sw * U, sh * U, U, T, 'heart.exe', true, true);
      warnIcon(sg, cl.x + 4 * U, cl.y + 4 * U, 14 * U, U, T, 1);
      sg.font = fUI;
      sg.textAlign = 'left';
      sg.textBaseline = 'middle';
      sg.fillStyle = T.ink;
      sg.fillText('heart.exe is not responding.', cl.x + 24 * U, cl.y + 10 * U);
      button(sg, cl.x + cl.w / 2 - 18 * U, cl.y + cl.h - 13 * U, 36 * U, 11 * U, U, T, 'ok', false, fUI);
    }
    const cascLen = num(P, 'cascade', 0.8);
    if (st.cascOn && cascLen > 0.01) {
      const dur = 0.5 + 2.2 * cascLen;
      st.casc += dt;
      const tg = c2d(st.trail);
      const sw = st.sprite.width / U;
      const sh = st.sprite.height / U;
      const path = (p: number): [number, number] => {
        const x = lerp(2, W - sw - 2, p) + Math.sin(p * Math.PI * 2.2) * W * 0.06;
        const y = lerp(2, deskH - sh - 2, 0.15 + 0.7 * p) - Math.sin(p * Math.PI) * deskH * 0.22 + Math.sin(p * Math.PI * 5) * deskH * 0.04;
        return [Math.max(0, Math.min(W - sw, x)), Math.max(0, Math.min(deskH - sh, y))];
      };
      while (st.stamp <= Math.min(st.casc, dur)) {
        const [x, y] = path(st.stamp / dur);
        tg.drawImage(st.sprite, Math.round(x) * U, Math.round(y) * U);
        st.stamp += 0.028;
      }
      const fade = smooth(0.32, 0.7, fe.release);
      if (fade < 0.01 && st.casc > dur) st.cascOn = false;
      else {
        g.globalAlpha = st.casc < dur ? 1 : fade;
        g.drawImage(st.trail, 0, 0);
        g.globalAlpha = 1;
      }
    }

    /* ── error dialogs ── */
    for (const e of st.errs) {
      const X = e.x * U;
      const Y = e.y * U;
      const cl = chrome(g, X, Y, e.w * U, e.h * U, U, T, e.title, true, true);
      warnIcon(g, cl.x + 4 * U, cl.y + 4 * U, 14 * U, U, T, e.icon);
      g.font = fUI;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = T.ink;
      e.lines.forEach((s, i) => g.fillText(s, cl.x + 24 * U, cl.y + 4 * U + i * 9 * U));
      button(g, cl.x + cl.w / 2 - 18 * U, cl.y + cl.h - 13 * U, 36 * U, 11 * U, U, T, e.btn, e.press > 0, fUI);
    }

    /* ── tray balloon: in the quiet parts ── */
    const unsaid = Math.min(99, 7 + Math.floor(st.snares * 1.4));
    const quiet = inten < 0.4 && fe.sectionT > 0.08;
    st.balloon = damp(st.balloon, quiet ? 1 : 0, 3, dt);
    if (st.balloon > 0.02) {
      const bw = Math.min(124, W - 10);
      const bh = 26;
      const bx = W - bw - 4;
      const by = H - TBH - bh - 7 + Math.round((1 - st.balloon) * 6);
      g.globalAlpha = st.balloon;
      g.fillStyle = T.shadow;
      g.fillRect((bx + 2) * U, (by + 2) * U, bw * U, bh * U);
      g.fillStyle = T.ink;
      g.fillRect((bx - 1) * U, (by - 1) * U, (bw + 2) * U, (bh + 2) * U);
      g.fillStyle = T.paper;
      g.fillRect(bx * U, by * U, bw * U, bh * U);
      // the tail toward the clock
      for (let k = 0; k < 5; k++) {
        g.fillStyle = T.ink;
        g.fillRect((bx + bw - 22 + k) * U, (by + bh + k) * U, (6 - k) * U + U, U);
        g.fillStyle = T.paper;
        g.fillRect((bx + bw - 21 + k) * U, (by + bh - 1 + k) * U, Math.max(0, 5 - k) * U, U);
      }
      warnIcon(g, (bx + 4) * U, (by + 5) * U, 9 * U, U, T, 0);
      g.font = fUIb;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = T.ink;
      g.fillText(`you have +${unsaid} unsaid things`, (bx + 17) * U, (by + 4) * U);
      g.font = fUI;
      g.fillStyle = T.inkSoft;
      g.fillText('click here to say them.', (bx + 17) * U, (by + 14) * U);
      g.globalAlpha = 1;
    }

    /* ── taskbar ── */
    const ty = (H - TBH) * U;
    bevel(g, 0, ty, cw, ch - ty, U, T);
    g.fillStyle = T.hi;
    g.fillRect(0, ty + U, cw, U);
    // the menu button: three little level bars and the word hum
    const menuPressed = st.click > 0 && secs !== undefined && fe.sinceDrop < 0.2;
    bevel(g, 2 * U, ty + 2 * U, 34 * U, (TBH - 4) * U, U, T, menuPressed);
    g.fillStyle = T.ink;
    g.fillRect(2 * U, ty + (TBH - 2) * U, 35 * U, U);
    const lv = [a.bass, a.mid, a.air];
    const cols = [T.alert, T.title, css(T.hill)];
    for (let i = 0; i < 3; i++) {
      const hh = Math.max(2, Math.round(2 + clamp01(lv[i] * 1.2) * 6));
      g.fillStyle = cols[i];
      g.fillRect((5 + i * 3) * U, ty + (TBH - 4 - hh) * U, 2 * U, hh * U);
    }
    g.font = fUIb;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = T.ink;
    g.fillText('hum', 15 * U, ty + (TBH / 2) * U + U * 0.5);
    g.fillStyle = T.lo;
    g.fillRect(38 * U, ty + 3 * U, U, (TBH - 6) * U);
    for (const w of st.wins) {
      if (w.a <= 0 || w.kind === 'progress') continue;
      const [bx, by, bw, bh] = taskBtn(w);
      const act = w === topWin;
      bevel(g, bx * U, by * U, bw * U, bh * U, U, T, act, act ? T.hi : T.grey);
      g.save();
      g.beginPath();
      g.rect((bx + 2) * U, by * U, (bw - 4) * U, bh * U);
      g.clip();
      g.font = act ? fUIb : fUI;
      g.fillStyle = T.ink;
      g.fillText(w.title, (bx + 3) * U, (by + bh / 2) * U + U * 0.5);
      g.restore();
    }
    // tray: speaker, a little level, the clock (the shared time of day)
    const trW = 60;
    const trX = W - trW - 2;
    well(g, trX * U, ty + 2 * U, trW * U, (TBH - 4) * U, U, T, T.grey);
    speaker(g, (trX + 3) * U, ty + 3 * U, Math.max(1, Math.round(U * 0.8)), T.ink, a.level > 0.4 ? 2 : 1);
    const hours = (((fe.day % 1) + 1) % 1) * 24;
    const hh12 = Math.floor(hours) % 12 || 12;
    const mm = Math.floor((hours % 1) * 60);
    const colon = !a.playing || a.beatPhase < 0.5 ? ':' : ' ';
    g.font = fUI;
    g.textAlign = 'right';
    g.fillStyle = T.ink;
    g.fillText(`${hh12}${colon}${String(mm).padStart(2, '0')} ${hours >= 12 ? 'pm' : 'am'}`, (trX + trW - 3) * U, ty + (TBH / 2) * U + U * 0.5);

    /* ── the cursor ── */
    const ox = st.click > 0 ? U : 0;
    g.drawImage(st.arrow, Math.round(st.cx * U) + ox, Math.round(st.cy * U) + ox);
    if (st.click > 0) {
      // a cartoon click: short pixel ticks bursting from the arrow's tip
      const p = 1 - st.click / 0.2;
      const r0 = (4 + p * 5) * U;
      const q = Math.max(1, Math.round(U * 1.5));
      const bx = Math.round(st.cx * U);
      const by = Math.round(st.cy * U);
      g.fillStyle = T.ink;
      for (let i = 0; i < 5; i++) {
        const an = Math.PI * (0.9 + i * 0.3);
        for (let d = 0; d < 3; d++) {
          const rr = r0 + d * q;
          g.fillRect(Math.round(bx + Math.cos(an) * rr), Math.round(by + Math.sin(an) * rr), q, q);
        }
      }
    }

    /* ── scanned grain ── */
    const grain = num(P, 'grain', 0.5);
    if (grain > 0.01) {
      const pat = g.createPattern(st.grain, 'repeat');
      if (pat) {
        g.globalAlpha = grain * 0.22;
        g.fillStyle = pat;
        g.save();
        g.translate((Math.floor(st.t * 12) * 37) % 256, (Math.floor(st.t * 12) * 91) % 256);
        g.fillRect(-256, -256, cw + 512, ch + 512);
        g.restore();
        g.globalAlpha = 1;
      }
    }
    g.imageSmoothingEnabled = true;
  },
});
