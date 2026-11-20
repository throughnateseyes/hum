/**
 * Which layout the page is in, and the phone layout's own small state.
 *
 * The phone layout is for touch screens up to 760 px wide (and phones on their side, up to 500 px
 * tall): the picture on top, the transport and song map under it, and the panels in a bottom sheet
 * opened from a tab row. Everything else (computers, tablets, a narrow desktop window) keeps the
 * desktop layout. `?phone=1` / `?phone=0` in the address forces it either way (handy on a computer).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { SheetSnap } from './Sheet';

export const useLayout = create<{ phone: boolean; land: boolean }>(() => ({ phone: false, land: false }));

const PHONE_QUERY = '(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const LAND_QUERY = '(orientation: landscape)';

function forced(): boolean | null {
  try {
    const v = new URLSearchParams(location.search).get('phone');
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function read() {
  const f = forced();
  const phone = f ?? matchMedia(PHONE_QUERY).matches;
  const land = phone && matchMedia(LAND_QUERY).matches;
  return { phone, land };
}

/** keep useLayout (and the html element's phone / land classes) in step with the screen; call once */
export function useLayoutWatch() {
  useEffect(() => {
    const apply = () => {
      const v = read();
      const cur = useLayout.getState();
      if (cur.phone !== v.phone || cur.land !== v.land) useLayout.setState(v);
      document.documentElement.classList.toggle('phone', v.phone);
      document.documentElement.classList.toggle('land', v.land);
    };
    apply();
    const qs = [matchMedia(PHONE_QUERY), matchMedia(LAND_QUERY)];
    qs.forEach((q) => q.addEventListener('change', apply));
    window.addEventListener('resize', apply);
    return () => {
      qs.forEach((q) => q.removeEventListener('change', apply));
      window.removeEventListener('resize', apply);
    };
  }, []);
}

/* ───────── the phone's panels: one bottom sheet, opened from the tab row ───────── */

export type PanelId = 'looks' | 'settings' | 'lyrics' | 'export';

export const PANEL_NAME: Record<PanelId, string> = { looks: 'Looks', settings: 'Look settings', lyrics: 'Lyrics', export: 'Export' };

interface PhoneUi {
  /** the open panel (null: the sheet is closed) */
  panel: PanelId | null;
  snap: SheetSnap;
  /** the panel last open (the sheet keeps showing it while it slides away; swipe up reopens it) */
  last: PanelId;
}

export const usePhoneUi = create<PhoneUi>(() => ({ panel: null, snap: 'half', last: 'looks' }));

/** open a panel in the sheet (the last one when none is named), at `snap` or where it was */
export function openPanel(p?: PanelId, snap?: SheetSnap) {
  const s = usePhoneUi.getState();
  const panel = p ?? s.last;
  // switching panels keeps the height, except a peek: a new panel wants room to be read
  const keep = s.panel && !(s.snap === 'peek' && s.panel !== panel);
  usePhoneUi.setState({ panel, last: panel, snap: snap ?? (keep ? s.snap : 'half') });
}

export function closePanel() {
  if (usePhoneUi.getState().panel) usePhoneUi.setState({ panel: null });
}

/* ───────── the stage's touch controls ───────── */

interface StageUi {
  /** the controls over the picture (full screen, Keep / Skip) are showing after a tap */
  controls: boolean;
  /** a light note naming the look a swipe just put on */
  look: { name: string; sub: string; dir: 1 | -1; key: number } | null;
}

export const useStageUi = create<StageUi>(() => ({ controls: false, look: null }));

let controlsTimer: ReturnType<typeof setTimeout> | undefined;
/** a tap on the picture: show the controls for a few seconds, or hide them if they're up */
export function toggleStageControls(force?: boolean) {
  const on = force ?? !useStageUi.getState().controls;
  clearTimeout(controlsTimer);
  useStageUi.setState({ controls: on });
  if (on) controlsTimer = setTimeout(() => useStageUi.setState({ controls: false }), 3500);
}

let lookTimer: ReturnType<typeof setTimeout> | undefined;
export function toastLook(name: string, sub: string, dir: 1 | -1) {
  clearTimeout(lookTimer);
  useStageUi.setState({ look: { name, sub, dir, key: Date.now() } });
  lookTimer = setTimeout(() => useStageUi.setState({ look: null }), 1500);
}
