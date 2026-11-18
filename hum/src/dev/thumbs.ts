/**
 * Dev helper: renders every built-in look on the stage and saves a thumbnail for each into
 * src/assets/thumbs (through the dev server's /__hum/thumb route). Run from the browser console
 * with a track playing:  await __hum.makeThumbs()
 */
import { PRESETS } from '../presets';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio } from '../state/store';

const SIZE = 160;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));


export async function makeThumbs(opts: { only?: string[]; settleMs?: number } = {}) {
  const done: string[] = [];
  for (const p of PRESETS) {
    if (opts.only && !opts.only.includes(p.id)) continue;
    if (!getScene(p.sceneId)) continue;
    if (live.stage) live.stage.nextTransition = { id: 'cut', ms: 1, seed: 0 };
    useStudio.getState().applyPreset(p);
    await wait(opts.settleMs ?? 2200);
    const body = live.stage!.capture(SIZE, SIZE).toDataURL('image/jpeg', 0.82);
    const res = await fetch(`/__hum/thumb?id=${encodeURIComponent(p.id)}`, { method: 'POST', body });
    if (res.ok) done.push(p.id);
  }
  return done;
}
