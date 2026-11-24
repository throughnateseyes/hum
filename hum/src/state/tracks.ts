import { audioEngine } from '../audio/engine';
import { analyzeTrack } from '../audio/analysis';
import { findLyrics, toLyrics, type LrclibRecord } from '../audio/lyrics';
import { alignLyrics, cancelListening, ListenCancelled, listenForWords, offsetByVocals, shift, spreadLyrics, type HeardWord } from '../audio/align';
import type { LyricLine, Lyrics } from '../core/types';
import { readTags } from '../audio/tags';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { lookShows } from '../director/footage';
import { PRESETS } from '../presets';
import { loadPhoto } from '../scenes/photo/loadPhoto';
import { loadClip, looksLikeVideo } from '../shot/clips';
import { startDrawings } from '../draw/session';
import { useStudio, type TrackInfo } from './store';
import { beginStartup, endStartup, planAndPlay, startupKnows, tapToPlay } from './oneTap';
import { forgetSong, keepClipsSaved, keepPhotosSaved, keepPlanSaved, recallClips, recallPhotos, recallSong, rememberSong } from './saved';

const demoCache = new Map<string, Blob>();
let loadToken = 0;

/**
 * Load audio, analyse it, then either plan its video and play it from the top (one-tap start, the
 * default: see oneTap.ts), or play it at once and theme the stage from the analysis (one-tap off).
 * Call it straight from the tap, click or drop that chose the song: that gesture is what lets the
 * song play once it's ready.
 */
export async function loadTrack(blob: Blob, info: TrackInfo, opts: { autoTheme?: boolean; restored?: boolean } = {}) {
  const token = ++loadToken;
  const oneTap = useStudio.getState().oneTap && opts.autoTheme !== false;
  // the last song's lyrics may still be being listened to: stop that, it's no use now
  cancelListening();
  lastFile = info.source === 'file' ? { blob, name: info.name } : null;
  lastBuf = null;
  lastHeard = null;
  retimed = null;
  songBuf = null;
  const st = useStudio.getState();
  st.set({ track: info, analysis: null, analyzing: true, plan: null, partPops: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsNote: '', lyricsSync: null, lyricsMatched: null, lyricsQuery: {}, tapSync: false, needsTap: false });
  const ctx = audioEngine.ensureContext();
  if (oneTap) {
    // still inside the gesture: unlock the player now, it plays once the video is planned
    audioEngine.unlock();
    beginStartup();
  } else endStartup();
  try {
    await audioEngine.loadFile(blob, null);
    if (!oneTap && !opts.restored) void audioEngine.play().catch(() => {});
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== loadToken) return;
    if (oneTap) startupKnows(buf.duration);
    songBuf = buf;
    if (info.source === 'file') lastBuf = buf;
    // lyrics are looked up alongside the analysis (demo tracks are instrumental)
    if (info.source === 'file') void lookUpLyrics(blob, info.name, buf.duration, token);
    const analysis = await analyzeTrack(
      buf,
      [...PRESETS, ...useStudio.getState().customPresets].filter(lookShows).map((p) => ({ id: p.id, tags: p.tags })),
    );
    if (token !== loadToken) return;
    audioEngine.setAnalysis(analysis);
    useStudio.getState().set({ analysis, analyzing: false });
    // it opened and it's a song: keep it for the next time the page loads (saved.ts)
    if (!opts.restored) void rememberSong(info.source === 'demo' ? { name: info.name, source: 'demo', id: info.id } : { name: info.name, source: 'file', blob });
    if (oneTap) {
      // no parts to plan (a very short or very even sound): just play it
      if (analysis.sections.length) void planAndPlay(analysis, () => token === loadToken, { offline: opts.restored });
      else {
        endStartup();
        void tapToPlay();
      }
    } else if (opts.autoTheme !== false) {
      const pick = analysis.suggestedPresets.map((id) => PRESETS.find((p) => p.id === id)).find(Boolean);
      if (pick) {
        useStudio.getState().applyPreset(pick);
        useStudio.getState().flash(`Heard ${analysis.tags.slice(0, 3).join(', ')} · ${Math.round(analysis.bpm)} bpm → “${pick.name}”`);
      }
    }
  } catch (e) {
    console.error(e);
    if (token === loadToken) {
      endStartup();
      useStudio.getState().set({ analyzing: false });
      useStudio.getState().flash('Could not read that audio file');
    }
  }
}

/** Read the file's tags and find timed lyrics. Runs in the background; never throws. */
export async function lookUpLyrics(blob: Blob, name: string, duration: number, token = loadToken) {
  // lyrics pasted or fixed by hand for this song before win over anything found
  const saved = loadSaved(name, duration);
  if (saved) {
    useStudio.getState().set({
      lyrics: saved.lyrics,
      lyricsStatus: 'found',
      lyricsMatched: saved.matched ?? null,
      lyricsNote: saved.auto ? 'Synced to the singing when you last played it' : 'Your saved lyrics for this song',
    });
    return;
  }
  useStudio.getState().set({ lyricsStatus: 'searching', lyricsNote: '' });
  try {
    const tags = await readTags(blob);
    const res = await findLyrics({ tags, fileName: name, duration });
    if (token !== loadToken) return;
    let l = res.lyrics;
    const what = [res.query.artist, res.query.title].filter(Boolean).join(' — ');
    useStudio.getState().set({ lyricsQuery: res.query });
    let note = what;
    if (l?.synced && res.lengthDiff) {
      // timed for a different length (a music video's intro, a radio edit): line it up with this file
      const fixed = await retimeToFile(l, duration + res.lengthDiff);
      if (token !== loadToken) return;
      l = fixed.lyrics;
      note = fixed.note;
    }
    if (l?.instrumental) useStudio.getState().set({ lyrics: null, lyricsStatus: 'instrumental', lyricsNote: what });
    else if (l?.synced) {
      useStudio.getState().set({ lyrics: l, lyricsStatus: 'found', lyricsNote: note });
      void autoSync(token);
    } else if (l?.plain) {
      useStudio.getState().set({ lyrics: l, lyricsStatus: 'plain', lyricsNote: what });
      void autoSync(token);
    } else useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: `${res.reason ?? 'No lyrics found.'}${what ? ` Searched for “${what}”.` : ''}` });
  } catch (e) {
    console.warn('[hum] lyrics lookup failed', e);
    if (token === loadToken) useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: 'Lyrics lookup failed.' });
  }
}

/** the decoded audio of the loaded song or demo (the render timeline makes its videos from it) */
let songBuf: AudioBuffer | null = null;
export function songBuffer(): AudioBuffer | null {
  return songBuf;
}

/** the blob of the loaded file, for "try again" */
let lastFile: { blob: Blob; name: string } | null = null;
export function retryLyrics() {
  const d = audioEngine.frame.duration;
  if (lastFile && d) void lookUpLyrics(lastFile.blob, lastFile.name, d);
}

/* ───────────────────────── pasted lyrics ───────────────────────── */

/** the decoded audio of the loaded file, for listening to the words */
let lastBuf: AudioBuffer | null = null;

/** can the loaded track have lyrics pasted and synced? */
export function canSyncLyrics() {
  return !!lastBuf;
}

/**
 * Time lyrics to the song by listening for the sung words on this computer. Lyrics that already
 * have timings (LRCLIB, the file, an earlier sync) keep them as a guide: the heard words move them
 * onto the singing, and lines nothing was heard for follow the old timing, shifted the same way.
 * Pasted words with no timing fall back to spreading the lines evenly, ready to be tapped into place.
 *
 * A song is only listened to once: what was heard is kept, so syncing again (other lyrics picked,
 * pasted, or the button pressed after it synced on its own) is instant. `auto` is the sync that runs
 * by itself after a song loads: it stays quiet when it can't help.
 */
export async function syncPastedLyrics(text: string, keep: Partial<Pick<Lyrics, 'source' | 'title' | 'artist'>> = {}, opts: { auto?: boolean } = {}) {
  const buf = lastBuf;
  const st = useStudio.getState();
  if (!buf || !lastFile || st.lyricsSync) return;
  const token = loadToken;
  const prior = st.lyrics;
  let guide = prior?.synced && prior.lines.length ? prior.lines : undefined;
  let base: Omit<Lyrics, 'lines'> = { synced: true, source: 'pasted', plain: text, title: prior?.title, artist: prior?.artist, ...keep };
  const lang = guessLanguage(text);
  autoRunning = !!opts.auto;
  st.set({ lyricsSync: { stage: 'prepare', frac: 0 }, lyricsMatched: null });
  let lines: LyricLine[] = [];
  let matched = 0;
  let note = '';
  try {
    const heard =
      lastHeard && lastHeardLang === lang ? lastHeard : await listenForWords(buf, (p) => token === loadToken && useStudio.getState().set({ lyricsSync: p }), lang);
    if (token !== loadToken) return;
    lastHeard = heard;
    lastHeardLang = lang;
    // other lyrics picked (or the lines shifted) while it listened: line those up instead
    const now = useStudio.getState().lyrics;
    if (now !== prior) {
      if (!now) {
        useStudio.getState().set({ lyricsSync: null });
        return;
      }
      text = now.lines.length ? now.lines.map((l) => l.text).join('\n') : (now.plain ?? '');
      guide = now.synced && now.lines.length ? now.lines : undefined;
      base = { synced: true, source: now.source, plain: text, title: now.title, artist: now.artist };
    }
    const res = alignLyrics(text, heard, buf.duration, { prior: guide });
    lines = res.lines;
    matched = res.matched;
    if (matched < (guide ? 0.1 : 0.25)) note = guide ? 'Couldn’t hear enough of the words to improve the timing.' : 'Couldn’t hear many of the words, so the timing is rough. Tap to fix it.';
  } catch (e) {
    if (token !== loadToken) return;
    if (e instanceof ListenCancelled) {
      useStudio.getState().set({ lyricsSync: null });
      return;
    }
    console.warn('[hum] listening failed', e);
    note = `Couldn’t listen to the song (${e instanceof Error ? e.message : 'unknown error'}).`;
  } finally {
    autoRunning = false;
  }
  // too little to go on: keep the timing it had, or spread the lines evenly to tap into place
  if (guide && (!lines.length || matched < 0.1)) lines = guide;
  else if (!lines.length) lines = spreadLyrics(text, buf.duration);
  if (!lines.length) {
    useStudio.getState().set({ lyricsSync: null });
    if (!opts.auto) useStudio.getState().flash('There were no lines to sync');
    return;
  }
  // on its own and no better than before: leave the lyrics as they were, with a word on why
  if (opts.auto && lines === guide) {
    useStudio.getState().set({ lyricsSync: null, lyricsNote: note });
    return;
  }
  const lyrics: Lyrics = { ...base, lines };
  // synced on its own: these timings count as tried, so it doesn't listen to the same lyrics again
  if (opts.auto) autoTried.add(lyrics);
  useStudio.getState().set({ lyrics, lyricsStatus: 'found', lyricsSync: null, lyricsMatched: lines !== guide && lines.some((l) => l.words) ? matched : null, lyricsNote: note });
  saveLyrics(opts.auto);
  if (opts.auto) {
    if (!note) useStudio.getState().flash('Lyrics synced to the singing');
    return;
  }
  useStudio.getState().flash(note ? (guide ? 'Kept the timing it had' : 'Lyrics added. The timing needs a few taps') : 'Lyrics synced to the singing');
}

/** stop a sync under way (Stop in the lyrics chip); the lyrics stay as they were */
export function stopSyncing() {
  cancelListening();
}

/* ───────────────────────── syncing on its own ───────────────────────── */

/** lyrics already considered for the automatic sync (each set of lyrics is tried once) */
const autoTried = new WeakSet<Lyrics>();
/** the lyrics moved onto this file by the shape of the vocals alone (a rough guess listening improves) */
let retimed: Lyrics | null = null;
/** the sync under way started on its own (turning the setting off stops it) */
let autoRunning = false;

/**
 * Can this device listen to a song on its own? Computers yes. Phones and tablets keep the button:
 * the model is a ~95 MB download and listening is slow there. Data saver and very little memory too.
 */
export function canAutoSync(): boolean {
  if (typeof navigator === 'undefined' || typeof Worker === 'undefined' || typeof OfflineAudioContext === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(nav.userAgent)) return false;
  // iPadOS reports itself as a Mac: a touch screen gives it away
  if (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  if (nav.connection?.saveData || /2g$/.test(nav.connection?.effectiveType ?? '')) return false;
  return true;
}

/**
 * Would listening make these lyrics better? Words with no timing: yes. Lines timed but not word by
 * word (most of LRCLIB): yes, listening gives each word its moment (Big words, Collage and Auto reveal
 * words as they're sung) and pulls lines onto the singing. Lyrics already timed word by word (by hand,
 * on LRCLIB or in the file): no, those are better than what Whisper hears, unless they were made for
 * another length of the song and only moved here by the shape of the vocals. Your own pasted lyrics:
 * you sync those yourself.
 */
function worthSyncing(l: Lyrics): boolean {
  if (l.instrumental || l.source === 'pasted') return false;
  if (!l.synced) return !!l.plain?.trim();
  if (!l.lines.length) return false;
  if (l === retimed) return true;
  const worded = l.lines.filter((x) => x.words?.length).length / l.lines.length;
  return worded < 0.8;
}

/** resolves once `ok` holds (or the song changes) */
function until(token: number, ok: (s: ReturnType<typeof useStudio.getState>) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ok(useStudio.getState())) return resolve();
    const off = useStudio.subscribe((s) => {
      if (token !== loadToken || ok(s)) {
        off();
        resolve();
      }
    });
  });
}

/**
 * After a song's lyrics are found: sync them to the singing on their own when that helps and the
 * device can (the setting is on by default). It waits for the song's analysis (that picks the look,
 * and listening would slow it down) and for any render or recording to finish (they need every frame).
 * Saved lyrics never get here: they're your own timing, or were synced already.
 */
async function autoSync(token = loadToken) {
  const st = useStudio.getState();
  const l = st.lyrics;
  if (!st.lyricsAutoSync || !l || !lastBuf || autoTried.has(l) || !canAutoSync() || !worthSyncing(l)) return;
  autoTried.add(l);
  await until(token, (s) => !!s.analysis && !s.clip && !s.lyricsSync);
  if (token !== loadToken) return;
  const now = useStudio.getState();
  if (!now.lyricsAutoSync || now.lyrics !== l) return;
  const words = l.lines.length ? l.lines.map((x) => x.text).join('\n') : (l.plain ?? '');
  if (!words.trim()) return;
  await syncPastedLyrics(words, { source: l.source, title: l.title, artist: l.artist }, { auto: true });
}

/** the setting was switched: on syncs the current song now (if it helps), off stops a sync it started */
export function setLyricsAutoSync(on: boolean) {
  useStudio.getState().set({ lyricsAutoSync: on });
  const l = useStudio.getState().lyrics;
  if (l) autoTried.delete(l);
  if (on) void autoSync();
  else if (autoRunning) cancelListening();
}

/** Whisper's language for the lyrics' script (it assumes English otherwise); undefined lets it be */
function guessLanguage(text: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(text)) return 'japanese';
  if (/[\uac00-\ud7af]/.test(text)) return 'korean';
  if (/[\u4e00-\u9fff]/.test(text)) return 'chinese';
  if (/[\u0400-\u04ff]/.test(text)) return 'russian';
  if (/[\u0600-\u06ff]/.test(text)) return 'arabic';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'thai';
  if (/[\u0590-\u05ff]/.test(text)) return 'hebrew';
  if (/[ñ¿¡]/i.test(text)) return 'spanish';
  return undefined;
}

/** the words heard in the loaded song, once it has been listened to (and the language listened for) */
let lastHeard: HeardWord[] | null = null;
let lastHeardLang: string | undefined;

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * Lyrics timed for another release of the song (refDuration long) moved onto this file: by the
 * heard words if the song has been listened to, otherwise by the shape of the vocals.
 */
async function retimeToFile(l: Lyrics, refDuration: number): Promise<{ lyrics: Lyrics; note: string }> {
  const buf = lastBuf;
  if (!buf || !l.lines.length) return { lyrics: l, note: '' };
  const dur = buf.duration;
  const diff = dur - refDuration;
  const longer = `Timed for a ${fmtLen(refDuration)} version (this file is ${fmtLen(Math.abs(diff))} ${diff > 0 ? 'longer' : 'shorter'})`;
  if (lastHeard?.length) {
    const res = alignLyrics(l.lines.map((x) => x.text).join('\n'), lastHeard, dur, { prior: l.lines });
    if (res.matched >= 0.15) return { lyrics: { ...l, lines: res.lines }, note: `${longer}; lined up with this file by listening.` };
  }
  try {
    // lengths on LRCLIB aren't always the song's (some uploads add silence), so look a bit wider
    const lo = Math.min(0, diff) - 12;
    const hi = Math.max(0, diff) + 12;
    const off = await offsetByVocals(buf, l.lines, lo, hi);
    const lines = l.lines
      .map((x) => {
        const c = { ...x, words: x.words?.map((w) => ({ ...w })) };
        shift(c, off);
        return c;
      })
      .filter((x) => x.end > 0 && x.t < dur);
    const sign = off >= 0 ? '+' : '−';
    const moved: Lyrics = { ...l, lines };
    retimed = moved;
    return { lyrics: moved, note: `${longer}; moved ${sign}${Math.abs(off).toFixed(1)} s to match the singing.${canAutoSync() && useStudio.getState().lyricsAutoSync ? '' : ' Sync by listening for exact timing.'}` };
  } catch (e) {
    console.warn('[hum] retime failed', e);
    retimed = l;
    return { lyrics: l, note: `${longer}; the timing may be off. Sync by listening to fix it.` };
  }
}

/** use a record picked from the search box (re-timed to this file when its length differs) */
export async function applyLrclibRecord(r: LrclibRecord) {
  const buf = lastBuf;
  if (!buf) return;
  const token = loadToken;
  let l = toLyrics(r, buf.duration);
  const who = `${r.artistName} — ${r.trackName}`;
  if (l.instrumental) {
    useStudio.getState().set({ lyrics: null, lyricsStatus: 'instrumental', lyricsNote: who, lyricsMatched: null });
    return;
  }
  if (!l.synced) {
    useStudio.getState().set({ lyrics: l, lyricsStatus: 'plain', lyricsNote: who, lyricsMatched: null });
    void autoSync(token);
    return;
  }
  let note = '';
  if (Math.abs(r.duration - buf.duration) > 2) {
    const fixed = await retimeToFile(l, r.duration);
    if (token !== loadToken) return;
    l = fixed.lyrics;
    note = fixed.note;
  }
  useStudio.getState().set({ lyrics: l, lyricsStatus: 'found', lyricsNote: note, lyricsMatched: null });
  saveLyrics();
  useStudio.getState().flash(`Using lyrics for “${who}”`);
  void autoSync(token);
}

/** move every line by dt seconds (the offset slider) */
export function shiftAllLyrics(dt: number) {
  const l = useStudio.getState().lyrics;
  if (!l?.lines.length || !dt) return;
  const lines = l.lines.map((x) => ({ ...x, words: x.words?.map((w) => ({ ...w })) }));
  lines.forEach((x) => shift(x, dt));
  useStudio.getState().set({ lyrics: { ...l, lines } });
}

/** tap: line i starts now; it and every later line move by the same amount */
export function tapLine(i: number, now: number) {
  const l = useStudio.getState().lyrics;
  if (!l || i < 0 || i >= l.lines.length) return;
  const dt = now - l.lines[i].t;
  const lines = l.lines.map((x, k) => {
    if (k < i) return x;
    const c = { ...x, words: x.words?.map((w) => ({ ...w })) };
    shift(c, dt);
    return c;
  });
  // the line before ends where this one now starts
  if (i > 0) lines[i - 1] = { ...lines[i - 1], end: Math.max(lines[i - 1].t + 0.3, Math.min(lines[i - 1].end, now)) };
  useStudio.getState().set({ lyrics: { ...l, lines } });
}

/* ───────────────────────── saved per song ───────────────────────── */

const SAVE_KEY = 'hum.lyrics';
const MAX_SAVED = 30;
/** `auto`: synced on its own, not touched by hand (the first to go when the list is full) */
type SavedEntry = { at: number; lyrics: Lyrics; auto?: boolean; matched?: number | null };
type SavedMap = Record<string, SavedEntry>;

const songKey = (name: string, duration: number) => `${name}|${Math.round(duration)}`;

function readSaved(): SavedMap {
  try {
    const j = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function loadSaved(name: string, duration: number): SavedEntry | null {
  const e = readSaved()[songKey(name, duration)];
  return e?.lyrics?.lines?.length ? e : null;
}

/** are there saved lyrics for the loaded song? */
export function hasSavedLyrics() {
  return !!(lastFile && lastBuf && readSaved()[songKey(lastFile.name, lastBuf.duration)]);
}

/**
 * Remember the current lyrics (pasted, synced, tapped or shifted) for the loaded song. Lyrics synced
 * on its own are saved too (so the song isn't listened to again), but give way first when the list
 * is full: your own fixes are kept longest.
 */
export function saveLyrics(auto = false) {
  const { lyrics, lyricsMatched } = useStudio.getState();
  if (!lastFile || !lastBuf || !lyrics?.lines.length) return;
  try {
    const all = readSaved();
    all[songKey(lastFile.name, lastBuf.duration)] = { at: Date.now(), lyrics, matched: lyricsMatched, ...(auto ? { auto: true } : {}) };
    const keep = Object.entries(all)
      .sort((a, b) => Number(!!a[1].auto) - Number(!!b[1].auto) || b[1].at - a[1].at)
      .slice(0, MAX_SAVED);
    localStorage.setItem(SAVE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* storage full or unavailable */
  }
}

/** forget this song's saved lyrics and look them up again */
export function forgetSavedLyrics() {
  if (!lastFile || !lastBuf) return;
  try {
    const all = readSaved();
    delete all[songKey(lastFile.name, lastBuf.duration)];
    localStorage.setItem(SAVE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  void lookUpLyrics(lastFile.blob, lastFile.name, lastBuf.duration);
}

export async function loadDemo(id: string) {
  const d = DEMO_TRACKS.find((t) => t.id === id);
  if (!d) return;
  // still inside the tap that picked it: let the song start on its own once it's planned
  audioEngine.unlock();
  let blob = demoCache.get(id);
  if (!blob) {
    blob = d.render();
    demoCache.set(id, blob);
  }
  await loadTrack(blob, { name: d.name, source: 'demo', id });
}

/**
 * On start-up: bring back the clips and the song from last time (saved.ts), so a reload doesn't lose
 * them. The song is analysed again and gets its saved video, or one planned on this computer: a
 * reload never asks Claude for anything. The page was not tapped, so the song waits for one tap to play.
 */
export async function restoreSession() {
  const clips = await recallClips();
  if (clips.length && !useStudio.getState().clips.length) useStudio.getState().addClips(clips);
  keepClipsSaved();
  // photos too, each under the id it had, so a part that picked one still finds it
  const saved = await recallPhotos();
  if (saved.length && !useStudio.getState().photos.length) {
    const photos = (await Promise.all(saved.map(({ id, file }) => loadPhoto(file).then((p) => ({ ...p, id }), () => null)))).filter((p) => p !== null);
    if (photos.length) useStudio.getState().addPhotos(photos);
  }
  keepPhotosSaved();
  // and the drawings, where they are allowed
  startDrawings();
  const song = await recallSong();
  // something was opened while we were looking: that wins
  if (!song || useStudio.getState().track) return keepPlanSaved();
  if (song.source === 'demo') {
    const d = DEMO_TRACKS.find((t) => t.id === song.id);
    if (!d) return;
    let blob = demoCache.get(d.id);
    if (!blob) demoCache.set(d.id, (blob = d.render()));
    await loadTrack(blob, { name: d.name, source: 'demo', id: d.id }, { restored: true });
  } else if (song.blob) {
    await loadTrack(song.blob, { name: song.name, source: 'file' }, { restored: true });
  }
  // only now: the saved video has been read (or passed over), so a newer one may take its place
  keepPlanSaved();
}

export async function useMic() {
  try {
    await audioEngine.startMic();
    cancelListening();
    loadToken++;
    songBuf = null;
    lastBuf = null;
    lastFile = null;
    endStartup();
    void forgetSong();
    useStudio.getState().set({ track: { name: 'Microphone', source: 'mic' }, needsTap: false, analysis: null, analyzing: false, plan: null, partPops: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsSync: null, lyricsMatched: null, tapSync: false });
  } catch {
    useStudio.getState().flash('Microphone permission was denied');
  }
}

/** can this browser listen to another tab? (desktop Chrome / Edge) */
export const canListenToTab = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && !/iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);

/**
 * Listen to a song playing in another tab, e.g. a YouTube video: the browser asks which tab to
 * share. Live like the microphone (no full-song breakdown or video plan), but the sound is clean.
 */
export async function useTab() {
  const flash = useStudio.getState().flash;
  if (!canListenToTab()) {
    flash('Listening to a tab works in Chrome or Edge on a computer. Here, download the song and drop the file in.');
    return;
  }
  try {
    await audioEngine.startTab(() => {
      const s = useStudio.getState();
      if (s.track?.name === 'Tab audio') s.set({ track: null });
      s.flash('Stopped listening to the tab');
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.message === 'no_audio') flash('No sound came through. Pick a Chrome tab and leave “Share tab audio” on.');
    else if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      /* the person cancelled the picker */
    } else flash('This browser can’t listen to another tab. Try Chrome or Edge.');
    return;
  }
  cancelListening();
  loadToken++;
  songBuf = null;
  lastBuf = null;
  lastFile = null;
  endStartup();
  void forgetSong();
  useStudio.getState().set({ track: { name: 'Tab audio', source: 'mic' }, needsTap: false, analysis: null, analyzing: false, plan: null, partPops: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsSync: null, lyricsMatched: null, tapSync: false });
  flash('Listening to the tab. Play the song there.');
}

/** load videos as footage clips; each failure is reported with its own message */
async function loadClips(videos: File[]) {
  const { flash, addClips } = useStudio.getState();
  const made = await Promise.all(
    videos.map((f) =>
      loadClip(f).catch((e) => {
        console.warn('[hum] clip failed', e);
        flash(e instanceof Error ? e.message : `Couldn’t open “${f.name}” as a video clip.`);
        return null;
      }),
    ),
  );
  const clips = made.filter((c) => c !== null);
  if (!clips.length) return;
  addClips(clips);
  // a video already planned without clips doesn't change by itself: say how to bring them in
  const st = useStudio.getState();
  const planned = !!st.plan && !st.plan.looks.some((id) => id?.startsWith('footage'));
  flash(`${clips.length} clip${clips.length > 1 ? 's' : ''} added. ${planned ? 'Press Remake video to use them.' : 'Try a Footage look.'}`);
}

/** videos picked in the Library: footage whether or not a song is loaded */
export async function addClipFiles(files: FileList | File[]) {
  const videos = Array.from(files).filter(looksLikeVideo);
  if (videos.length) await loadClips(videos);
}

export async function handleFiles(files: FileList | File[]) {
  // a drop is a gesture: use it to let the song start once it's planned (a picked file was unlocked by the tap that opened the picker)
  audioEngine.unlock();
  const list = Array.from(files);
  const images = list.filter((f) => f.type.startsWith('image/'));
  const videos = list.filter(looksLikeVideo);
  const audio = list.find((f) => !videos.includes(f) && (f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(f.name)));
  if (images.length) {
    const photos = (await Promise.all(images.map((f) => loadPhoto(f).catch(() => null)))).filter((p) => p !== null);
    if (photos.length) {
      useStudio.getState().addPhotos(photos);
      useStudio.getState().flash(`${photos.length} photo${photos.length > 1 ? 's' : ''} added — try a Photo scene`);
    }
  }
  // once there is a song (a file, a demo, or the microphone), or with an audio file in this drop,
  // every video is footage; with nothing playing yet the first video is the song (a music video)
  // and the rest are footage
  const song = audio ?? (useStudio.getState().track ? null : (videos[0] ?? null));
  const clipFiles = audio || song === null ? videos : videos.filter((f) => f !== song);
  // clips first: a song dropped with them is planned as soon as it's analysed, and should find them there
  if (clipFiles.length) await loadClips(clipFiles);
  if (audio) await loadTrack(audio, { name: audio.name.replace(/\.[^.]+$/, ''), source: 'file' });
  else if (song) {
    const name = song.name.replace(/\.[^.]+$/, '');
    await loadTrack(song, { name, source: 'file' });
    useStudio.getState().flash(`Playing “${name}” as the song. Drop a video again to use it as footage.`);
  }
}
