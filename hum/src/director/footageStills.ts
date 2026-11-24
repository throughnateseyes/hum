/**
 * Small stills of a cut that isn't playing yet, for the check after a Make (footageDirector.ts).
 *
 * They are drawn on a small picture of their own (its own WebGL context, its own players, two open at
 * most), so the video that is playing is left alone: shaders are compiled in the background first, the
 * page breathes between stills, and everything is let go of at the end. Lyrics and the video's finish
 * are not drawn. A video that can't have a second context simply isn't checked.
 */
import * as THREE from 'three';
import type { ClipAsset, PartShot, PhotoAsset, TrackAnalysis } from '../core/types';
import { dryRun } from '../render/warmup';
import { songTitle, stillClip, titleWords } from '../scenes/footage';
import { Footage } from '../shot/footage';
import { deckIdsOf, footageRun, runPartOf, withOwn } from '../shot/run';
import { wordsIn } from '../inside/lines';
import { insidePalette } from '../inside/palettes';
import { readingOf } from '../inside/readings';
import { ShotStage, type StageClip } from '../shot/stage';
import { findLook, type VideoPlan } from '../state/plan';
import { originalOf, parentsOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { breathe, label, letGo, toJpeg } from './mediaSample';

/** stills on one sheet, and how many are checked at the most */
const COLS = 3;
const PER_SHEET = 6;
export const MOST_STILLS = 12;
const CELL = 420;
/** where in a part its still is taken: past the flash of a landing, before the rush into the cut */
const AT = 0.55;

/** the cut to draw: a plan's parts, and what each shows */
export interface Cut {
  plan: VideoPlan;
  analysis: TrackAnalysis;
  shotAt: (i: number) => PartShot | null;
}

/** the parts worth looking at, in order: the ones something was done to, each section's first, then spread out */
export function partsToCheck(cut: Cut, open: number[]): number[] {
  const parents = parentsOf(cut.analysis);
  const worth = (i: number) => {
    const s = cut.shotAt(i);
    return (
      (s?.treatment && s.treatment !== 'none' ? 3 : 0) +
      (s?.style && s.style !== 'plain' ? 2 : 0) +
      ((s?.zoom ?? 1) >= 1.4 ? 2 : 0) +
      (i === 0 || parents[i - 1] !== parents[i] ? 2 : 0) +
      // the same picture as the one before is worth a look
      (i > 0 && s?.media?.[0] && s.media[0] === cut.shotAt(i - 1)?.media?.[0] ? 1 : 0)
    );
  };
  return [...open]
    .sort((x, y) => worth(y) - worth(x) || x - y)
    .slice(0, MOST_STILLS)
    .sort((x, y) => x - y);
}

const thumbOf = (c: ClipAsset) =>
  new Promise<THREE.Texture>((resolve) => {
    const img = new Image();
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    img.onload = () => {
      t.needsUpdate = true;
      resolve(t);
    };
    img.onerror = () => resolve(t);
    img.src = c.thumb;
  });

/** sheets of stills (base64 JPEGs), each still labelled with its part's number. Throws when cancelled, or when they can't be made. */
export async function stillSheets(cut: Cut, parts: number[], signal: AbortSignal): Promise<string[]> {
  const s = useStudio.getState();
  const deckIds = deckIdsOf(s.clips, s.photos);
  const media: (ClipAsset | PhotoAsset | undefined)[] = deckIds.map((id) => s.clips.find((c) => c.id === id) ?? s.photos.find((p) => p.id === id));
  const isClip = (m: ClipAsset | PhotoAsset | undefined): m is ClipAsset => !!m && 'url' in m && 'thumb' in m && 'duration' in m;
  const canvas = document.querySelector<HTMLCanvasElement>('.stage canvas, canvas');
  const aspect = canvas && canvas.height ? Math.min(2.2, Math.max(0.45, canvas.width / canvas.height)) : 16 / 9;
  const w = Math.round(aspect >= 1 ? CELL : CELL * aspect);
  const h = Math.round(w / aspect);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  const stage = new ShotStage(renderer, w, h);
  const open: { i: number; footage: Footage }[] = [];
  const thumbs: THREE.Texture[] = [];
  const sheets: HTMLCanvasElement[] = [];
  const stop = () => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  try {
    const deck: StageClip[] = [];
    // what is already read of a picture's depth is used; nothing waits for more
    const read = (m: ClipAsset | PhotoAsset) => {
      const r = readingOf(m);
      return { get scene() { return r.scene; }, need: () => Promise.resolve() };
    };
    for (const m of media) {
      if (isClip(m)) {
        const t = await thumbOf(m);
        thumbs.push(t);
        deck.push({ footage: null, texture: t, aspect: m.width / Math.max(1, m.height), duration: m.duration, palette: m.palette, still: t, name: m.name, reading: read(m) });
      } else if (m) {
        // a texture of its own, so this small picture leaves nothing hanging on the photo when it goes
        const t = m.texture.clone();
        t.needsUpdate = true;
        thumbs.push(t);
        deck.push({ ...stillClip(m), texture: t, reading: read(m) });
      }
    }
    if (!deck.length) return [];
    stop();
    const all = cut.analysis.sections.map((_, i) => {
      const look = cut.plan.looks[i] ? findLook(cut.plan.looks[i]!) : undefined;
      if (!look || look.sceneId !== 'footage') return null;
      return withOwn(runPartOf({ ...(look.sceneParams ?? {}), ...(s.tweaks[look.id]?.sceneParams ?? {}) }), cut.shotAt(i), deckIds);
    });
    const orig = originalOf(cut.analysis);
    const run = footageRun({ analysis: cut.analysis, sections: orig.sections, parents: parentsOf(cut.analysis), parts: all, clips: deck.map((c) => Math.round(c.duration * 100) / 100), words: titleWords() });
    const title = songTitle().toUpperCase();

    // two players at the most: the one used longest ago is closed first
    const player = async (i: number): Promise<Footage | null> => {
      const m = media[i];
      if (!isClip(m)) return null;
      const at = open.findIndex((x) => x.i === i);
      if (at >= 0) {
        const [had] = open.splice(at, 1);
        open.push(had);
        return had.footage;
      }
      while (open.length >= 2) open.shift()!.footage.close();
      const f = new Footage();
      open.push({ i, footage: f });
      try {
        await Promise.race([f.load(m.url), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 6000))]);
        return f;
      } catch {
        return null;
      }
    };

    let drawn = 0;
    for (const i of parts) {
      const seq = run.seqs[i];
      if (!seq) continue;
      const t = seq.start + (seq.end - seq.start) * AT;
      const shot = seq.shots.find((x) => t < x.end) ?? seq.shots[seq.shots.length - 1];
      const here = [...deck];
      for (const c of new Set([shot.footageIndex, ...(shot.alt === undefined ? [] : [shot.alt])])) {
        const f = await player(c % deck.length);
        if (f) here[c % deck.length] = { ...deck[c % deck.length], footage: f, texture: f.texture, aspect: f.aspect, duration: f.duration };
      }
      stop();
      stage.build({ seq, analysis: cut.analysis, clips: here, title, lookId: '', tellStore: false, live: true, inside: { palette: insidePalette(cut.plan.paint, Math.round(cut.analysis.duration * 10)), words: (sh) => wordsIn(sh, titleWords(true), Math.abs(sh.start - seq.partStart) < 0.05) } });
      await stage.settle(t);
      const own = cut.shotAt(i);
      const focus = { x: own?.focusX ?? 0.5, y: own?.focusY ?? 0.55 };
      // its shaders in the background first, so the draw doesn't hold the page
      await Promise.race([dryRun(renderer, () => stage.draw(t, focus, null, own?.zoom ?? 1)), new Promise((r) => setTimeout(r, 2500))]);
      stop();
      stage.draw(t, focus, null, own?.zoom ?? 1);
      const k = drawn % PER_SHEET;
      if (k === 0) {
        const c = document.createElement('canvas');
        c.width = w * COLS + 4 * (COLS - 1);
        c.height = (h + 4) * Math.ceil(PER_SHEET / COLS);
        sheets.push(c);
      }
      const g = sheets[sheets.length - 1].getContext('2d')!;
      const x = (k % COLS) * (w + 4);
      const y = Math.floor(k / COLS) * (h + 4);
      g.drawImage(renderer.domElement, x, y, w, h);
      label(g, `part ${i}`, x + 6, y + 6);
      drawn++;
      await breathe();
    }
    const out: string[] = [];
    for (const c of sheets) out.push(await toJpeg(c));
    return out;
  } finally {
    stage.dispose();
    stage.release();
    for (const { footage } of open) footage.close();
    for (const t of thumbs) t.dispose();
    for (const c of sheets) letGo(c);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
