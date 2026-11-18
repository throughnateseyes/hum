/**
 * Dev helper: how readable lyrics are on every built-in look.
 *
 * With a track playing, each look is put on screen and its frame is sampled (through the lyric
 * layer's probe, before pop-ups and lyrics) a few times. For each place text can go we measure the
 * picture under it (brightness, spread, busyness), how much of the box the old treatment (the look's
 * text colour over a soft background-coloured shadow) leaves under the contrast target, and the
 * lightest backing the legibility guard would need there. Run from the console:
 *
 *   const { lyricAudit } = await import('/src/dev/lyricAudit.ts'); const rows = await lyricAudit();
 */
import { PRESETS } from '../presets';
import { getScene } from '../scenes';
import { live } from '../state/live';
import { useStudio } from '../state/store';
import { resolvePalette } from '../core/palettes';
import { LADDER, badShare, hexRGB, inksFor, judge, lumOf, regionStats, type FrameProbe, type Rect } from '../render/legibility';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const AUDIT_BOXES: Record<string, Rect> = {
  subBottom: { x0: 0.12, y0: 0.84, x1: 0.88, y1: 0.93 },
  subTop: { x0: 0.12, y0: 0.07, x1: 0.88, y1: 0.16 },
  bigMiddle: { x0: 0.1, y0: 0.36, x1: 0.9, y1: 0.64 },
  bigTop: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.36 },
  bigBottom: { x0: 0.1, y0: 0.62, x1: 0.9, y1: 0.88 },
  left: { x0: 0.06, y0: 0.25, x1: 0.48, y1: 0.75 },
  right: { x0: 0.52, y0: 0.25, x1: 0.94, y1: 0.75 },
};

export interface AuditRow {
  id: string;
  name: string;
  scene: string;
  category: string;
  showsLyrics: boolean;
  light: boolean;
  /** per box: mean luminance, spread, busyness, old-treatment miss share, guard level needed (0 none … 3 band) */
  boxes: Record<string, { mean: number; sd: number; edge: number; oldBad: number; level: number; bad: number }>;
}

export async function lyricAudit(opts: { only?: string[]; settleMs?: number; samples?: number } = {}): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  const stage = live.stage as unknown as { lyricLayer: { probe: FrameProbe }; nextTransition: unknown } | null;
  if (!stage) throw new Error('no stage');
  const probe = stage.lyricLayer.probe;
  for (const p of PRESETS) {
    if (opts.only && !opts.only.includes(p.id)) continue;
    const def = getScene(p.sceneId);
    if (!def) continue;
    stage.nextTransition = { id: 'cut', ms: 1, seed: 0 };
    useStudio.getState().applyPreset(p);
    await wait(opts.settleMs ?? 1500);
    const pal = resolvePalette(useStudio.getState().palette);
    const acc: AuditRow['boxes'] = {};
    const n = opts.samples ?? 5;
    for (let k = 0; k < n; k++) {
      const v = probe.version;
      for (let w = 0; w < 40 && probe.version === v; w++) await wait(25);
      for (const [name, r] of Object.entries(AUDIT_BOXES)) {
        const st = regionStats(probe, r);
        const big = name.startsWith('big') || name === 'left' || name === 'right';
        const fg = hexRGB(pal.fg);
        // the old treatment: the look's text colour over a soft shadow in its background colour
        const oldBad = badShare(probe, r, lumOf(fg), hexRGB(pal.bg), big ? 0.23 : 0.32, big ? 3 : 4.5, st.edge);
        const v2 = judge(probe, r, { inks: inksFor(pal, st), target: big ? 3 : 4.5, ladder: LADDER, pal });
        const a = (acc[name] ??= { mean: 0, sd: 0, edge: 0, oldBad: 0, level: 0, bad: 0 });
        a.mean += st.mean / n;
        a.sd += st.sd / n;
        a.edge += st.edge / n;
        a.oldBad += oldBad / n;
        // the worst moment counts for the backing
        a.level = Math.max(a.level, v2.level);
        a.bad = Math.max(a.bad, v2.bad);
      }
      await wait(220);
    }
    for (const b of Object.values(acc)) for (const k of ['mean', 'sd', 'edge', 'oldBad', 'bad'] as const) b[k] = Math.round(b[k] * 1000) / 1000;
    rows.push({ id: p.id, name: p.name, scene: p.sceneId, category: def.category, showsLyrics: !!def.showsLyrics, light: !!def.light, boxes: acc });
  }
  return rows;
}
