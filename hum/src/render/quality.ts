/**
 * Quality governor: keeps the picture smooth on slower machines without anyone touching a setting.
 *
 * It watches how long frames take (from the stage's own animation loop) and, when frames run late,
 * steps the detail down one rung at a time, cheapest-to-lose first:
 *
 *   1  at most one pop-up scene window, drawn without its effects
 *   2  no pop-up scene windows
 *   3  the main look drawn at 80% size (then scaled up)
 *   4  the main look at 67%
 *   5  effects run at the main look's size too
 *   6  a lighter hand-drawn finish (no misregistered inks)
 *   7  the main look at 50%
 *
 * When frames come in on time again for a while it tries one rung up. If that rung was too much it
 * goes back down and waits twice as long before trying again (up to a minute), so it settles instead
 * of flickering between two levels. The "Render quality" setting stays the ceiling: the governor only
 * ever takes detail away from what that setting asks for.
 *
 * Offline rendering (exporting a clip frame by frame) must get the full picture every frame, whatever
 * the machine can do in real time: call `quality.freeze(true)` before and `quality.freeze(false)`
 * after. The stage also ignores the governor while it renders at a fixed output size.
 */

export interface QualityRung {
  /** most pop-up scene windows open at once (3 = no limit) */
  windows: number;
  /** pop-up scene windows run their look's effects */
  windowFx: boolean;
  /** the main look's render size, as a share of the output size */
  sceneScale: number;
  /** effects run at the main look's (smaller) size instead of the output size */
  fxAtSceneScale: boolean;
  /** the hand-drawn finish skips its most expensive part (inks drawn out of register) */
  handLite: boolean;
}

export const LADDER: readonly QualityRung[] = [
  { windows: 3, windowFx: true, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { windows: 1, windowFx: false, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { windows: 0, windowFx: false, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { windows: 0, windowFx: false, sceneScale: 0.8, fxAtSceneScale: false, handLite: false },
  { windows: 0, windowFx: false, sceneScale: 0.67, fxAtSceneScale: false, handLite: false },
  { windows: 0, windowFx: false, sceneScale: 0.67, fxAtSceneScale: true, handLite: false },
  { windows: 0, windowFx: false, sceneScale: 0.67, fxAtSceneScale: true, handLite: true },
  { windows: 0, windowFx: false, sceneScale: 0.5, fxAtSceneScale: true, handLite: true },
];
export const FULL = LADDER[0];
const TOP = LADDER.length - 1;

/** tuning, in milliseconds unless noted */
export const TUNING = {
  /** the frame budget we aim for (60 fps); faster screens aren't chased */
  target: 1000 / 60,
  /** frames looked at for a decision (~1.5 s at 60 fps) */
  window: 90,
  /** a frame this many budgets long counts as late */
  lateAt: 1.5,
  /** step down when this share of frames is late… */
  lateShare: 0.2,
  /** …or the average frame is this many budgets long */
  slowAvg: 1.25,
  /** wait at least this long after any change before stepping down again */
  downCooldown: 2000,
  /** frames must be on time this long before trying a rung up (doubles after each failed try) */
  upWait: 4000,
  upWaitMax: 60_000,
  /** a rung up that has to come back down within this long counts as a failed try */
  probeGrace: 6000,
  /** on time = at most this share of late frames and an average within this many budgets */
  calmShare: 0.03,
  calmAvg: 1.1,
  /** gaps longer than this (a hidden tab, a breakpoint) aren't frames: start over */
  gap: 250,
};

export interface QualityEvent {
  at: number;
  level: number;
  why: string;
  avg: number;
  late: number;
}

type Listener = () => void;

export class QualityGovernor {
  level = 0;
  /** history of level changes (newest last, at most 60) */
  readonly history: QualityEvent[] = [];
  private frozen = false;
  private on = true;
  private dts = new Float32Array(TUNING.window);
  private n = 0;
  private head = 0;
  private sum = 0;
  private lateCount = 0;
  private last = -1;
  private changedAt = -1e9;
  private calmSince = -1;
  private upWait = TUNING.upWait;
  private probeAt = -1e9;
  private listeners = new Set<Listener>();

  /** a rung pinned by hand for testing (`quality.force(3)`), drawn even at a fixed output size */
  forced: number | null = null;

  /** the rung to draw with right now */
  current(): QualityRung {
    if (this.forced !== null) return LADDER[this.forced];
    return this.frozen || !this.on ? FULL : LADDER[this.level];
  }

  /** pin a rung (0 … 7) to see or time it, or null to let the governor decide again */
  force(level: number | null) {
    this.forced = level === null ? null : Math.max(0, Math.min(TOP, Math.round(level)));
    this.emit();
  }

  /** hold full quality (offline rendering); releasing it starts measuring afresh */
  freeze(on: boolean) {
    if (this.frozen === on) return;
    this.frozen = on;
    this.reset();
    this.emit();
  }
  get isFrozen() {
    return this.frozen;
  }

  /** switch the governor off (always full detail) or back on */
  auto(on: boolean) {
    if (this.on === on) return;
    this.on = on;
    if (!on) this.set(0, 'switched off', performance.now());
    this.reset();
  }

  /** call once per displayed frame, from the stage's animation loop only */
  sample(now: number) {
    if (this.frozen || !this.on) return;
    const prev = this.last;
    this.last = now;
    if (prev < 0) return;
    const dt = now - prev;
    if (dt > TUNING.gap || dt <= 0) {
      this.reset();
      this.last = now;
      return;
    }
    this.push(dt);
    if (this.n < TUNING.window / 2) return;
    this.decide(now);
  }

  private push(dt: number) {
    const late = dt > TUNING.target * TUNING.lateAt;
    if (this.n === TUNING.window) {
      const old = this.dts[this.head];
      this.sum -= old;
      if (old > TUNING.target * TUNING.lateAt) this.lateCount--;
    } else this.n++;
    this.dts[this.head] = dt;
    this.head = (this.head + 1) % TUNING.window;
    this.sum += dt;
    if (late) this.lateCount++;
  }

  private decide(now: number) {
    const avg = this.sum / this.n;
    const late = this.lateCount / this.n;
    const slow = late > TUNING.lateShare || avg > TUNING.target * TUNING.slowAvg;
    if (slow) {
      this.calmSince = -1;
      if (this.level < TOP && now - this.changedAt > TUNING.downCooldown) {
        // a rung up that didn't hold: wait twice as long before the next try
        if (now - this.probeAt < TUNING.probeGrace) this.upWait = Math.min(TUNING.upWaitMax, this.upWait * 2);
        this.probeAt = -1e9;
        this.set(this.level + 1, `frames late (avg ${avg.toFixed(1)} ms, ${Math.round(late * 100)}% late)`, now, avg, late);
      }
      return;
    }
    const calm = late <= TUNING.calmShare && avg <= TUNING.target * TUNING.calmAvg;
    if (!calm) {
      this.calmSince = -1;
      return;
    }
    if (this.calmSince < 0) this.calmSince = now;
    // a try that held for a while earns a quicker next try
    if (this.probeAt > 0 && now - this.probeAt > TUNING.probeGrace * 2 && this.upWait > TUNING.upWait) {
      this.upWait = Math.max(TUNING.upWait, this.upWait / 2);
      this.probeAt = -1e9;
    }
    if (this.level > 0 && now - this.calmSince >= this.upWait && now - this.changedAt >= this.upWait) {
      this.probeAt = now;
      this.set(this.level - 1, `room to spare (avg ${avg.toFixed(1)} ms)`, now, avg, late);
    }
  }

  private set(level: number, why: string, now: number, avg = 0, late = 0) {
    if (level === this.level) return;
    this.level = level;
    this.changedAt = now;
    this.calmSince = -1;
    // the frames measured at the old level say nothing about the new one
    this.n = 0;
    this.head = 0;
    this.sum = 0;
    this.lateCount = 0;
    this.history.push({ at: Math.round(now), level, why, avg: Math.round(avg * 10) / 10, late: Math.round(late * 100) / 100 });
    if (this.history.length > 60) this.history.shift();
    if (import.meta.env?.DEV) console.info(`[hum] quality ${level}/${TOP}: ${why}`);
    this.emit();
  }

  private reset() {
    this.n = 0;
    this.head = 0;
    this.sum = 0;
    this.lateCount = 0;
    this.last = -1;
    this.calmSince = -1;
  }

  /** for the UI: called when the level (or frozen state) changes */
  subscribe(f: Listener): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit() {
    for (const f of this.listeners) f();
  }
}

/** the one governor the stage uses */
export const quality = new QualityGovernor();
