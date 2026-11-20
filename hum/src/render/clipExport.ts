import { audioEngine } from '../audio/engine';
import { pickClip, type ClipWindow } from '../audio/clipWindow';
import { live } from '../state/live';
import { useStudio, type StudioState } from '../state/store';
import { Recorder, download } from './recorder';

/** TikTok / Reels / Shorts: vertical 1080×1920 at 30 fps. */
export const CLIP_W = 1080;
export const CLIP_H = 1920;
const CLIP_FPS = 30;
/** how much song plays before the clip starts, so the look and the reactions have settled */
const PREROLL = 1.5;
const FADE_OUT = 0.35;

/** Why a clip can't be made right now, or null when it can. */
export function clipBlocker(s: Pick<StudioState, 'track' | 'analysis' | 'analyzing'>): string | null {
  if (!s.track) return 'Load a song first. Clips need a song file or a demo.';
  if (s.track.source === 'mic' || audioEngine.kind !== 'file')
    return "Clips need a song file. Live sound (microphone, a tab) can't jump to the best part.";
  if (s.analyzing || !s.analysis) return 'Still listening to the song. Try again in a moment.';
  return null;
}

let running: { cancel: () => void } | null = null;

export function cancelClip() {
  running?.cancel();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'hum';

/**
 * Record the strongest 15–30 s of the loaded song as a vertical 1080×1920 video with its sound, in the
 * look, plan and lyrics on the stage, then download it. The stage keeps showing on screen (switched to
 * 9:16 while it records) but draws at the full clip size. Esc cancels.
 */
export async function exportClip(
  win?: ClipWindow,
  size: { w: number; h: number } = { w: CLIP_W, h: CLIP_H },
  opts: { onDone?: (file: { blob: Blob; name: string } | null) => void } = {},
): Promise<void> {
  // onDone: hand the file back instead of downloading it (null when cancelled or it couldn't start)
  const onDone = opts.onDone;
  if (running) return onDone?.(null);
  const st = useStudio.getState();
  const blocked = clipBlocker(st);
  const stage = live.stage;
  if (blocked || !stage) {
    st.flash(blocked ?? 'The stage is not ready yet.');
    return onDone?.(null);
  }
  const w = win ?? pickClip(st.analysis!);
  const tap = audioEngine.tapSong();
  const ctx = audioEngine.ensureContext();
  const mime = Recorder.pickMime();
  if (!tap || typeof MediaRecorder === 'undefined') {
    st.flash("This browser can't record video.");
    return onDone?.(null);
  }

  const before = { aspect: st.aspect, time: audioEngine.currentTime, playing: audioEngine.playing, track: st.track };
  let rec: MediaRecorder | null = null;
  let video: MediaStream | null = null;
  let raf = 0;
  let done = false;
  let lastFrac = -1;
  const chunks: Blob[] = [];

  const set = (clip: StudioState['clip']) => useStudio.getState().set({ clip });

  const restore = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHidden);
    video?.getTracks().forEach((t) => t.stop());
    tap.gain.gain.cancelScheduledValues(ctx.currentTime);
    tap.gain.gain.value = 1;
    stage.setOutputSize(null);
    const s = useStudio.getState();
    s.set({ clip: null, aspect: before.aspect });
    running = null;
    if (s.track === before.track) {
      audioEngine.pause();
      audioEngine.seek(before.time);
      if (before.playing) void audioEngine.play();
    }
  };

  const cancel = (msg = 'Clip cancelled') => {
    if (done) return;
    done = true;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.stop();
    }
    restore();
    useStudio.getState().flash(msg);
    onDone?.(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  // a hidden tab stops drawing frames, which would freeze the video
  const onHidden = () => {
    if (document.hidden) cancel("Clip stopped: keep Hum's tab in front while it records.");
  };

  running = { cancel: () => cancel() };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onHidden);
  set({ phase: 'prep', frac: 0, start: w.start, end: w.end, size: `${size.w}×${size.h}` });

  // draw at clip size, show the same frame on screen so the preview matches the file
  const r = size.w / size.h;
  useStudio.getState().set({ aspect: r < 0.7 ? '9:16' : r < 0.95 ? '4:5' : r < 1.2 ? '1:1' : '16:9' });
  live.stage?.setPeek(null, null);
  stage.setOutputSize(size);

  audioEngine.pause();
  audioEngine.seek(Math.max(0, w.start - PREROLL));
  try {
    await audioEngine.play();
  } catch (e) {
    cancel(`Couldn't play the song: ${String(e)}`);
    return;
  }

  const finish = () => {
    if (done || !rec) return;
    done = true;
    set({ phase: 'save', frac: 1, start: w.start, end: w.end, size: `${size.w}×${size.h}` });
    const r = rec;
    r.onstop = () => {
      const type = mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type });
      restore();
      const name = `${slug(before.track?.name ?? 'hum')}-clip.${ext}`;
      if (onDone) onDone({ blob, name });
      else {
        download(blob, name);
        useStudio.getState().flash(`Saved a ${Math.round(w.end - w.start)} s vertical clip (${ext.toUpperCase()}), from ${w.why}`);
      }
    };
    r.stop();
  };

  const startRec = (t: number) => {
    video = stage.canvas.captureStream(CLIP_FPS);
    const stream = new MediaStream([...video.getVideoTracks(), ...tap.dest.stream.getAudioTracks()]);
    const r = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 14_000_000, audioBitsPerSecond: 192_000 });
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    // a short fade in and out so the cut doesn't click
    const now = ctx.currentTime;
    const left = Math.max(0.1, w.end - t);
    const g = tap.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + 0.04);
    g.setValueAtTime(1, now + Math.max(0.05, left - FADE_OUT));
    g.linearRampToValueAtTime(0, now + left);
    r.start(500);
    rec = r;
  };

  const loop = () => {
    if (done) return;
    raf = requestAnimationFrame(loop);
    const s = useStudio.getState();
    if (s.track !== before.track) return cancel('Clip cancelled: the song changed.');
    const t = audioEngine.currentTime;
    if (!audioEngine.playing) void audioEngine.play();
    if (!rec) {
      if (t >= w.start - 0.5 / CLIP_FPS) startRec(t);
      return;
    }
    // past the end, or the song looped / was seeked back
    if (t >= w.end || t < w.start - 1) return finish();
    const frac = Math.max(0, Math.min(1, (t - w.start) / (w.end - w.start)));
    if (Math.abs(frac - lastFrac) > 0.004) {
      lastFrac = frac;
      set({ phase: 'rec', frac, start: w.start, end: w.end, size: `${size.w}×${size.h}` });
    }
  };
  raf = requestAnimationFrame(loop);
}
