/**
 * Reading the clips when they are added (or come back after a reload), so a Make doesn't wait for it:
 * one at a time, in the background, and never while the song plays (so nothing on screen stutters) or a
 * video renders (its clips have the decoder to themselves). A Make that waits for the reading goes first.
 */
import { audioEngine } from '../audio/engine';
import { useStudio } from '../state/store';
import { motionOf, readMotion, standAside } from './read';

let going = false;

const aside = () => {
  const s = useStudio.getState();
  return !!s.clip || (audioEngine.playing && !s.planning && !s.making);
};

async function go() {
  if (going) return;
  going = true;
  const tried = new Set<string>();
  try {
    for (;;) {
      const c = useStudio.getState().clips.find((x) => !motionOf(x.id) && !tried.has(x.id));
      if (!c) return;
      const s = useStudio.getState();
      if (aside() || s.planning || document.hidden) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      tried.add(c.id);
      await readMotion(c);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    going = false;
  }
}

/** from now on, whatever clips there are get read */
export function readClipsQuietly() {
  standAside(aside);
  const soon = () => setTimeout(() => void go(), 2500);
  useStudio.subscribe((s, was) => {
    if (s.clips !== was.clips && s.clips.length) soon();
  });
  if (useStudio.getState().clips.length) soon();
}
