/**
 * The render timeline: pick a stretch of the song, get the exact same video at every size.
 *
 * Nothing plays while it renders. A second, hidden stage draws the video frame by frame at a fixed
 * frame rate: the song's sound for each frame comes from the decoded file (audio/offlineFrames.ts,
 * the same maths the live engine runs), the clock is the render's own, and the dice are seeded per
 * frame, so the same stretch gives the same frames every time and at every size. The video plan's
 * cuts, transitions, Song colours, pop-ups, scene windows and lyrics all come out where playback puts
 * them. Each video starts drawing a few seconds early (thrown away) so Feel, flocks, wind and windows
 * have settled by the first frame, and listening starts earlier still so the levels have too. The depth
 * its Inside shots are drawn from is read first (director/footageDepth.ts, readStretch), so whether it
 * had been read before never shows.
 *
 * Frames go straight into the browser's H.264 encoder and the song's slice into its AAC encoder
 * (render/encode.ts), and out comes an MP4 per size. Afterwards the look, the plan's memory, the
 * playhead and the live stage are put back exactly as they were.
 */
import { audioEngine } from '../audio/engine';
import { downmix, OfflineAudioFrames } from '../audio/offlineFrames';
import { pickClip, type ClipWindow } from '../audio/clipWindow';
import { live } from '../state/live';
import { planSequencerState, restorePlanSequencer } from '../state/plan';
import { quality } from './quality';
import { autopilotTick } from '../state/autopilot';
import { useStudio, type StudioState } from '../state/store';
import { songBuffer } from '../state/tracks';
import { Stage } from './stage';
import { download } from './recorder';
import { encodeAudio, offlineBlocker, sliceSong, VideoFileWriter, videoConfig } from './encode';
import { holdReading } from '../inside/readings';
import { exportClip } from './clipExport';
import { frameWeight, RenderClock, type RenderTime } from './timeLeft';

export interface RenderSize {
  id: '9:16' | '4:5' | '1:1' | '16:9';
  w: number;
  h: number;
  /** a few words on where it goes */
  hint: string;
}

export const RENDER_SIZES: RenderSize[] = [
  { id: '9:16', w: 1080, h: 1920, hint: 'TikTok, Reels, Shorts' },
  { id: '4:5', w: 1080, h: 1350, hint: 'Instagram feed' },
  { id: '1:1', w: 1080, h: 1080, hint: 'Square' },
  { id: '16:9', w: 1920, h: 1080, hint: 'YouTube, widescreen' },
];

export interface RenderRequest {
  start: number;
  end: number;
  sizes: RenderSize[];
  fps: 30 | 60;
  /** what the stretch is, for the message at the end (e.g. "the drop at 1:04") */
  label?: string;
  /**
   * Hand the files back instead of downloading them (the phone's Share clip opens the share sheet
   * with them). The caller then says how it went; renderVideos only reports a failure.
   */
  keep?: boolean;
}

/** what a render made: the files (kept ones only), whether it was cancelled, and why it failed */
export interface RenderResult {
  files: { blob: Blob; name: string; size: RenderSize }[];
  cancelled: boolean;
  failure: string | null;
  /** recorded live while it played (this browser can't encode video by itself) */
  live?: boolean;
}

/** frames drawn before the in-point and thrown away, so the look has settled (s) */
const DRAW_PREROLL = 3;
/** how much earlier listening starts, so levels, energy and the beat have settled (s) */
const LISTEN_PREROLL = 12;
/** how far past the end a look coming in is shown (s; see pick in scenes/footage) */
const LOOK_AHEAD = 1.5;
/** the render clock's scene time at song time 0 (keeps scene time positive through the run-up) */
const TIME_BASE = 10;
/** the dice: every frame of every render rolls from this and the frame's place in the song */
const SEED = 0x48756d;
/** a fixed "today" for anything that reads Date.now during a frame */
const DATE_BASE = Date.UTC(2026, 0, 1);

let running: { cancel: () => void } | null = null;
let preview: HTMLCanvasElement | null = null;

export const isRendering = () => !!running;

export function cancelRender() {
  running?.cancel();
}

/** a small canvas that shows the frames as they are made (the stage overlay while rendering) */
export function setRenderPreview(c: HTMLCanvasElement | null) {
  preview = c;
}

/** Why a render can't start right now, or null when it can. */
export function renderBlocker(s: Pick<StudioState, 'track' | 'analysis' | 'analyzing' | 'clip'>): string | null {
  if (!s.track) return 'Load a song first.';
  if (s.track.source === 'mic' || audioEngine.kind !== 'file') return "Rendering needs a song file. Live sound (microphone, a tab) can't be rendered.";
  if (s.analyzing || !s.analysis) return 'Still listening to the song. Try again in a moment.';
  if (s.clip) return 'A video is already being made.';
  return null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'hum';

/** "0m42s-1m04s": a song stretch in a file name */
export function rangeSlug(start: number, end: number) {
  const f = (t: number) => `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
  return `${f(start)}-${f(end)}`;
}

export function renderFileName(song: string, start: number, end: number, size: RenderSize) {
  return `${slug(song)}-${rangeSlug(start, end)}-${size.w}x${size.h}.mp4`;
}

class Cancelled extends Error {}

/* ───────── a seeded, clock-free world for one frame ───────── */

function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (...xs: number[]) => {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
};
const LAYER_DICE = { scene: 1, windows: 2, popups: 3, lyrics: 4 } as const;

/**
 * Run `fn` (one frame) with the render's clock and dice: performance.now and Date.now read the
 * render clock, Math.random rolls from the frame's place in the song (and is re-rolled for each layer,
 * so a scene that rolls more dice at one size doesn't move the pop-ups at another), and the
 * sequencers talk to the render stage instead of the one on screen.
 */
/** the dice the draw half of a frame starts with (the step half starts with 0, the layers have their own) */
const DRAW_DICE = 5;

function inRenderWorld(stage: Stage, songFrame: number, nowMs: number, fn: (phase: (layer: keyof typeof LAYER_DICE) => void) => void, dice = 0) {
  const perf = performance.now;
  const dnow = Date.now;
  const rnd = Math.random;
  const onScreen = live.stage;
  performance.now = () => nowMs;
  Date.now = () => DATE_BASE + Math.round(nowMs);
  Math.random = mulberry(hash(SEED, songFrame, dice));
  live.stage = stage;
  try {
    fn((layer) => {
      Math.random = mulberry(hash(SEED, songFrame, LAYER_DICE[layer]));
    });
  } finally {
    performance.now = perf;
    Date.now = dnow;
    Math.random = rnd;
    live.stage = onScreen;
  }
}

/** give the browser a moment (no timer clamping, works in a background tab) */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
function yieldNow(): Promise<void> {
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    channel.port1.onmessage = () => r();
    channel.port2.postMessage(0);
  });
}

/* ───────── what gets saved and put back ───────── */

const LOOK_KEYS = ['sceneId', 'sceneParams', 'effects', 'modulations', 'palette', 'presetId', 'hand', 'shaderError'] as const;
type LookSnapshot = Pick<StudioState, (typeof LOOK_KEYS)[number]>;
const snapLook = (): LookSnapshot => {
  const s = useStudio.getState();
  return Object.fromEntries(LOOK_KEYS.map((k) => [k, s[k]])) as LookSnapshot;
};

/* ───────── one video ───────── */

/** how many frames of a stretch are drawn: the run-up (thrown away), and the video */
function framesOf(req: Pick<RenderRequest, 'start' | 'end' | 'fps'>) {
  return {
    pre: Math.round(Math.min(DRAW_PREROLL, req.start) * req.fps),
    total: Math.max(1, Math.round((req.end - req.start) * req.fps)),
  };
}

interface Shared {
  pcm: { channels: Float32Array[]; sampleRate: number };
  mono: Float32Array;
}

/** wait for `p`, unless the render is cancelled first */
async function unlessCancelled(p: Promise<void>, isCancelled: () => boolean): Promise<void> {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = p.finally(() => (done = true));
  end.catch(() => undefined);
  while (!done) {
    const tick = new Promise<void>((r) => (timer = setTimeout(r, 120)));
    await Promise.race([end, tick]);
    clearTimeout(timer);
    if (isCancelled()) throw new Cancelled();
  }
}

async function renderOne(req: RenderRequest, size: RenderSize, shared: Shared, audio: Awaited<ReturnType<typeof encodeAudio>>, onFrame: (frac: number, drawn: number) => void, onHold: (on: boolean) => void, isCancelled: () => boolean): Promise<Blob> {
  const { w, h } = size;
  const fps = req.fps;
  const cfg = await videoConfig(w, h, fps);
  if (!cfg) throw new Error(`This browser can't write H.264 at ${w}×${h}.`);
  const s0 = useStudio.getState();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const stage = new Stage(canvas);
  // the lyric legibility guard reads the picture back; in a render it must read it on the frame it's drawn
  (stage.renderer as unknown as { readRenderTargetPixelsAsync?: unknown }).readRenderTargetPixelsAsync = undefined;
  stage.setOutputSize({ w, h });
  stage.resetClock(0);
  stage.onHold = onHold;
  const writer = new VideoFileWriter(cfg, fps, audio);
  try {
    const frames = new OfflineAudioFrames(shared.pcm, s0.analysis, { sensitivity: s0.sensitivity, bpmOverride: audioEngine.bpmOverride, mono: shared.mono });
    const { pre, total } = framesOf(req);
    const firstDrawn = req.start - pre / fps;
    // listening run-up: levels, energy, the beat and Feel catch up without drawing
    const listenFrom = Math.max(0, firstDrawn - LISTEN_PREROLL);
    const listenSteps = Math.round((firstDrawn - listenFrom) * fps);
    frames.start(firstDrawn - listenSteps / fps);
    for (let j = 0; j < listenSteps; j++) {
      const t = firstDrawn - (listenSteps - j) / fps;
      stage.primeFeel(frames.advanceTo(t), 1 / fps);
    }
    // auto-pilot counts beats from here, like a song just started
    autopilotTick({ ...frames.advanceTo(firstDrawn), playing: false });

    let lastYield = performance.now();
    for (let k = -pre; k < total; k++) {
      if (isCancelled()) throw new Cancelled();
      const t = req.start + k / fps;
      const a = frames.advanceTo(t);
      const songFrame = Math.round(t * fps);
      const now = (t + TIME_BASE) * 1000;
      let frame: VideoFrame | null = null;
      // the sequencers run and any cut lands first, so a scene cut to on this frame exists to be prepared
      inRenderWorld(stage, songFrame, now, (phase) => stage.beginFrame({ now, dt: 1 / fps, audio: a, phase }));
      // footage scenes seek their videos here: on the real clock, with real timers, so `seeked` fires
      await unlessCancelled(stage.prepareFrame(t), isCancelled);
      inRenderWorld(
        stage,
        songFrame,
        now,
        (phase) => {
          stage.finishFrame(phase);
          // grab the picture before anything else can touch the canvas
          if (k >= 0) frame = new VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
        },
        DRAW_DICE,
      );
      if (frame) {
        const f = frame as VideoFrame;
        try {
          await writer.add(f, k);
        } finally {
          f.close();
        }
        if (preview && k % 3 === 0) drawPreview(canvas);
      }
      onFrame(Math.max(0, k + 1) / total, pre + k + 1);
      if (performance.now() - lastYield > 24) {
        await yieldNow();
        lastYield = performance.now();
      }
    }
    return await writer.finish();
  } finally {
    writer.close();
    stage.dispose();
    stage.renderer.forceContextLoss();
  }
}

function drawPreview(src: HTMLCanvasElement) {
  const c = preview;
  if (!c) return;
  const g = c.getContext('2d');
  if (!g) return;
  const s = Math.min(c.width / src.width, c.height / src.height);
  const dw = src.width * s;
  const dh = src.height * s;
  g.fillStyle = '#111';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
}

/* ───────── the whole job ───────── */

/**
 * Render the stretch `start`–`end` at each chosen size, one after another, and download each MP4
 * as it's done. Esc cancels. Browsers that can't encode video themselves get the live recording
 * instead (the first size only), with a note.
 */
export async function renderVideos(req: RenderRequest): Promise<RenderResult> {
  const st = useStudio.getState();
  const blocked = renderBlocker(st);
  if (running || blocked) {
    st.flash(blocked ?? 'A video is already being made.');
    return { files: [], cancelled: false, failure: blocked ?? 'A video is already being made.' };
  }
  if (!req.sizes.length) {
    st.flash('Pick at least one size.');
    return { files: [], cancelled: false, failure: 'Pick at least one size.' };
  }
  const buf = songBuffer();
  const why = buf ? await offlineBlocker() : 'The song is still loading.';
  if (why) {
    // the old way: play the stretch and record the screen (one size)
    const size = req.sizes[0];
    st.flash(`${why} Recording it live instead (${size.id} only), so keep this tab in front.`);
    const win: ClipWindow = { start: req.start, end: req.end, anchor: req.start, why: req.label ?? 'your selection' };
    if (!req.keep) {
      await exportClip(win, { w: size.w, h: size.h });
      return { files: [], cancelled: false, failure: null, live: true };
    }
    const got = await new Promise<{ blob: Blob; name: string } | null>((resolve) => void exportClip(win, { w: size.w, h: size.h }, { onDone: resolve }));
    return { files: got ? [{ ...got, size }] : [], cancelled: !got, failure: null, live: true };
  }

  const start = Math.max(0, req.start);
  const end = Math.min(buf!.duration, req.end);
  const job = { ...req, start, end };
  const track = st.track;
  const songName = track?.name ?? 'hum';
  const before = {
    look: snapLook(),
    seq: planSequencerState(),
    time: audioEngine.currentTime,
    playing: audioEngine.playing,
  };
  let cancelled = false;
  const set = (clip: StudioState['clip']) => useStudio.getState().set({ clip });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelled = true;
  };
  running = { cancel: () => (cancelled = true) };
  window.addEventListener('keydown', onKey, true);
  const count = job.sizes.length;
  const sizeLabel = (z: RenderSize) => `${z.w}×${z.h}`;
  set({ phase: 'prep', frac: 0, start, end, size: sizeLabel(job.sizes[0]), index: 0, count });

  // the live stage and the song wait while the videos are made
  const onScreen = live.stage;
  onScreen?.stop();
  onScreen?.setPeek(null, null);
  // the quality governor sits still while frames are made (the busy GPU isn't the live stage lagging)
  quality.freeze(true);
  audioEngine.pause();
  // the depth this draws from is read first, and nothing else is read into it while it draws
  holdReading(true);
  const saved: string[] = [];
  const kept: RenderResult['files'] = [];
  let failure: string | null = null;
  const t0 = performance.now();
  // how long is left counts every frame of every size, run-ups included
  const each = framesOf(job);
  const weights = job.sizes.map((z) => frameWeight(z.w, z.h));
  const clock = new RenderClock(weights.reduce((sum, x) => sum + x * (each.pre + each.total), 0), t0, req.fps);
  let time: RenderTime = { elapsed: 0 };
  try {
    const channels = Array.from({ length: buf!.numberOfChannels }, (_, c) => buf!.getChannelData(c));
    const pcm = { channels, sampleRate: buf!.sampleRate };
    const mono = downmix(pcm);
    const audio = await encodeAudio(sliceSong(pcm, start, end));
    const stopped = () => cancelled || useStudio.getState().track !== track;
    const { readStretch } = await import('../director/footageDepth');
    // (a little past the end: a look coming in over a transition shows its shot before its cut)
    await readStretch(start - each.pre / req.fps, end + LOOK_AHEAD, {
      stopped,
      say: (p) => set({ phase: 'depth', frac: p.frac, start, end, size: sizeLabel(job.sizes[0]), index: 0, count, n: p.n, of: p.of, loading: p.loading }),
    });
    if (stopped()) throw new Cancelled();
    for (let i = 0; i < count; i++) {
      if (cancelled) throw new Cancelled();
      const size = job.sizes[i];
      // every size starts from the same place: the look as it was, the plan's memory fresh
      useStudio.setState(before.look);
      if (useStudio.getState().planOn) useStudio.setState({ presetId: null });
      restorePlanSequencer({ hold: null, lastTint: '' });
      const show = (frac: number) => set({ phase: 'rec', frac, start, end, size: sizeLabel(size), index: i, count, ...time });
      show(0);
      let lastFrac = -1;
      let lastShown = 0;
      // what the frame in hand waits for (a clip's depth nobody could know of beforehand) isn't time it takes to draw
      let heldAt = 0;
      let holds = 0;
      let soon: ReturnType<typeof setTimeout> | undefined;
      const onHold = (on: boolean) => {
        holds += on ? 1 : -1;
        if (on && holds === 1) {
          heldAt = performance.now();
          soon = setTimeout(() => !stopped() && set({ phase: 'depth', frac: Math.max(0, lastFrac), start, end, size: sizeLabel(size), index: i, count, n: 0, of: 0 }), 300);
        } else if (!on && holds === 0) {
          clearTimeout(soon);
          clock.waited(performance.now() - heldAt);
        }
      };
      const past = weights.slice(0, i).reduce((sum, x) => sum + x, 0) * (each.pre + each.total);
      const blob = await renderOne(job, size, { pcm, mono }, audio, (f, drawn) => {
        const now = performance.now();
        if (f - lastFrac < 0.005 && f < 1 && now - lastShown < 500) return;
        lastFrac = f;
        lastShown = now;
        time = clock.at(now, past + weights[i] * drawn, i * (each.pre + each.total) + drawn);
        show(f);
      }, onHold, stopped);
      if (useStudio.getState().track !== track) throw new Cancelled();
      const name = renderFileName(songName, start, end, size);
      if (req.keep) kept.push({ blob, name, size });
      else download(blob, name);
      saved.push(size.id);
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      console.error('[hum] render failed', e);
      failure = e instanceof Error ? e.message : String(e);
    }
  } finally {
    window.removeEventListener('keydown', onKey, true);
    running = null;
    useStudio.setState(before.look);
    restorePlanSequencer(before.seq);
    useStudio.getState().set({ clip: null });
    quality.freeze(false);
    holdReading(false);
    onScreen?.start();
    if (useStudio.getState().track === track) {
      audioEngine.seek(before.time);
      if (before.playing) void audioEngine.play().catch(() => {});
    }
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const len = Math.round(end - start);
  const flash = useStudio.getState().flash;
  lastRenderStats = { seconds: Number(secs), frames: Math.round((end - start) * req.fps) * saved.length, sizes: saved };
  if (req.keep) {
    if (failure) flash(`The video couldn't be made: ${failure}`);
    return { files: kept, cancelled, failure };
  }
  if (failure) flash(`The video couldn't be made: ${failure}`);
  else if (cancelled && !saved.length) flash('Render cancelled');
  else if (cancelled) flash(`Render stopped. Saved ${saved.join(', ')}.`);
  else flash(`Saved ${saved.length === 1 ? `a ${len} s ${saved[0]} video` : `${saved.length} videos (${saved.join(', ')}), ${len} s each`}${req.label ? `, from ${req.label}` : ''} · made in ${secs} s`);
  return { files: [], cancelled, failure };
}

/** One click: the song's best 15–30 s as a vertical 1080×1920 video at 30 fps (the "Clip for TikTok" button). */
export async function clipForTikTok(): Promise<void> {
  const a = useStudio.getState().analysis;
  if (!a) {
    useStudio.getState().flash('Still listening to the song. Try again in a moment.');
    return;
  }
  const w = pickClip(a);
  await renderVideos({ start: w.start, end: w.end, sizes: [RENDER_SIZES[0]], fps: 30, label: w.why });
}

/** how the last render went (for the dev console and tests) */
export let lastRenderStats: { seconds: number; frames: number; sizes: string[] } | null = null;
