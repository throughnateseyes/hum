import { audioEngine } from '../audio/engine';
import { useStudio } from '../state/store';

/**
 * Where to be in the song for a choice being tried on to show (used with Seg's tryOn). Moving the song is
 * playback, not an edit: it stays where it went when the choice is let go, as Other choices does.
 */

/** with the song elsewhere, go a moment into the part */
export function seeIn(part: number) {
  const sec = useStudio.getState().analysis?.sections[part];
  if (!sec || audioEngine.kind !== 'file') return;
  const t = audioEngine.currentTime;
  if (t < sec.start || t >= sec.end) audioEngine.seek(Math.min(sec.end - 0.05, sec.start + Math.min(1, (sec.end - sec.start) * 0.3)));
}

/** while it plays, go to just before the next cut, so a transition tried on plays out */
export function seeNextCut() {
  const a = useStudio.getState().analysis;
  if (!a || audioEngine.kind !== 'file' || !audioEngine.playing) return;
  const t = audioEngine.currentTime;
  const next = a.sections.find((s) => s.start > t + 1.5 && s.start > 0.5);
  if (next) audioEngine.seek(Math.max(0, next.start - 1.2));
}

/** with no words on screen, go to the next sung line, so a lyrics style tried on can be seen */
export function seeWords() {
  const lines = useStudio.getState().lyrics?.lines;
  if (!lines?.length || audioEngine.kind !== 'file') return;
  const t = audioEngine.currentTime;
  if (lines.some((l) => t >= l.t && t < (l.end ?? l.t + 3))) return;
  const next = lines.find((l) => l.t > t) ?? lines[0];
  audioEngine.seek(Math.max(0, next.t - 0.1));
}
