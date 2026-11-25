/**
 * Touch on the stage: swipe left or right to step through looks, swipe up for the panels, tap for the
 * controls, double-tap for full screen.
 *
 * Swipes step through a deck built from the look on screen: first the other takes of its family (the
 * same idea in another colourway), then its neighbours (with a song: the looks that sit with it in the
 * part that's playing, by the planner's own fit and pairs; without one, its curated pairs), then the
 * song's suggestions, then every other family. Left is the next look, right goes back. With a video
 * plan playing, the look goes into the part that's playing (like picking it from the list).
 *
 * Only touch pointers count (a mouse keeps its clicks and double-click), and never while the song is
 * being scrubbed, a render or clip runs, or the touch starts on a control over the picture. The sheet
 * and the full-screen bar live outside the stage, so touches there never reach this.
 */
import { useEffect, type RefObject } from 'react';
import { findLook, partEnergy, pickLook, relatedLooks, sectionIndexAt } from '../state/plan';
import { isScrubbing } from '../state/scrub';
import { useStudio } from '../state/store';
import { noteHandPick } from '../state/taste';
import { allFamilies, bestTake, familyOf, neighbourScore, takeName } from '../presets/fit';
import { lookShows } from '../director/footage';
import { PRESETS } from '../presets';
import { audioEngine } from '../audio/engine';
import { closePanel, openPanel, toastLook, toggleStageControls, useLayout, usePhoneUi } from './layout';
import { togglePerform } from './Perform';
import { useRenderMode } from './RenderBar';

/* ───────── the deck of looks a swipe steps through ───────── */

let deck: { ids: string[]; i: number; ctx: string } | null = null;

const usable = (id: string | null | undefined) => {
  const p = findLook(id);
  return p && !p.sceneId.startsWith('board-') ? p : undefined;
};

/** the context a deck belongs to: the song and the part playing (a new part gets a new deck) */
function deckContext(): string {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !s.planOn) return `free|${a?.duration ?? 0}`;
  return `${a.duration}|${sectionIndexAt(a.sections, audioEngine.currentTime)}`;
}

function buildDeck(cur: string | null): string[] {
  const s = useStudio.getState();
  const a = s.analysis;
  const curP = usable(cur);
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && lookShows(usable(id)) && usable(id)) out.push(id);
  };
  add(curP?.id);
  // 1. the other takes of the family on screen
  if (curP) for (const p of familyOf(curP).takes) add(p.id);
  for (const p of s.customPresets) if (curP && p.family && p.family === familyOf(curP).id) add(p.id);
  // 2. its neighbours
  if (curP && a?.sections.length) {
    const i = sectionIndexAt(a.sections, audioEngine.currentTime);
    const plan = s.plan && s.plan.looks.length === a.sections.length ? s.plan : null;
    for (const id of relatedLooks(curP.id, a, plan?.looks ?? [], undefined, { label: a.sections[i].label, energy: partEnergy(a, i) })) add(id);
  } else if (curP) {
    const leads = allFamilies().map((f) => bestTake(f));
    for (const p of leads.filter((p) => neighbourScore(p, curP) > 0.3).sort((x, y) => neighbourScore(y, curP) - neighbourScore(x, curP))) add(p.id);
  }
  // 3. what the song suggested, then every other family's lead take
  for (const id of a?.suggestedPresets ?? []) add(id);
  for (const f of allFamilies()) add(bestTake(f, a?.suggestedPresets ?? []).id);
  if (!out.length) for (const p of PRESETS) add(p.id);
  return out;
}

/** step to the next (1) or previous (-1) look, with a light note naming it */
export function swipeLook(dir: 1 | -1) {
  const s = useStudio.getState();
  const ctx = deckContext();
  if (!deck || deck.ids[deck.i] !== s.presetId || deck.ctx !== ctx) deck = { ids: buildDeck(s.presetId), i: 0, ctx };
  const n = deck.ids.length;
  if (n < 2) return;
  deck.i = (deck.i + dir + n) % n;
  const p = findLook(deck.ids[deck.i]);
  if (!p) return;
  noteHandPick(p, 'browse');
  pickLook(p);
  // pickLook names the part it went into; the swipe's own note is lighter
  useStudio.setState({ toast: null });
  // the family's name, and the take when the family has several ("Willow · Moonlight")
  const fam = familyOf(p);
  const take = takeName(p);
  const several = fam.takes.length > 1;
  toastLook(several ? fam.name : p.name, several && take !== fam.name ? take : '', dir);
}

/* ───────── the gesture recogniser ───────── */

/** a touch that starts on one of these is theirs, not a gesture */
const OWN = 'button, a, input, select, textarea, label, .welcome, .taste-hud, .stage-vol, .stage-fs, .tap-play, .seek, .perform-bar, .rg, .stage-hud, .arr';

const TAP_MOVE = 10;
const SWIPE_MIN = 48;
const FLICK_MIN = 28;
const FLICK_SPEED = 0.45; // px/ms
const DOUBLE_MS = 300;

/** when the last touch tap landed (the stage's mouse double-click ignores the one a double-tap makes) */
export let lastTouchTap = 0;

export function useStageGestures(frame: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let g: { id: number; x0: number; y0: number; t0: number; axis: 'x' | 'y' | null; multi: boolean } | null = null;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let lastTap = { t: 0, x: 0, y: 0 };

    const busy = () => {
      const s = useStudio.getState();
      return isScrubbing() || !!s.clip || !!useRenderMode.getState().scrub;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (g) {
        // a second finger: a pinch, not a swipe
        g.multi = true;
        return;
      }
      if ((e.target as HTMLElement).closest(OWN) || busy()) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, axis: null, multi: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.axis && Math.hypot(dx, dy) > TAP_MOVE) g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    };
    const onUp = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const d = g;
      g = null;
      if (d.multi || busy()) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      const ms = Math.max(1, e.timeStamp - d.t0);
      const dist = Math.hypot(dx, dy);
      if (dist <= TAP_MOVE && ms < 500) {
        tap(e.clientX, e.clientY, e.timeStamp);
        return;
      }
      const horiz = Math.abs(dx) > Math.abs(dy) * 1.3;
      const vert = Math.abs(dy) > Math.abs(dx) * 1.3;
      const fast = (v: number) => Math.abs(v) / ms > FLICK_SPEED;
      if (horiz && (Math.abs(dx) >= SWIPE_MIN || (Math.abs(dx) >= FLICK_MIN && fast(dx)))) {
        swipeLook(dx < 0 ? 1 : -1);
      } else if (vert && (Math.abs(dy) >= SWIPE_MIN || (Math.abs(dy) >= FLICK_MIN && fast(dy)))) {
        const s = useStudio.getState();
        if (s.perform || !useLayout.getState().phone) return;
        if (dy < 0) openPanel(undefined, usePhoneUi.getState().panel ? 'full' : 'half');
        else closePanel();
      }
    };
    const onCancel = (e: PointerEvent) => {
      if (g && e.pointerId === g.id) g = null;
    };

    const tap = (x: number, y: number, t: number) => {
      lastTouchTap = Date.now();
      // a second tap close by: full screen (the first tap's controls toggle is called off)
      if (t - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
        clearTimeout(pending);
        lastTap = { t: 0, x: 0, y: 0 };
        togglePerform();
        return;
      }
      lastTap = { t, x, y };
      clearTimeout(pending);
      pending = setTimeout(() => {
        // in full screen a tap shows or hides its bar; otherwise the controls over the picture
        if (useStudio.getState().perform) window.dispatchEvent(new CustomEvent('hum:stage-tap'));
        else toggleStageControls();
      }, DOUBLE_MS);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      clearTimeout(pending);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [frame]);
}
