/**
 * Quality governor: keeps the picture smooth on slower machines without anyone touching a setting.
 *
 * It watches how long frames take (from the stage's own animation loop) and, when frames run late,
 * steps the detail down one rung at a time, cheapest-to-lose first. The biggest lever is the number of
 * pixels drawn: a 4K monitor (or a big window at devicePixelRatio 2) asks for four times the pixels of
 * 1080p, and every pass (the look, its effects, the finish, pop-ups, lyrics) pays for each one. So the
 * ladder starts with a pixel budget for the whole stage, and the browser scales the picture up to the
 * screen for free:
 *
 *   0  the screen's own pixels (devicePixelRatio, capped at 2)
 *   1  at most ~3.7 million pixels (1440p)
 *   2  at most ~2.1 million pixels (1080p)          ← where a machine with no history starts
 *   3  1080p, at most one pop-up scene window, drawn without its effects
 *   4  1080p, no pop-up scene windows
 *   5  1080p, the main look drawn at 80% size (then scaled up)
 *   6  ~1.45 million pixels (900p), the main look at 80%
 *   7  720p, the look at 80%, effects at the look's size
 *   8  720p, the look at 67%, a lighter hand-drawn finish
 *   9  540p (a software renderer's floor)
 *
 * A machine it has never seen starts at rung 2 and climbs when frames come in on time, instead of
 * starting at the top and stuttering its way down in the first seconds. Where it settles is remembered
 * per graphics card (localStorage), so the next visit starts there.
 *
 * "Late" is judged against the display's real interval: on a 144 Hz monitor the stage draws every
 * second refresh (72 pictures a second, see `drawEvery`), so a frame is late when it misses that, not
 * when it runs past a fixed 16.7 ms.
 *
 * When frames come in on time again for a while it tries one rung up. If that rung was too much it
 * goes back down and waits twice as long before trying again (up to a minute), so it settles instead
 * of flickering between two levels. The "Render quality" setting stays the ceiling: the governor only
 * ever takes detail away from what that setting asks for. Rungs that would draw the same picture on
 * this screen (a small window is under every budget) are stepped over.
 *
 * Offline rendering (exporting a clip frame by frame) must get the full picture every frame, whatever
 * the machine can do in real time: call `quality.freeze(true)` before and `quality.freeze(false)`
 * after. The stage also ignores the governor while it renders at a fixed output size.
 */

export interface QualityRung {
  /** most pixels the stage's drawing buffer may have (Infinity = the screen's own) */
  maxPx: number;
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

const P1440 = 2560 * 1440;
const P1080 = 1920 * 1080 * 1.02;
const P900 = 1600 * 900;
const P720 = 1280 * 720;
const P540 = 960 * 540;

export const LADDER: readonly QualityRung[] = [
  { maxPx: Infinity, windows: 3, windowFx: true, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { maxPx: P1440, windows: 3, windowFx: true, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { maxPx: P1080, windows: 3, windowFx: true, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { maxPx: P1080, windows: 1, windowFx: false, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { maxPx: P1080, windows: 0, windowFx: false, sceneScale: 1, fxAtSceneScale: false, handLite: false },
  { maxPx: P1080, windows: 0, windowFx: false, sceneScale: 0.8, fxAtSceneScale: false, handLite: false },
  { maxPx: P900, windows: 0, windowFx: false, sceneScale: 0.8, fxAtSceneScale: false, handLite: false },
  { maxPx: P720, windows: 0, windowFx: false, sceneScale: 0.8, fxAtSceneScale: true, handLite: false },
  { maxPx: P720, windows: 0, windowFx: false, sceneScale: 0.67, fxAtSceneScale: true, handLite: true },
  { maxPx: P540, windows: 0, windowFx: false, sceneScale: 0.67, fxAtSceneScale: true, handLite: true },
];
export const FULL = LADDER[0];
const TOP = LADDER.length - 1;
/** where a machine with no history starts (1080p, everything on) */
export const START_LEVEL = 2;

/** tuning, in milliseconds unless noted */
export const TUNING = {
  /** the most pictures a second the stage draws by default (faster screens draw every 2nd or 3rd refresh) */
  maxFps: 60,
  /** frames looked at for a decision (~1.5 s at 60 fps) */
  window: 90,
  /** a frame this many expected intervals long counts as late */
  lateAt: 1.4,
  /** step down when this share of frames is late… */
  lateShare: 0.2,
  /** …or the average frame is this many expected intervals long */
  slowAvg: 1.25,
  /** wait at least this long after any change before stepping down again */
  downCooldown: 2000,
  /** frames must be on time this long before trying a rung up (doubles after each failed try) */
  upWait: 4000,
  upWaitMax: 60_000,
  /** a rung up that has to come back down within this long counts as a failed try */
  probeGrace: 6000,
  /** on time = at most this share of late frames and an average within this many intervals */
  calmShare: 0.03,
  calmAvg: 1.1,
  /** gaps longer than this (a hidden tab, a breakpoint) aren't frames: start over */
  gap: 250,
  /** a level held this long is remembered for this machine's next visit */
  settle: 8000,
};

/** common refresh rates; a measured interval snaps to the nearest (never below 60 Hz) */
const RATES = [60, 75, 90, 100, 120, 144, 165, 180, 240];

export interface QualityEvent {
  at: number;
  level: number;
  why: string;
  avg: number;
  late: number;
}

type Listener = () => void;

const STORE_KEY = 'hum.quality.v2';

export class QualityGovernor {
  level = START_LEVEL;
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
  /** the screen's own pixel count at the "Render quality" ceiling (set by the stage on every resize) */
  private screenPx = Infinity;
  /** the graphics card, so a remembered level belongs to this machine */
  private machine = '';
  private saved = -1;
  /** display refresh, measured from the animation loop's own intervals */
  private raw = new Float32Array(120);
  private rawN = 0;
  private rawHead = 0;
  refreshHz = 60;
  /** where the level started this visit, and why */
  startedFrom = 'no history: 1080p';

  /** a rung pinned by hand for testing (`quality.force(3)`), drawn even at a fixed output size */
  forced: number | null = null;

  /** the rung to draw with right now */
  current(): QualityRung {
    if (this.forced !== null) return LADDER[this.forced];
    return this.frozen || !this.on ? FULL : LADDER[this.level];
  }

  /** true while the governor is drawing less than 1080p with everything on (for the UI) */
  get easing(): boolean {
    const r = this.current();
    return r.windows < 3 || r.sceneScale < 1 || Math.min(r.maxPx, this.screenPx) < Math.min(P1080, this.screenPx);
  }

  /** pin a rung (0 … 9) to see or time it, or null to let the governor decide again */
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

  /** the stage tells us how many pixels the screen itself would take, so equal rungs can be skipped */
  setScreen(px: number) {
    this.screenPx = px;
  }

  /** the graphics card's name: start where this machine settled last time */
  setMachine(name: string) {
    if (this.machine === name) return;
    this.machine = name;
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, number>;
      const lv = all[name];
      if (typeof lv === 'number' && lv >= 0 && lv <= TOP) {
        this.level = this.saved = lv;
        this.startedFrom = `remembered for this machine: rung ${lv}`;
        this.emit();
      }
    } catch {
      /* private window or storage blocked: start fresh */
    }
  }

  /** a software renderer gets a much lower start (it has no GPU at all) */
  startAt(level: number, why: string) {
    if (this.saved >= 0) return;
    this.level = Math.max(0, Math.min(TOP, level));
    this.startedFrom = why;
    this.emit();
  }

  /** how many display refreshes each drawn frame spans (1 at 60 Hz, 2 at 120 or 144 Hz, 4 at 240 Hz) */
  get drawEvery(): number {
    const ri = 1000 / this.refreshHz;
    const want = 1000 / TUNING.maxFps;
    return Math.max(1, Math.ceil((want - ri / 2) / ri));
  }

  /** the interval a drawn frame should take on this display (ms) */
  get target(): number {
    return (1000 / this.refreshHz) * this.drawEvery;
  }

  /**
   * Call on every animation frame (drawn or not): the intervals teach us the display's refresh rate.
   * The fastest tenth of recent intervals is the refresh; a machine too slow to ever hit it is assumed
   * to be on a 60 Hz screen. It only ever moves up (a busy stretch can't make a 144 Hz screen look slow).
   */
  refreshSample(dt: number) {
    if (dt <= 0 || dt > 100) return;
    this.raw[this.rawHead] = dt;
    this.rawHead = (this.rawHead + 1) % this.raw.length;
    if (this.rawN < this.raw.length) this.rawN++;
    if (this.rawN < 60 || this.rawHead % 30) return;
    const s = Array.from(this.raw.subarray(0, this.rawN)).sort((a, b) => a - b);
    const fast = s[Math.floor(s.length * 0.1)];
    const hz = 1000 / fast;
    let best = 60;
    for (const r of RATES) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
    if (best > this.refreshHz) {
      this.refreshHz = best;
      this.reset();
    }
  }

  /** call once per drawn frame, from the stage's animation loop only */
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
    if (this.level !== this.saved && now - this.changedAt > TUNING.settle) this.remember();
    if (this.n < TUNING.window / 2) return;
    this.decide(now);
  }

  private push(dt: number) {
    const lateAt = this.target * TUNING.lateAt;
    if (this.n === TUNING.window) {
      const old = this.dts[this.head];
      this.sum -= old;
      if (old > lateAt) this.lateCount--;
    } else this.n++;
    this.dts[this.head] = dt;
    this.head = (this.head + 1) % TUNING.window;
    this.sum += dt;
    if (dt > lateAt) this.lateCount++;
  }

  /** what rung `k` would actually draw on this screen (rungs with the same picture are one step) */
  private sig(k: number): string {
    const r = LADDER[k];
    return `${Math.min(r.maxPx, this.screenPx)}|${r.windows}|${r.windowFx}|${r.sceneScale}|${r.fxAtSceneScale}|${r.handLite}`;
  }

  /** the next rung down (or up) that draws something different here, or -1 */
  private step(dir: 1 | -1): number {
    const here = this.sig(this.level);
    for (let k = this.level + dir; k >= 0 && k <= TOP; k += dir) if (this.sig(k) !== here) return dir > 0 ? k : this.topOfGroup(k);
    return -1;
  }

  /** climbing: land on the lowest-numbered rung of a group that draws the same (so the next climb is real) */
  private topOfGroup(k: number): number {
    const s = this.sig(k);
    while (k > 0 && this.sig(k - 1) === s) k--;
    return k;
  }

  private decide(now: number) {
    const avg = this.sum / this.n;
    const late = this.lateCount / this.n;
    const target = this.target;
    const slow = late > TUNING.lateShare || avg > target * TUNING.slowAvg;
    if (slow) {
      this.calmSince = -1;
      const next = this.step(1);
      if (next >= 0 && now - this.changedAt > TUNING.downCooldown) {
        // a rung up that didn't hold: wait twice as long before the next try
        if (now - this.probeAt < TUNING.probeGrace) this.upWait = Math.min(TUNING.upWaitMax, this.upWait * 2);
        this.probeAt = -1e9;
        this.set(next, `frames late (avg ${avg.toFixed(1)} ms vs ${target.toFixed(1)}, ${Math.round(late * 100)}% late)`, now, avg, late);
      }
      return;
    }
    const calm = late <= TUNING.calmShare && avg <= target * TUNING.calmAvg;
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
    const up = this.step(-1);
    if (up >= 0 && now - this.calmSince >= this.upWait && now - this.changedAt >= this.upWait) {
      this.probeAt = now;
      this.set(up, `room to spare (avg ${avg.toFixed(1)} ms)`, now, avg, late);
    }
  }

  private remember() {
    this.saved = this.level;
    if (!this.machine) return;
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, number>;
      all[this.machine] = this.level;
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      /* storage blocked: it just starts at 1080p next time */
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
