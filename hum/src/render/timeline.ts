/**
 * The render timeline: pick a stretch of the song, get the exact same video at every size.
 *
 * Nothing plays while it renders. A second, hidden stage draws the video frame by frame at a fixed
 * frame rate: the song's sound for each frame comes from the decoded file (audio/offlineFrames.ts,
 * the same maths the live engine runs), the clock is the render's own, and the dice are seeded per
 * frame, so the same stretch gives the same frames every time and at every size. The video plan's
 * cuts, transitions, Song colours, pop-ups, scene windows and lyrics all come out where playback puts
 * them. Each video starts drawing a few seconds early (thrown away) so Feel, flocks, wind and windows
 * have settled by the first frame, and listening starts earlier still so the levels have too.
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
import { exportClip } from './clipExport';

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
}

/** frames drawn before the in-point and thrown away, so the look has settled (s) */
const DRAW_PREROLL = 3;
/** how much earlier listening starts, so levels, energy and the beat have settled (s) */
const LISTEN_PREROLL = 12;
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
export function renderBlocker(s: Pick<StudioState, 'track' | 'analysis' | 'analyzing' | 'recording' | 'clip'>): string | null {
  if (!s.track) return 'Load a song first.';
  if (s.track.source === 'mic' || audioEngine.kind !== 'file') return "Rendering needs a song file. Live sound (microphone, a tab) can't be rendered.";
  if (s.analyzing || !s.analysis) return 'Still listening to the song. Try again in a moment.';
  if (s.recording) return 'Stop the recording first.';
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
function inRenderWorld(stage: Stage, songFrame: number, nowMs: number, fn: (phase: (layer: keyof typeof LAYER_DICE) => void) => void) {
  const perf = performance.now;
  const dnow = Date.now;
  const rnd = Math.random;
  const onScreen = live.stage;
  performance.now = () => nowMs;
  Date.now = () => DATE_BASE + Math.round(nowMs);
  Math.random = mulberry(hash(SEED, songFrame, 0));
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

interface Shared {
  pcm: { channels: Float32Array[]; sampleRate: number };
  mono: Float32Array;
}

async function renderOne(req: RenderRequest, size: RenderSize, shared: Shared, audio: Awaited<ReturnType<typeof encodeAudio>>, onFrac: (f: number) => void, isCancelled: () => boolean): Promise<Blob> {
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
  const writer = new VideoFileWriter(cfg, fps, audio);
  try {
    const frames = new OfflineAudioFrames(shared.pcm, s0.analysis, { sensitivity: s0.sensitivity, bpmOverride: audioEngine.bpmOverride, mono: shared.mono });
    const total = Math.max(1, Math.round((req.end - req.start) * fps));
    const pre = Math.round(Math.min(DRAW_PREROLL, req.start) * fps);
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
      inRenderWorld(stage, songFrame, now, (phase) => {
        stage.renderFrame({ now, dt: 1 / fps, audio: a, phase });
        // grab the picture before anything else can touch the canvas
        if (k >= 0) frame = new VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
      });
      if (frame) {
        const f = frame as VideoFrame;
        try {
          await writer.add(f, k);
        } finally {
          f.close();
        }
        if (preview && k % 3 === 0) drawPreview(canvas);
        onFrac((k + 1) / total);
      }
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
export async function renderVideos(req: RenderRequest): Promise<void> {
  const st = useStudio.getState();
  const blocked = renderBlocker(st);
  if (running || blocked) {
    st.flash(blocked ?? 'A video is already being made.');
    return;
  }
  if (!req.sizes.length) {
    st.flash('Pick at least one size.');
    return;
  }
  const buf = songBuffer();
  const why = buf ? await offlineBlocker() : 'The song is still loading.';
  if (why) {
    // the old way: play the stretch and record the screen (one size)
    const size = req.sizes[0];
    st.flash(`${why} Recording it live instead (${size.id} only), so keep this tab in front.`);
    const win: ClipWindow = { start: req.start, end: req.end, anchor: req.start, why: req.label ?? 'your selection' };
    await exportClip(win, { w: size.w, h: size.h });
    return;
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
  const saved: string[] = [];
  let failure: string | null = null;
  const t0 = performance.now();
  try {
    const channels = Array.from({ length: buf!.numberOfChannels }, (_, c) => buf!.getChannelData(c));
    const pcm = { channels, sampleRate: buf!.sampleRate };
    const mono = downmix(pcm);
    const audio = await encodeAudio(sliceSong(pcm, start, end));
    for (let i = 0; i < count; i++) {
      if (cancelled) throw new Cancelled();
      const size = job.sizes[i];
      // every size starts from the same place: the look as it was, the plan's memory fresh
      useStudio.setState(before.look);
      if (useStudio.getState().planOn) useStudio.setState({ presetId: null });
      restorePlanSequencer({ hold: null, lastTint: '' });
      set({ phase: 'rec', frac: 0, start, end, size: sizeLabel(size), index: i, count });
      let lastFrac = -1;
      const blob = await renderOne(job, size, { pcm, mono }, audio, (f) => {
        if (f - lastFrac >= 0.005 || f >= 1) {
          lastFrac = f;
          set({ phase: 'rec', frac: f, start, end, size: sizeLabel(size), index: i, count });
        }
      }, () => cancelled || useStudio.getState().track !== track);
      if (useStudio.getState().track !== track) throw new Cancelled();
      const name = renderFileName(songName, start, end, size);
      download(blob, name);
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
    onScreen?.start();
    if (useStudio.getState().track === track) {
      audioEngine.seek(before.time);
      if (before.playing) void audioEngine.play().catch(() => {});
    }
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const len = Math.round(end - start);
  const flash = useStudio.getState().flash;
  if (failure) flash(`The video couldn't be made: ${failure}`);
  else if (cancelled && !saved.length) flash('Render cancelled');
  else if (cancelled) flash(`Render stopped. Saved ${saved.join(', ')}.`);
  else flash(`Saved ${saved.length === 1 ? `a ${len} s ${saved[0]} video` : `${saved.length} videos (${saved.join(', ')}), ${len} s each`}${req.label ? `, from ${req.label}` : ''} · made in ${secs} s`);
  lastRenderStats = { seconds: Number(secs), frames: Math.round((end - start) * req.fps) * saved.length, sizes: saved };
}

/** One click: the song's best 15–30 s as a vertical 1080×1920 video at 30 fps (the "Clip for TikTok" button). */
export function clipForTikTok(): Promise<void> {
  const a = useStudio.getState().analysis;
  if (!a) {
    useStudio.getState().flash('Still listening to the song. Try again in a moment.');
    return Promise.resolve();
  }
  const w = pickClip(a);
  return renderVideos({ start: w.start, end: w.end, sizes: [RENDER_SIZES[0]], fps: 30, label: w.why });
}

/** how the last render went (for the dev console and tests) */
export let lastRenderStats: { seconds: number; frames: number; sizes: string[] } | null = null;
