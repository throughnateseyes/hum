/**
 * Dev helper (served at /shot.html by `npm run dev`, not part of the build): a short run of hand-built
 * shots round a song's biggest drop, to judge by eye before any of it goes near the director. Video
 * clips are the bed; bands of them swap for flat colours taken from each clip; bare shapes and type
 * sit on top in a 3D space the shot flies through; one of Hum's looks cuts in full frame and shows
 * through the footage; and everything runs on speed ramps locked to the song. Nothing here asks
 * Claude for anything. The pieces live in src/shot/ (start with sequence.ts and stage.ts).
 *
 *   /shot.html                       the built-in demo song, with a stand-in picture until a clip is dropped
 *     ?clip=/footage.local/a.mp4,/footage.local/b.mp4   clips served by the dev server (that folder is ignored by git)
 *     &words=LOUDER THAN THE DARK    the phrase set in type (the card shows all of it)
 *     &style=poster                  the style of every footage shot (caption, poster, window, slab, grid,
 *                                    split; default auto, a style per shot)
 *     &seed=3                        the arrangement (any whole number; default 1)
 *     &colour=flat                   clean, tinted (default) or flat
 *     &treatment=mosh                how the picture is broken down: none (default), mosh, sort, cells,
 *                                    readout, collage, or auto (one per shot)
 *     &photo=/footage.local/p.jpg,…  photos as stills (they join the clips, photos after clips)
 *     &zoom=1.4                      push the picture in (1 fits the frame)
 *     &look=pixel-cube               the look that cuts in full frame
 *     &at=42.5                       build round this second of the song, not its biggest drop
 *     &fx=0.5&fy=0.55                the focus point (0..1 from the bottom-left); clicking the picture sets it
 *     &w=720&h=1280                  picture size (9:16 by default)
 *     &mute=1                        play without sound
 *
 *   Drop up to three videos and a song on the page (or use Clips / Song). Space plays, R restarts,
 *   ← → step a frame.
 *
 *   await __shot.ready               → { ok, error }
 *   await __shot.sheet([..seconds in..], cols)   lays stills out over the page, for checking
 *   await __shot.shots([..], cols, cell)         the same as a PNG data url (scripts/shot-sheet.mjs)
 *   await __shot.hashes([..seconds in..])        a checksum of the frame at each time, drawn in that
 *                                                order (to check a seek lands on the same picture)
 *   __shot.clearSheet(); __shot.info()
 */
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import * as THREE from 'three';
import { analyzeTrack } from '../audio/analysis';
import { DEMO_TRACKS } from '../audio/demoTracks';
import type { TrackAnalysis } from '../core/types';
import { Footage } from '../shot/footage';
import { paletteFromPixels } from '../shot/palette';
import { sequenceFromAnalysis, shotAt, type Sequence } from '../shot/sequence';
import { ShotStage, type StageClip } from '../shot/stage';
import { useStudio } from '../state/store';

THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const W = Number(q.get('w')) || 720;
const H = Number(q.get('h')) || 1280;
const MAX_CLIPS = 3;
const zoom = Number(q.get('zoom')) || 1;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('shot');
canvas.width = W;
canvas.height = H;
canvas.style.aspectRatio = `${W} / ${H}`;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.autoClear = false;
const glErrors: string[] = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
  const msg = (log(fs) || log(vs) || gl.getProgramInfoLog(program) || 'a shader failed to compile').trim().slice(0, 600);
  if (glErrors.length < 6 && !glErrors.includes(msg)) glErrors.push(msg);
};

const stage = new ShotStage(renderer, W, H);

let analysis: TrackAnalysis | null = null;
let buffer: AudioBuffer | null = null;
let songName = '';
let clips: StageClip[] = [];
let stills: StageClip[] = [];
let seq: Sequence | null = null;
const focus = { x: Number(q.get('fx')) || 0.5, y: Number(q.get('fy')) || 0.55 };

/** a picture to stand in until a clip is dropped: a soft sky over ground, so the bands have something to cut */
function standIn(): StageClip {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 640;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const sky = g.createLinearGradient(0, 0, 0, 640);
  sky.addColorStop(0, '#9db7d6');
  sky.addColorStop(0.55, '#e9d9c4');
  sky.addColorStop(0.56, '#5b6b55');
  sky.addColorStop(1, '#20261f');
  g.fillStyle = sky;
  g.fillRect(0, 0, 360, 640);
  const sun = g.createRadialGradient(240, 250, 0, 240, 250, 260);
  sun.addColorStop(0, 'rgba(255,244,214,0.95)');
  sun.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, 360, 640);
  return { footage: null, texture: new THREE.CanvasTexture(c), aspect: 360 / 640, duration: 1e6, palette: paletteFromPixels(g.getImageData(0, 0, 360, 640).data) };
}
const placeholder = standIn();

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
  // ?mute=1 plays the picture without the sound (for checking playback quietly)
  const gain = ctx.createGain();
  gain.gain.value = q.has('mute') ? 0 : 1;
  node.connect(gain).connect(ctx.destination);
  node.start(0, Math.max(0, from));
  // the picture runs on the page's own clock from here: it is smooth and never steps backwards, which
  // the audio clock does not promise. What is heard lags the audio clock by the output latency.
  startedAt = performance.now() + (ctx.outputLatency || 0) * 1000;
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

const songTime = () => (playing ? startedFrom + Math.max(0, performance.now() - startedAt) / 1000 : pausedAt);

async function loadSong(blob: Blob, name: string) {
  pause();
  hint('Listening to the song…');
  const data = await blob.arrayBuffer();
  // decoding needs no sound card and no click: an offline context will do
  buffer = await new OfflineAudioContext(2, 2, 44100).decodeAudioData(data);
  analysis = await analyzeTrack(buffer, []);
  songName = name.replace(/\.[a-z0-9]+$/i, '');
  // looks that print the song's name read it from the app's store
  useStudio.setState({ track: { name: songName, source: 'file' }, analysis });
  rebuild();
}

/* ───────── the clips ───────── */

async function loadClip(src: string) {
  const footage = new Footage();
  await footage.load(src);
  // the palette and the brightness bands come from three frames across the clip
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 36 * 3;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  for (const [i, at] of [0.2, 0.5, 0.8].entries()) {
    await footage.seek(footage.duration * at);
    g.drawImage(footage.video, 0, i * 36, 64, 36);
  }
  const clip: StageClip = { footage, texture: footage.texture, aspect: footage.aspect, duration: footage.duration, palette: paletteFromPixels(g.getImageData(0, 0, 64, 36 * 3).data) };
  // a fourth clip takes the place of the oldest
  clips = [...clips, clip].slice(-MAX_CLIPS);
  rebuild();
}

/** a photo as a still, with its palette taken from its pixels the way the app does */
async function loadStill(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const small = document.createElement('canvas');
  small.width = 64;
  small.height = 64;
  const g = small.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  stills = [...stills, { footage: null, texture, aspect: c.width / c.height, duration: 1e6, palette: paletteFromPixels(g.getImageData(0, 0, 64, 64).data) }];
  rebuild();
}

/* ───────── the shots ───────── */

const wordBox = $<HTMLInputElement>('word');
wordBox.value = (q.get('words') ?? q.get('word') ?? '').slice(0, 60);

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function rebuild() {
  if (!analysis) return;
  const at = q.get('at') ? Number(q.get('at')) : undefined;
  const phrase = (wordBox.value.trim() || songName.split(/[\s_\-–—]+/).slice(0, 3).join(' ') || 'hum').toUpperCase();
  const colour = q.get('colour');
  seq = sequenceFromAnalysis(analysis, phrase, at, { style: q.get('style') || 'auto', seed: Number(q.get('seed')) || 1, colour: colour === 'clean' || colour === 'flat' ? colour : 'tinted', treatment: q.get('treatment') || 'none' });
  const deck = [...clips, ...stills];
  stage.build({ seq, analysis, clips: deck.length ? deck : [placeholder], title: songName.toUpperCase(), lookId: q.get('look') || 'pixel-cube' });
  pausedAt = Math.min(Math.max(pausedAt, seq.start), seq.end);
  if (pausedAt === seq.end) pausedAt = seq.start;
  const n = clips.length;
  hint(
    `${songName}: ${seq.shots.length} shots, ${clock(seq.start)}–${clock(seq.end)}, round the hit at ${clock(seq.hit)}. ` +
      (n ? `${n} clip${n > 1 ? 's' : ''} loaded (up to ${MAX_CLIPS}); with fewer than three, shots share a clip.` : 'Drop up to three video clips on the page to use your own footage.') +
      ' Click the picture to move the focus point.' +
      (stage.errors.length ? ` Problems: ${stage.errors.join('; ')}.` : ''),
  );
}

function hint(text: string) {
  $('hint').textContent = text;
}

const NAMES = ['wait', 'card', 'drop', 'look', 'ride out'];

function readout(t: number) {
  if (!seq) return;
  const shot = shotAt(seq, t);
  const speed = stage.shots[shot.index]?.curve.speed(t) ?? 0;
  $('read').textContent = `${(t - seq.hit >= 0 ? '+' : '−') + Math.abs(t - seq.hit).toFixed(2)}s  ${shot.index + 1}/${seq.shots.length} ${NAMES[shot.index] ?? shot.kind}  ${shot.kind === 'footage' ? `${speed.toFixed(2)}×` : ''}`;
  $<HTMLInputElement>('scrub').value = String((t - seq.start) / (seq.end - seq.start));
}

/** how long frames are taking while it plays (ms, smoothed) */
let frameMs = 0;
let lastFrame = 0;
/** how long this page's own work takes each frame (ms, smoothed) */
let workMs = 0;

function frame(now: number) {
  requestAnimationFrame(frame);
  if (lastFrame) frameMs += (now - lastFrame - frameMs) * 0.05;
  lastFrame = now;
  if (!seq) return;
  let t = songTime();
  if (playing && t >= seq.end) {
    play(seq.start);
    t = seq.start;
  }
  const began = performance.now();
  stage.follow(t, playing);
  stage.draw(t, focus, null, zoom);
  workMs += (performance.now() - began - workMs) * 0.05;
  readout(t);
}

/* ───────── controls ───────── */

$('play').addEventListener('click', () => (playing ? pause() : play(seq ? Math.min(Math.max(pausedAt, seq.start), seq.end - 0.05) : 0)));
$<HTMLInputElement>('scrub').addEventListener('input', (e) => {
  if (!seq) return;
  const t = seq.start + Number((e.target as HTMLInputElement).value) * (seq.end - seq.start);
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
  if (e.target === wordBox || !seq) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'r' || e.key === 'R') {
    if (playing) play(seq.start);
    else pausedAt = seq.start;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    pause();
    pausedAt = Math.min(seq.end, Math.max(seq.start, pausedAt + (e.key === 'ArrowRight' ? 1 : -1) / 30));
  }
});

const clipError = (err: unknown) => hint(err instanceof Error ? err.message : String(err));
function takeFiles(files: FileList | null | undefined) {
  for (const f of Array.from(files ?? [])) {
    const isVideo = f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name);
    if (isVideo) void loadClip(URL.createObjectURL(f)).catch(clipError);
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

/** stills at these seconds into the run (0 = its first frame) drawn onto a 2D canvas, `cell` px wide each */
async function contact(times: number[], cols: number, cell: number, into?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const c = into ?? document.createElement('canvas');
  if (!seq) return c;
  pause();
  const rows = Math.ceil(times.length / cols);
  const ch = Math.round((cell * H) / W);
  c.width = cols * cell;
  c.height = rows * ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < times.length; i++) {
    const t = seq.start + times[i];
    await stage.settle(t);
    stage.draw(t, focus, null, zoom);
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * ch;
    g.drawImage(canvas, x + 1, y + 1, cell - 2, ch - 2);
    const shot = shotAt(seq, t);
    g.fillStyle = 'rgba(0,0,0,.7)';
    g.fillRect(x + 1, y + 1, 170, 14);
    g.fillStyle = '#fff';
    g.font = '10px ui-monospace, monospace';
    g.fillText(`${(t - seq.hit).toFixed(2)}s  ${NAMES[shot.index] ?? ''} ${shot.style} ${shot.treatment ?? ''}`, x + 4, y + 11);
  }
  return c;
}

async function sheet(times: number[], cols = 4): Promise<string> {
  let c = document.getElementById('sheet') as HTMLCanvasElement | null;
  if (!c) {
    c = document.createElement('canvas');
    c.id = 'sheet';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:99;background:#000;max-width:100vw;max-height:100vh';
    document.body.appendChild(c);
  }
  const rows = Math.ceil(times.length / cols);
  // as large as fits the window
  const cell = Math.floor(Math.min(window.innerWidth / cols, ((window.innerHeight / rows) * W) / H));
  await contact(times, cols, cell, c);
  return 'ok';
}

const ready = (async () => {
  try {
    await Promise.all([document.fonts.load('800 100px "Archivo Variable"'), document.fonts.load('500 40px "JetBrains Mono Variable"')]);
    const demo = DEMO_TRACKS[0];
    await loadSong(demo.render(), demo.name);
    for (const src of (q.get('clip') ?? '').split(',').filter(Boolean).slice(0, MAX_CLIPS)) await loadClip(src);
    for (const src of (q.get('photo') ?? '').split(',').filter(Boolean)) await loadStill(src);
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
  shots: async (times: number[], cols = 4, cell = 360) => (await contact(times, cols, cell)).toDataURL('image/png'),
  hashes: async (times: number[]) => {
    const out: { t: number; hash: number; ms: number; ticks: number }[] = [];
    if (!seq) return out;
    pause();
    const gl = renderer.getContext();
    const px = new Uint8Array(W * H * 4);
    for (const at of times) {
      const t = seq.start + at;
      await stage.settle(t);
      const t0 = performance.now();
      stage.draw(t, focus, null, zoom);
      gl.finish();
      const ms = performance.now() - t0;
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // a checksum that forgives rounding: every pixel's value to the nearest 4
      let h = 0;
      for (let i = 0; i < px.length; i += 4) h = (Math.imul(h, 31) + (px[i] >> 2) * 3 + (px[i + 1] >> 2) * 5 + (px[i + 2] >> 2) * 7) | 0;
      out.push({ t: at, hash: h, ms: +ms.toFixed(2), ticks: stage.moshTicks });
    }
    return out;
  },
  clearSheet: () => document.getElementById('sheet')?.remove(),
  info: () => ({
    live: seq ? { at: +(songTime() - seq.start).toFixed(2), playing, drift: stage.drift(songTime()), frameMs: +frameMs.toFixed(1), workMs: +workMs.toFixed(2) } : null,
    seq,
    length: seq ? seq.end - seq.start : 0,
    shots: stage.shots.map((s) => ({ kind: s.shot.kind, from: +(s.shot.start - (seq?.start ?? 0)).toFixed(2), to: +(s.shot.end - (seq?.start ?? 0)).toFixed(2), flip: s.curve.flip, style: s.shot.style, layout: s.shot.layout, scheme: s.scheme.name })),
    clips: clips.map((c) => ({ duration: c.duration, aspect: c.aspect })),
    errors: [...stage.errors, ...glErrors],
    focus,
  }),
};
