/**
 * Scrubbing the song like a video editor: while a render handle is dragged the song pauses, the
 * playhead follows the handle, and the stage shows that moment. The video plan's look for that spot
 * comes from the sequencer (it follows the playhead, paused or not), the lyric line from the song
 * time, and the levels (how hard the picture hits) are heard from the decoded song at that moment,
 * the same listening a render does, and held while paused.
 *
 * Seeks are folded to one per animation frame, so a fast drag never queues up work.
 */
import { audioEngine } from '../audio/engine';
import { downmix, OfflineAudioFrames } from '../audio/offlineFrames';
import { useStudio } from './store';
import { songBuffer } from './tracks';

/** how much of the song is listened to before the moment, so the levels have settled */
const LISTEN_BEFORE = 1.2;

let session: { wasPlaying: boolean } | null = null;
let pending: number | null = null;
let raf = 0;
let mono: { buf: AudioBuffer; mono: Float32Array; channels: Float32Array[] } | null = null;

/** the sound of the song at time t, as the live stage would have heard it there */
function frameAt(t: number) {
  const buf = songBuffer();
  if (!buf) return null;
  if (mono?.buf !== buf) {
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    mono = { buf, channels, mono: downmix({ channels, sampleRate: buf.sampleRate }) };
  }
  const s = useStudio.getState();
  const frames = new OfflineAudioFrames({ channels: mono.channels, sampleRate: buf.sampleRate }, s.analysis, {
    sensitivity: s.sensitivity,
    bpmOverride: audioEngine.bpmOverride,
    mono: mono.mono,
  });
  frames.start(Math.max(0, t - LISTEN_BEFORE));
  return frames.advanceTo(t);
}

/** move the playhead to t and show that moment on the stage (stays paused) */
export function showMoment(t: number) {
  if (audioEngine.kind !== 'file') return;
  audioEngine.seek(t);
  if (!audioEngine.playing) {
    try {
      audioEngine.holdFrame(frameAt(t));
    } catch (e) {
      console.warn('[hum] scrub preview failed', e);
    }
  }
}

/** a drag starts: pause, remembering whether the song was playing */
export function beginScrub() {
  // a live recording keeps playing: the range still moves, the song doesn't
  if (session || audioEngine.kind !== 'file' || useStudio.getState().recording) return;
  session = { wasPlaying: audioEngine.playing };
  audioEngine.pause();
}

/** the handle is at t now */
export function scrubTo(t: number) {
  if (!session) return;
  pending = t;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (pending !== null && session) showMoment(pending);
    pending = null;
  });
}

/**
 * The drag ends. A song that was paused stays paused on the moment (so you can look at it); a song
 * that was playing plays on from `resumeAt` (the clip's start, or just before its end), so you hear
 * the edit you just made.
 */
export function endScrub(at: number, resumeAt = at) {
  if (!session) return;
  const { wasPlaying } = session;
  session = null;
  cancelAnimationFrame(raf);
  raf = 0;
  pending = null;
  if (wasPlaying) {
    audioEngine.seek(resumeAt);
    void audioEngine.play().catch(() => {});
  } else showMoment(at);
}

export const isScrubbing = () => !!session;
