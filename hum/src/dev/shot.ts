/**
 * Dev helper (served at /shot.html by `npm run dev`, not part of the build): ONE hand-built shot, to
 * judge by eye before any of it goes near the director. A video clip is the bed; bands of it swap for
 * flat colours taken from the clip itself; bare shapes and a word sit on top; and the footage runs on
 * a speed ramp locked to the song: it waits, speeds up into the drop, freezes, bursts and settles.
 * Nothing here asks Claude for anything. The pieces live in src/shot/.
 *
 *   /shot.html                       the built-in demo song, with a stand-in picture until a clip is dropped
 *     ?clip=/footage.local/x.mp4     a clip served by the dev server (the folder is ignored by git)
 *     &word=LOUDER                   the big word
 *     &at=42.5                       build the shot round this second of the song, not its biggest drop
 *     &fx=0.5&fy=0.55                the focus point (0..1 from the bottom-left); clicking the picture sets it
 *     &w=1280&h=720
 *
 *   Drop a video and a song on the page (or use Clip / Song). Space plays, R restarts, ← → step a frame.
 *
 *   await __shot.ready               → { ok, error }
 *   await __shot.sheet([..seconds into the shot..], cols)   lays stills out over the page, for checking
 *   __shot.clearSheet(); __shot.info()
 */
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import * as THREE from 'three';
import { analyzeTrack } from '../audio/analysis';
import { DEMO_TRACKS } from '../audio/demoTracks';
import type { TrackAnalysis } from '../core/types';
import { Footage, FootagePass, footageStateAt } from '../shot/footage';
import { Overlay } from '../shot/overlay';
import { DEFAULT_PALETTE, paletteFromPixels, type ShotPalette } from '../shot/palette';
import { buildCurve, scoreFromAnalysis, type ShotScore, type TimeCurve } from '../shot/time';

THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const W = Number(q.get('w')) || 1280;
const H = Number(q.get('h')) || 720;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('shot');
canvas.width = W;
canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.autoClear = false;

const footage = new Footage();
const pass = new FootagePass();
const overlay = new Overlay();

let analysis: TrackAnalysis | null = null;
let buffer: AudioBuffer | null = null;
let songName = '';
let hasClip = false;
let palette: ShotPalette = DEFAULT_PALETTE;
let score: ShotScore | null = null;
let curve: TimeCurve | null = null;
const focus = { x: Number(q.get('fx')) || 0.5, y: Number(q.get('fy')) || 0.55 };

/** a picture to stand in until a clip is dropped: a soft sky over ground, so the bands have something to cut */
function standIn(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 360);
  sky.addColorStop(0, '#9db7d6');
  sky.addColorStop(0.55, '#e9d9c4');
  sky.addColorStop(0.56, '#5b6b55');
  sky.addColorStop(1, '#20261f');
  g.fillStyle = sky;
  g.fillRect(0, 0, 640, 360);
  const sun = g.createRadialGradient(430, 150, 0, 430, 150, 190);
  sun.addColorStop(0, 'rgba(255,244,214,0.95)');
  sun.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, 640, 360);
  return new THREE.CanvasTexture(c);
}
const placeholder = standIn();
pass.setSource(placeholder, 640 / 360);

/* ───────── the song ───────── */

let ctx: AudioContext | null = null;
let node: AudioBufferSourceNode | null = null;
let playing = false;
let startedAt = 0;
let startedFrom = 0;
/** song time (s) shown while paused */
let pausedAt = 0;

function stopNode() {
  if (!node) return;
  node.onended = null;
  try {
    node.stop();
  } catch {
    /* already stopped */
  }
  node.disconnect();
  node = null;
}

function play(from: number) {
  if (!buffer) return;
  ctx ??= new AudioContext();
  void ctx.resume();
  stopNode();
  node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.start(0, Math.max(0, from));
  startedAt = ctx.currentTime;
  startedFrom = from;
  playing = true;
  $('play').textContent = 'Pause';
}

function pause() {
  if (playing) pausedAt = songTime();
  stopNode();
  playing = false;
  $('play').textContent = 'Play';
}

// what is being heard now: the context's clock runs ahead of the speakers by its output latency
const songTime = () => (playing && ctx ? startedFrom + Math.max(0, ctx.currentTime - startedAt - (ctx.outputLatency || 0)) : pausedAt);

async function loadSong(blob: Blob, name: string) {
  pause();
  hint('Listening to the song…');
  const data = await blob.arrayBuffer();
  // decoding needs no sound card and no click: an offline context will do
  buffer = await new OfflineAudioContext(2, 2, 44100).decodeAudioData(data);
  analysis = await analyzeTrack(buffer, []);
  songName = name;
  rebuild();
}

/* ───────── the clip ───────── */

async function loadClip(src: string) {
  await footage.load(src);
  hasClip = true;
  pass.setSource(footage.texture, footage.aspect);
  // the palette and the brightness bands come from three frames across the clip
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 36 * 3;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  for (const [i, at] of [0.2, 0.5, 0.8].entries()) {
    await footage.seek(footage.duration * at);
    g.drawImage(footage.video, 0, i * 36, 64, 36);
  }
  palette = paletteFromPixels(g.getImageData(0, 0, 64, 36 * 3).data);
  rebuild();
}

/* ───────── the shot ───────── */

const wordBox = $<HTMLInputElement>('word');
wordBox.value = (q.get('word') ?? '').slice(0, 16);

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function rebuild() {
  if (!analysis) return;
  const at = q.get('at') ? Number(q.get('at')) : undefined;
  score = scoreFromAnalysis(analysis, at);
  curve = buildCurve(score, hasClip ? footage.duration : 1e6);
  pass.setPalette(palette);
  const firstWord = songName.replace(/\.[a-z0-9]+$/i, '').split(/[\s_\-–—]+/)[0] ?? '';
  const word = (wordBox.value.trim() || firstWord || 'hum').toUpperCase().slice(0, 16);
  overlay.build({ score, palette, aspect: W / H, word, caption: `${songName.replace(/\.[a-z0-9]+$/i, '')} · ${clock(score.hit)}`, freeze: curve.freeze });
  pausedAt = Math.min(Math.max(pausedAt, score.start), score.end);
  if (pausedAt === score.end) pausedAt = score.start;
  hint(
    `${songName}: the shot runs ${clock(score.start)}–${clock(score.end)} round the hit at ${clock(score.hit)}. ` +
      (hasClip ? (curve.flip ? 'The clip is short for this shot, so the hit cuts to its mirror image.' : '') : 'Drop a video clip on the page to use your own footage.') +
      ' Click the picture to move the focus point.',
  );
}

function hint(text: string) {
  $('hint').textContent = text;
}

function draw(t: number) {
  if (!score || !curve) return;
  renderer.clear();
  pass.render(renderer, W, H, focus, footageStateAt(t, score, curve));
  overlay.update(t, focus);
  overlay.render(renderer);
}

function readout(t: number) {
  if (!score || !curve) return;
  const speed = curve.speed(t);
  const part = t < score.hit - 4 * score.beat ? 'wait' : t < score.hit ? 'wind up' : t < score.hit + curve.freeze ? 'HIT' : 'burst';
  $('read').textContent = `${(t - score.hit >= 0 ? '+' : '−') + Math.abs(t - score.hit).toFixed(2)}s  ${speed.toFixed(2)}×  ${part}`;
  $<HTMLInputElement>('scrub').value = String((t - score.start) / (score.end - score.start));
}

function frame() {
  requestAnimationFrame(frame);
  if (!score || !curve) return;
  let t = songTime();
  if (playing && t >= score.end) {
    play(score.start);
    t = score.start;
  }
  if (hasClip) footage.follow(curve.footage(t), curve.rate(t), playing);
  draw(t);
  readout(t);
}

/* ───────── controls ───────── */

$('play').addEventListener('click', () => (playing ? pause() : play(score ? Math.min(Math.max(pausedAt, score.start), score.end - 0.05) : 0)));
$<HTMLInputElement>('scrub').addEventListener('input', (e) => {
  if (!score) return;
  const t = score.start + Number((e.target as HTMLInputElement).value) * (score.end - score.start);
  if (playing) play(t);
  else pausedAt = t;
});
wordBox.addEventListener('change', rebuild);
canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  focus.x = (e.clientX - r.left) / r.width;
  focus.y = 1 - (e.clientY - r.top) / r.height;
});
window.addEventListener('keydown', (e) => {
  if (e.target === wordBox || !score) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'r' || e.key === 'R') {
    if (playing) play(score.start);
    else pausedAt = score.start;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    pause();
    pausedAt = Math.min(score.end, Math.max(score.start, pausedAt + (e.key === 'ArrowRight' ? 1 : -1) / 30));
  }
});

function takeFiles(files: FileList | null | undefined) {
  for (const f of Array.from(files ?? [])) {
    const isVideo = f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name);
    if (isVideo) void loadClip(URL.createObjectURL(f)).catch((err) => hint(String(err instanceof Error ? err.message : err)));
    else void loadSong(f, f.name).catch(() => hint('That song could not be opened.'));
  }
}
$<HTMLInputElement>('clip').addEventListener('change', (e) => takeFiles((e.target as HTMLInputElement).files));
$<HTMLInputElement>('song').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadSong(f, f.name).catch(() => hint('That song could not be opened.'));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  takeFiles(e.dataTransfer?.files);
});

/* ───────── checking ───────── */

/** stills at these seconds into the shot (0 = its first frame), laid out over the page */
async function sheet(times: number[], cols = 4): Promise<string> {
  if (!score || !curve) return 'no shot yet';
  pause();
  let c = document.getElementById('sheet') as HTMLCanvasElement | null;
  if (!c) {
    c = document.createElement('canvas');
    c.id = 'sheet';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:99;background:#000';
    document.body.appendChild(c);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  c.width = vw;
  c.height = vh;
  c.style.width = `${vw}px`;
  c.style.height = `${vh}px`;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, vw, vh);
  const rows = Math.ceil(times.length / cols);
  const cw = vw / cols;
  const ch = vh / rows;
  let w = cw - 2;
  let h = (w * H) / W;
  if (h > ch - 2) {
    h = ch - 2;
    w = (h * W) / H;
  }
  for (let i = 0; i < times.length; i++) {
    const t = score.start + times[i];
    if (hasClip) await footage.seek(curve.footage(t));
    draw(t);
    const x = (i % cols) * cw + (cw - w) / 2;
    const y = Math.floor(i / cols) * ch + (ch - h) / 2;
    g.drawImage(canvas, x, y, w, h);
    g.fillStyle = 'rgba(0,0,0,.7)';
    g.fillRect(x, y, 104, 14);
    g.fillStyle = '#fff';
    g.font = '10px ui-monospace, monospace';
    g.fillText(`${(t - score.hit).toFixed(2)}s  ${curve.speed(t).toFixed(2)}x`, x + 3, y + 10);
  }
  return 'ok';
}

const ready = (async () => {
  try {
    await Promise.all([document.fonts.load('800 100px "Archivo Variable"'), document.fonts.load('500 40px "JetBrains Mono Variable"')]);
    const demo = DEMO_TRACKS[0];
    await loadSong(demo.render(), demo.name);
    const clip = q.get('clip');
    if (clip) await loadClip(clip);
    requestAnimationFrame(frame);
    return { ok: true, error: '' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    hint(error);
    return { ok: false, error };
  }
})();

declare global {
  interface Window {
    __shot: unknown;
  }
}
window.__shot = {
  ready,
  sheet,
  clearSheet: () => document.getElementById('sheet')?.remove(),
  info: () => ({ live: score && curve ? { t: songTime() - score.hit, clipAt: footage.video.currentTime, want: curve.footage(songTime()), rate: footage.video.playbackRate, playing } : null, score, palette, flip: curve?.flip, freeze: curve?.freeze, clip: hasClip ? { duration: footage.duration, aspect: footage.aspect } : null, focus }),
};
