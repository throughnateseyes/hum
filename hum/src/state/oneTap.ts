/**
 * One-tap start: drop a song (or pick one, or a demo) and it analyses, plans the video and plays it
 * from the top, with no other steps. Lyrics are found and synced on their own as before.
 *
 *   load → analyse (the stage shows one calm progress state, the song waits silently at 0:00)
 *        → the offline plan right away (never waits for the network), played from the top
 *        → in the background: Claude's plan (when it's reachable and allowed without asking for a
 *          code), sent once the lyrics lookup has settled so it can fit the words, then swapped in
 *          just before the next part starts, so the change lands on a part line
 *        → lyrics that arrive later get a lyric plan of their own (the words are re-timed as usual)
 *
 * A Claude plan made for the song before plays at once instead (free, saved in this browser).
 * Anything the person does to the video (a look dropped on a part, Remake video, a new song) wins:
 * the background work notices the plan isn't the one it started and lets go.
 *
 * Autoplay: the drop, tap or click that loaded the song is the gesture. It unlocks the player there
 * and then (audioEngine.unlock); if sound still can't start when the plan is ready, the stage shows
 * one big play button (`needsTap`). The setting (Look tab → Video, on by default) turns all of it off
 * for people who'd rather start things themselves.
 */
import { audioEngine } from '../audio/engine';
import type { TrackAnalysis } from '../core/types';
import { onFrame } from './live';
import { putOn } from './flatPlan';
import { findLook, keepPlan, offlineVideoPlan, requestVideoPlan, savedPlanFor, sectionIndexAt, sectionNames, startPlan, withBase, withLyricsNow, type VideoPlan } from './plan';
import { originalOf } from './planCache';
import { recallPlan } from './saved';
import { useStudio } from './store';
import { planSignature, rememberPlan } from './taste';

/** the one-tap start under way; a new song starts a new one and the old one's work lets go */
let run = 0;
/** the plan one-tap put on (and keeps up to date); anything else on the song map means hands off */
let auto: VideoPlan | null = null;

/** Claude's plan is swapped in this long before the part it starts with */
const SWAP_LEAD = 2;
/** how long Claude's request waits for the lyrics lookup (so it can fit the looks to the words) */
const LYRICS_WAIT_MS = 8000;

/** a song started loading with one-tap on: show the progress state */
export function beginStartup() {
  run++;
  auto = null;
  useStudio.getState().set({ startup: { step: 'listen', since: performance.now(), duration: 0 }, needsTap: false });
}

/** the song's length is known (it's decoded): the progress bar can pace itself */
export function startupKnows(duration: number) {
  const s = useStudio.getState().startup;
  if (s) useStudio.getState().set({ startup: { ...s, duration } });
}

/** loading failed or was replaced by live sound: no progress state */
export function endStartup() {
  run++;
  if (useStudio.getState().startup) useStudio.getState().set({ startup: null });
}

/** the stage's big play button: one tap starts the song (and the audio context) */
export async function tapToPlay() {
  audioEngine.ensureContext();
  const ok = await audioEngine.start();
  useStudio.getState().set({ needsTap: !ok });
}

/**
 * The song is analysed: plan its video and play it from the top. `current` says whether this song is
 * still the one loaded (a newer load makes it false).
 */
export async function planAndPlay(a: TrackAnalysis, current: () => boolean, opts: { offline?: boolean } = {}) {
  const my = run;
  // the playing analysis is the song cut at the video's parts (flatPlan.ts): the same song is alive
  const alive = () => {
    const now = useStudio.getState().analysis;
    return my === run && current() && !!now && originalOf(now) === a;
  };
  const st = useStudio.getState();
  st.set({ startup: { step: 'plan', since: performance.now(), duration: a.duration } });

  // a song brought back by a reload gets the video it had, with any changes made by hand
  if (opts.offline) {
    const before = recallPlan(st.track?.name ?? '', a, (id) => !!findLook(id));
    if (before) {
      await go(withBase(before, a), a, `This is the video you had before the page reloaded. ${before.note}`.trim(), false, true);
      return;
    }
  }

  // a Claude plan made for this song before: play it straight away, nothing else to ask
  const saved = savedPlanFor(a);
  if (saved) {
    await go(withBase(saved.plan, a), a, `Your saved video for this song (no new request). Remake video asks Claude for a fresh take. ${saved.plan.note}`.trim(), !opts.offline, true);
    keepPlan(saved.plan, a);
    return;
  }

  const offline = withBase(await offlineVideoPlan(a, st.lyrics), a);
  if (!alive()) return;
  // a song brought back after a reload never asks Claude by itself: nobody chose to spend that
  await go(offline, a, opts.offline ? `${offline.note} This is the song from last time, planned here on your computer. Remake video asks Claude for its take.` : `${offline.note} Claude is planning a take of its own in the background; it takes over at a part change if it's ready.`, !opts.offline);
  if (!alive()) return;
  followLyrics(a, alive);
  if (!opts.offline) void upgrade(a, alive);
}

/**
 * `play` false: the plan goes on but the song waits at the top for a tap (a song brought back by a
 * reload must not start by itself). `restore`: a saved plan, with its own per-part settings. The plan
 * goes on one look per part (flatPlan.ts), so `auto` is the plan as it plays: "still the plan we put
 * on" is an identity check.
 */
async function go(plan: VideoPlan, a: TrackAnalysis, text: string, play = true, restore = false) {
  const started = startPlan(plan, a, text, { play, restore });
  auto = useStudio.getState().plan;
  await started;
  useStudio.getState().set(play ? { startup: null } : { startup: null, needsTap: true });
}

/** resolves once `ok` holds, the time runs out or the start is no longer alive */
function until(ok: (s: ReturnType<typeof useStudio.getState>) => boolean, ms: number, alive: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ok(useStudio.getState()) || !alive()) return resolve();
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const off = useStudio.subscribe((s) => {
      if (ok(s) || !alive()) done();
    });
  });
}

/** ask Claude for its take in the background and swap it in at the next part line */
async function upgrade(a: TrackAnalysis, alive: () => boolean) {
  await until((s) => s.lyricsStatus !== 'searching', LYRICS_WAIT_MS, alive);
  if (!alive() || useStudio.getState().plan !== auto || !auto) return;
  // the fallback is the planner's own plan (per section), not its flattened parts
  const base = auto.flat?.src ?? auto;
  const { plan } = await requestVideoPlan(a, useStudio.getState().lyrics, base, { quiet: true });
  if (!alive() || plan.source !== 'claude') return;
  // saved for next time even if it never plays this time
  keepPlan(plan, a);
  if (useStudio.getState().plan !== auto) return;
  swapAtPartLine(plan, a, alive);
}

function swapAtPartLine(plan: VideoPlan, a: TrackAnalysis, alive: () => boolean) {
  const secs = a.sections;
  const off = onFrame(() => {
    const s = useStudio.getState();
    if (!alive() || s.plan !== auto || !s.planOn) {
      off();
      return;
    }
    const t = audioEngine.currentTime;
    const i = sectionIndexAt(secs, t);
    // nothing seen yet (waiting for a tap, or still at the top): take over now
    const fresh = !audioEngine.playing && t < 0.5;
    const nearLine = i < secs.length - 1 && secs[i].end - t <= SWAP_LEAD;
    if (!fresh && !nearLine) return;
    off();
    rememberPlan(a, planSignature(plan));
    auto = putOn(plan, a).plan;
    const from = fresh ? 0 : i + 1;
    const name = sectionNames(secs)[from] ?? 'the next part';
    s.pushChat({ role: 'director', mode: 'plan', title: plan.title, text: `Claude's plan takes over from ${fresh ? 'the top' : name}. ${plan.note}`, source: 'claude', via: plan.via });
    if (!fresh) s.flash(`Claude's plan from ${name}`);
  });
}

/**
 * Lyrics found (or re-timed) after the offline plan went on: give the plan a lyric plan for them.
 * Claude's plan arrives with its own lyric choices, so once it's on, this stops.
 */
function followLyrics(a: TrackAnalysis, alive: () => boolean) {
  let last = useStudio.getState().lyrics;
  const off = useStudio.subscribe((s) => {
    if (!alive() || !auto || s.plan !== auto || auto.source === 'claude') {
      off();
      return;
    }
    if (s.lyrics === last) return;
    last = s.lyrics;
    const base = auto;
    // the planner's plan gets the lyric plan, and is cut into parts again (its shots can land on lines)
    void withLyricsNow(base, a, s.lyrics).then((p) => {
      if (!alive() || useStudio.getState().plan !== base) return;
      auto = putOn(p, a).plan;
    });
  });
}
