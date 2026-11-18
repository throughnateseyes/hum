import { audioEngine } from '../audio/engine';
import { analyzeTrack } from '../audio/analysis';
import { findLyrics, toLyrics, type LrclibRecord } from '../audio/lyrics';
import { alignLyrics, listenForWords, offsetByVocals, shift, spreadLyrics, type HeardWord } from '../audio/align';
import type { LyricLine, Lyrics } from '../core/types';
import { readTags } from '../audio/tags';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { PRESETS } from '../presets';
import { loadPhoto } from '../scenes/photo/loadPhoto';
import { useStudio, type TrackInfo } from './store';

const demoCache = new Map<string, Blob>();
let loadToken = 0;

/** Load audio, start playing, analyse it, then theme the stage from the analysis. */
export async function loadTrack(blob: Blob, info: TrackInfo, opts: { autoTheme?: boolean } = {}) {
  const token = ++loadToken;
  lastFile = info.source === 'file' ? { blob, name: info.name } : null;
  lastBuf = null;
  lastHeard = null;
  const st = useStudio.getState();
  st.set({ track: info, analysis: null, analyzing: true, plan: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsNote: '', lyricsSync: null, lyricsMatched: null, lyricsQuery: {}, tapSync: false });
  const ctx = audioEngine.ensureContext();
  try {
    await audioEngine.loadFile(blob, null);
    void audioEngine.play().catch(() => {});
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== loadToken) return;
    if (info.source === 'file') lastBuf = buf;
    // lyrics are looked up alongside the analysis (demo tracks are instrumental)
    if (info.source === 'file') void lookUpLyrics(blob, info.name, buf.duration, token);
    const analysis = await analyzeTrack(
      buf,
      [...PRESETS, ...useStudio.getState().customPresets].map((p) => ({ id: p.id, tags: p.tags })),
    );
    if (token !== loadToken) return;
    audioEngine.setAnalysis(analysis);
    useStudio.getState().set({ analysis, analyzing: false });
    if (opts.autoTheme !== false) {
      const pick = analysis.suggestedPresets.map((id) => PRESETS.find((p) => p.id === id)).find(Boolean);
      if (pick) {
        useStudio.getState().applyPreset(pick);
        useStudio.getState().flash(`Heard ${analysis.tags.slice(0, 3).join(', ')} · ${Math.round(analysis.bpm)} bpm → “${pick.name}”`);
      }
    }
  } catch (e) {
    console.error(e);
    if (token === loadToken) {
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
    useStudio.getState().set({ lyrics: saved, lyricsStatus: 'found', lyricsNote: 'Your saved lyrics for this song' });
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
    else if (l?.synced) useStudio.getState().set({ lyrics: l, lyricsStatus: 'found', lyricsNote: note });
    else if (l?.plain) useStudio.getState().set({ lyrics: l, lyricsStatus: 'plain', lyricsNote: what });
    else useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: `${res.reason ?? 'No lyrics found.'}${what ? ` Searched for “${what}”.` : ''}` });
  } catch (e) {
    console.warn('[hum] lyrics lookup failed', e);
    if (token === loadToken) useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: 'Lyrics lookup failed.' });
  }
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
 * Time pasted lyrics (or LRCLIB's untimed words) to the song by listening for the sung words on
 * this computer. Falls back to spreading the lines evenly, ready to be tapped into place.
 */
export async function syncPastedLyrics(text: string, keep: Partial<Pick<Lyrics, 'source' | 'title' | 'artist'>> = {}) {
  const buf = lastBuf;
  const st = useStudio.getState();
  if (!buf || !lastFile || st.lyricsSync) return;
  const token = loadToken;
  const prior = st.lyrics;
  const base: Omit<Lyrics, 'lines'> = { synced: true, source: 'pasted', plain: text, title: prior?.title, artist: prior?.artist, ...keep };
  st.set({ lyricsSync: { stage: 'prepare', frac: 0 }, lyricsMatched: null });
  let lines: LyricLine[] = [];
  let matched = 0;
  let note = '';
  try {
    const heard = await listenForWords(buf, (p) => token === loadToken && useStudio.getState().set({ lyricsSync: p }));
    if (token !== loadToken) return;
    lastHeard = heard;
    const res = alignLyrics(text, heard, buf.duration);
    lines = res.lines;
    matched = res.matched;
    if (matched < 0.25) note = 'Couldn’t hear many of the words, so the timing is rough. Use Fix timing to tap it into place.';
  } catch (e) {
    console.warn('[hum] listening failed', e);
    if (token !== loadToken) return;
    note = `Couldn’t listen to the song (${e instanceof Error ? e.message : 'unknown error'}). The lines are spread out evenly: use Fix timing to tap them into place.`;
  }
  if (!lines.length || matched < 0.25) {
    // too little to go on: keep any lines that did land, otherwise spread them evenly
    if (!lines.length) lines = spreadLyrics(text, buf.duration);
  }
  if (!lines.length) {
    useStudio.getState().set({ lyricsSync: null });
    useStudio.getState().flash('There were no lines to sync');
    return;
  }
  const lyrics: Lyrics = { ...base, lines };
  useStudio.getState().set({ lyrics, lyricsStatus: 'found', lyricsSync: null, lyricsMatched: lines.some((l) => l.words) ? matched : null, lyricsNote: note });
  saveLyrics();
  useStudio.getState().flash(note ? 'Lyrics added. The timing needs a few taps' : `Lyrics synced: matched ${Math.round(matched * 100)}% of the words`);
}

/** the words heard in the loaded song, once it has been listened to */
let lastHeard: HeardWord[] | null = null;

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
    const res = alignLyrics(l.lines.map((x) => x.text).join('\n'), lastHeard, dur);
    if (res.matched >= 0.25) return { lyrics: { ...l, lines: res.lines }, note: `${longer}; lined up with this file by listening.` };
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
    return { lyrics: { ...l, lines }, note: `${longer}; moved ${sign}${Math.abs(off).toFixed(1)} s to match where the singing is. For exact timing, use Re-time by listening.` };
  } catch (e) {
    console.warn('[hum] retime failed', e);
    return { lyrics: l, note: `${longer}; the timing may be off. Use Re-time by listening or Fix timing.` };
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
type SavedMap = Record<string, { at: number; lyrics: Lyrics }>;

const songKey = (name: string, duration: number) => `${name}|${Math.round(duration)}`;

function readSaved(): SavedMap {
  try {
    const j = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function loadSaved(name: string, duration: number): Lyrics | null {
  const e = readSaved()[songKey(name, duration)];
  return e?.lyrics?.lines?.length ? e.lyrics : null;
}

/** are there saved lyrics for the loaded song? */
export function hasSavedLyrics() {
  return !!(lastFile && lastBuf && readSaved()[songKey(lastFile.name, lastBuf.duration)]);
}

/** remember the current lyrics (pasted, synced, tapped or shifted) for the loaded song */
export function saveLyrics() {
  const lyrics = useStudio.getState().lyrics;
  if (!lastFile || !lastBuf || !lyrics?.lines.length) return;
  try {
    const all = readSaved();
    all[songKey(lastFile.name, lastBuf.duration)] = { at: Date.now(), lyrics };
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
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
  audioEngine.ensureContext();
  let blob = demoCache.get(id);
  if (!blob) {
    blob = d.render();
    demoCache.set(id, blob);
  }
  await loadTrack(blob, { name: d.name, source: 'demo', id });
}

export async function useMic() {
  try {
    await audioEngine.startMic();
    lastBuf = null;
    lastFile = null;
    useStudio.getState().set({ track: { name: 'Microphone', source: 'mic' }, analysis: null, analyzing: false, plan: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsSync: null, lyricsMatched: null, tapSync: false });
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
  lastBuf = null;
  lastFile = null;
  useStudio.getState().set({ track: { name: 'Tab audio', source: 'mic' }, analysis: null, analyzing: false, plan: null, planOn: false, lyrics: null, lyricsStatus: 'idle', lyricsSync: null, lyricsMatched: null, tapSync: false });
  flash('Listening to the tab. Play the song there.');
}

export async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  // music videos work too: the browser decodes their soundtrack
  const audio = list.find((f) => f.type.startsWith('audio/') || f.type.startsWith('video/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|m4v|mov|webm)$/i.test(f.name));
  const images = list.filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    const photos = (await Promise.all(images.map((f) => loadPhoto(f).catch(() => null)))).filter((p) => p !== null);
    if (photos.length) {
      useStudio.getState().addPhotos(photos);
      useStudio.getState().flash(`${photos.length} photo${photos.length > 1 ? 's' : ''} added — try a Photo scene`);
    }
  }
  if (audio) await loadTrack(audio, { name: audio.name.replace(/\.[^.]+$/, ''), source: 'file' });
}
