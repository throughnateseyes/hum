import { useEffect, useRef, useState } from 'react';
import { songCredit } from '../state/songName';
import { closeLyrics, openLyrics, useLyricsOpen, type LyricsMode } from './lyricsOpen';
import './songName.css';
import { audioEngine } from '../audio/engine';
import { isLrclibRef, lrclibById, searchLrclib, type LrclibRecord } from '../audio/lyrics';
import { LYRIC_FONTS, useStudio, type LyricStyle, type LyricsOnBoards, type LyricsSync } from '../state/store';
import { applyLrclibRecord, canAutoSync, canSyncLyrics, editLyrics, forgetSavedLyrics, hasSavedLyrics, retryLyrics, saveLyrics, setLyricsAutoSync, shiftAllLyrics, stopSyncing, syncPastedLyrics } from '../state/tracks';
import { LYRIC_FONT_NAME, previewFamily } from '../render/lyricFonts';
import { Slider, Toggle } from './controls';

const STYLES: { id: LyricStyle; label: string; tip: string }[] = [
  { id: 'auto', label: 'Auto', tip: 'Directs the words like a lyric video: each part of the song gets its own way of showing them' },
  { id: 'subtitle', label: 'Subtitles', tip: 'A quiet caption low in the picture' },
  { id: 'big', label: 'Big', tip: 'One line at a time, set large, each word revealed as it’s sung' },
  { id: 'cutout', label: 'Collage', tip: 'Each word on its own scrap of printed paper, laid down as it’s sung' },
  { id: 'off', label: 'Off', tip: 'No lyrics on the video' },
];

const ON_BOARDS: { id: LyricsOnBoards; label: string }[] = [
  { id: 'hide', label: 'Hide' },
  { id: 'show', label: 'Show' },
];

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function syncLabel(p: NonNullable<LyricsSync>) {
  const pct = `${Math.round(p.frac * 100)}%`;
  if (p.stage === 'download') return `Getting the listening model (first time only) · ${pct}`;
  if (p.stage === 'listening') return `Listening · ${pct}`;
  return 'Getting ready…';
}

/** the first words of a set of lyrics, to tell one from another by */
const opening = (text: string) =>
  text
    .split(/\r?\n/)
    .map((x) => x.replace(/\[[^\]]*\]|<[^>]*>/g, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' / ');

/**
 * Lyrics beside the track name. Lyrics are found on their own (the file's tags, then LRCLIB). The
 * panel keeps to what matters: sync by listening (the one main action), the style and the font.
 * Change swaps wrong lyrics for others (found again, pasted or corrected by hand); nudging and tap timing sit
 * under More.
 */
export function LyricsChip() {
  const status = useStudio((s) => s.lyricsStatus);
  const style = useStudio((s) => s.lyricStyle);
  const sync = useStudio((s) => s.lyricsSync);
  const open = useLyricsOpen((s) => s.open);
  const wide = useLyricsOpen((s) => s.mode !== 'main');
  const setOpen = (v: boolean) => (v ? openLyrics() : closeLyrics());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) closeLyrics();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  // (a song that went away while its lyrics were open)
  const none = status === 'idle' && !sync;
  useEffect(() => {
    if (none) closeLyrics();
  }, [none]);
  if (none) return null;

  const canListen = canSyncLyrics();
  const label = sync
    ? 'Syncing lyrics…'
    : status === 'searching'
      ? 'Finding lyrics…'
      : status === 'found'
        ? style === 'off'
          ? 'Lyrics hidden'
          : 'Lyrics'
        : status === 'plain'
          ? 'Lyrics (not timed)'
          : status === 'instrumental'
            ? 'Instrumental'
            : canListen
              ? 'Add lyrics'
              : 'No lyrics';

  return (
    <div className="lyr" ref={box}>
      <button className={`lyr-chip ${sync ? 'searching' : status}`} onClick={() => status !== 'searching' && setOpen(!open)}>
        {sync || status === 'searching' ? <span className="spin" /> : <i className="lyr-dot" />}
        {label}
      </button>
      {open && (
        <div className={`lyr-pop ${wide ? 'wide' : ''}`}>
          <LyricsBody onClose={closeLyrics} />
        </div>
      )}
    </div>
  );
}

/**
 * The phone's Lyrics panel (in the bottom sheet): the same as the chip's popover, laid out in the
 * sheet. `onClose` closes the sheet when an action moves on (tap timing, a search result picked).
 */
export function LyricsPanel({ onClose }: { onClose: () => void }) {
  const status = useStudio((s) => s.lyricsStatus);
  const sync = useStudio((s) => s.lyricsSync);
  const track = useStudio((s) => s.track);
  if (status === 'idle' && !sync)
    return (
      <p className="sheet-empty">
        {!track ? 'Load a song and Hum finds its lyrics on its own.' : track.source === 'file' ? 'Looking for this song’s lyrics…' : 'Demos and live sound have no lyrics.'}
      </p>
    );
  return (
    <div className="lyr-panel">
      <LyricsBody onClose={onClose} />
    </div>
  );
}

/** what the lyrics popover holds: the lyrics found, sync, style and font, and More */
function LyricsBody({ onClose }: { onClose: () => void }) {
  const status = useStudio((s) => s.lyricsStatus);
  const lyrics = useStudio((s) => s.lyrics);
  const note = useStudio((s) => s.lyricsNote);
  const style = useStudio((s) => s.lyricStyle);
  const font = useStudio((s) => s.lyricFont);
  const onBoards = useStudio((s) => s.lyricsOnBoards);
  const sync = useStudio((s) => s.lyricsSync);
  const matched = useStudio((s) => s.lyricsMatched);
  const query = useStudio((s) => s.lyricsQuery);
  const autoSync = useStudio((s) => s.lyricsAutoSync);
  const mode = useLyricsOpen((s) => s.mode);
  const own = useStudio((s) => s.songName);
  const credit = useStudio((s) => songCredit(s).title);
  const creditArtist = useStudio((s) => songCredit(s).artist);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setMode = (m: LyricsMode) => useLyricsOpen.setState({ mode: m });
  // the panel opens on its first view next time
  useEffect(() => () => useLyricsOpen.setState({ mode: 'main' }), []);
  const setOpen = (v: boolean) => {
    if (!v) onClose();
  };
  const canListen = canSyncLyrics();
  const who = lyrics ? [lyrics.artist, lyrics.title].filter(Boolean).join(' — ') : '';
  /** the words to listen for: the lines on screen, or the untimed words */
  const words = lyrics?.lines.length ? lyrics.lines.map((l) => l.text).join('\n') : (lyrics?.plain ?? '');
  const status1 =
    status === 'found'
      ? matched !== null
        ? 'Synced to the singing'
        : lyrics?.source === 'file'
          ? 'Timed lyrics from the file'
          : lyrics?.source === 'pasted'
            ? 'Your lyrics'
            : 'Timed lyrics from LRCLIB'
      : status === 'plain'
        ? 'Words found, not timed yet'
        : status === 'instrumental'
          ? 'No vocals in this one'
          : 'No lyrics found';
  const listen = () => {
    setOpen(false);
    if (lyrics && words) void syncPastedLyrics(words, { source: lyrics.source, title: lyrics.title, artist: lyrics.artist });
  };
  const startEdit = (from: string) => {
    setText(from);
    setMode('edit');
  };
  const same = !!lyrics?.lines.length && text.split(/\r?\n/).filter((x) => x.trim()).length === lyrics.lines.filter((x) => x.text.trim()).length;
  const changeOffset = (v: number) => {
    shiftAllLyrics(v - offset);
    setOffset(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveLyrics, 600);
  };

  return (
    <>
          {sync ? (
            <>
              <div className="lyr-h">Syncing to the singing</div>
              <div className="lyr-bar">
                <i style={{ width: `${Math.round(sync.frac * 100)}%` }} />
              </div>
              <p className="lyr-p">{syncLabel(sync)}</p>
              <p className="lyr-p">Hum listens on this computer; the song keeps playing. The lyrics show as they are until it’s done.</p>
              <button
                className="btn sm"
                onClick={() => {
                  setOpen(false);
                  stopSyncing();
                }}
              >
                Stop
              </button>
            </>
          ) : mode === 'change' ? (
            <>
              <LyricsSearch
                initial={{ artist: own?.artist || creditArtist || query.artist || '', title: own?.title || credit || query.title || '' }}
                now={lyrics ? opening(words) : ''}
                onBack={() => setMode('main')}
                onPicked={() => setOpen(false)}
              />
              <div className="lyr-others">
                {words && canListen && (
                  <button className="btn sm" onClick={() => startEdit(words)}>
                    Fix the words
                  </button>
                )}
                {canListen && (
                  <button className="btn sm" onClick={() => startEdit('')}>
                    Paste my own
                  </button>
                )}
                {hasSavedLyrics() && (
                  <button
                    className="btn sm ghost"
                    title="Drop the lyrics kept for this song and look again"
                    onClick={() => {
                      setMode('main');
                      forgetSavedLyrics();
                    }}
                  >
                    Start over
                  </button>
                )}
              </div>
            </>
          ) : mode === 'edit' ? (
            <>
              <button className="lyr-back" onClick={() => setMode('change')}>
                ← Back
              </button>
              <div className="lyr-h">{words ? 'Your lyrics' : 'Paste lyrics'}</div>
              <textarea className="txt lyr-paste" autoFocus placeholder={'One line per line, as it’s sung.'} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="lyr-row">
                <button
                  className="btn sm primary"
                  disabled={!text.trim()}
                  onClick={() => {
                    setOpen(false);
                    if (same) editLyrics(text);
                    else void syncPastedLyrics(text);
                  }}
                >
                  {same ? 'Save' : 'Sync by listening'}
                </button>
              </div>
              <p className="lyr-p">{same ? 'As many lines as before, so each keeps its time.' : 'Hum listens to the song to time these.'}</p>
            </>
          ) : (
            <>
              <div className="lyr-card">
                <div className="lyr-top">
                  {who && <div className="lyr-h">{who}</div>}
                  <div className="lyr-status">{status1}</div>
                  {words && <p className="lyr-lines">{opening(words)}</p>}
                </div>
                {(status === 'found' || status === 'plain' || status === 'instrumental') && (
                  <button className="btn sm lyr-change" title="These aren’t right: find others, paste your own or fix the words" onClick={() => setMode('change')}>
                    Change
                  </button>
                )}
              </div>

              {(status === 'found' || status === 'plain') && canListen && (
                <button className="btn primary lyr-main" onClick={listen} disabled={!words}>
                  Sync by listening
                </button>
              )}
              {status === 'none' && (
                <button className="btn primary lyr-main" onClick={() => setMode('change')}>
                  Find lyrics
                </button>
              )}

              {status === 'found' && (
                <>
                  <div className="lyr-field">
                    <span className="lyr-label">Style</span>
                    <div className="seg lyr-seg">
                      {STYLES.map((s) => (
                        <button key={s.id} className={style === s.id ? 'on' : ''} title={s.tip} onClick={() => useStudio.getState().set({ lyricStyle: s.id, lyricStylePicked: true })}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="lyr-field">
                    <span className="lyr-label">Font</span>
                    <div className="lyr-fonts" role="radiogroup" aria-label="Lyric font">
                      {LYRIC_FONTS.map((f) => (
                        <button
                          key={f}
                          role="radio"
                          aria-checked={font === f}
                          className={`lyr-font ${font === f ? 'on' : ''} ${f}`}
                          style={{ fontFamily: previewFamily(f) }}
                          title={f === 'auto' ? 'Follows the song (and the video plan)' : undefined}
                          onClick={() => useStudio.getState().set({ lyricFont: f })}
                        >
                          {LYRIC_FONT_NAME[f]}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {status !== 'instrumental' || canListen ? (
                <button className={`lyr-more-btn ${more ? 'open' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}>
                  More
                </button>
              ) : null}
              {more && (
                <div className="lyr-more">
                  {note && note !== who && <p className="lyr-p">{note}</p>}
                  {canAutoSync() && (
                    <label className="sw lyr-auto has-tip" data-tip="After a song loads, Hum times its lyrics to the singing by listening, unless they’re already timed word by word. The first time it downloads the listening model (about 95 MB).">
                      <Toggle on={autoSync} onChange={setLyricsAutoSync} label="Sync new songs by listening" />
                      Sync new songs by listening
                    </label>
                  )}
                  {status === 'found' && (
                    <div className="lyr-offset">
                      <div className="param-top">
                        <span className="param-name">Shift timing</span>
                        <span className="param-val">
                          {offset > 0 ? '+' : ''}
                          {offset.toFixed(1)} s
                        </span>
                      </div>
                      <Slider value={offset} min={-3} max={3} step={0.05} onChange={changeOffset} />
                    </div>
                  )}
                  <div className="lyr-row">
                    {status === 'found' && (
                      <button
                        className="btn sm"
                        onClick={() => {
                          setOpen(false);
                          useStudio.getState().set({ tapSync: true });
                        }}
                      >
                        Tap timing
                      </button>
                    )}
                    {status === 'none' && (
                      <button
                        className="btn sm"
                        onClick={() => {
                          setOpen(false);
                          retryLyrics();
                        }}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                  {status === 'found' && (style === 'big' || style === 'cutout' || style === 'auto') && (
                    <div className="lyr-field">
                      <span className="lyr-label">On looks that write the words</span>
                      <div className="seg lyr-seg">
                        {ON_BOARDS.map((o) => (
                          <button key={o.id} className={onBoards === o.id ? 'on' : ''} onClick={() => useStudio.getState().set({ lyricsOnBoards: o.id })}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
    </>
  );
}

/**
 * Lyrics to swap in: LRCLIB is asked at once for the song's own name, each result shows how it opens so the
 * right one can be told at a glance, and the one in use is marked. A lrclib.net link works in the Song field.
 */
function LyricsSearch({ initial, now, onBack, onPicked }: { initial: { artist: string; title: string }; now: string; onBack: () => void; onPicked: () => void }) {
  const [artist, setArtist] = useState(initial.artist);
  const [title, setTitle] = useState(initial.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<LrclibRecord[] | null>(null);
  const duration = audioEngine.frame.duration || 0;

  const pick = async (r: LrclibRecord) => {
    setBusy(true);
    await applyLrclibRecord(r);
    setBusy(false);
    onPicked();
  };
  const run = async () => {
    setError('');
    setBusy(true);
    try {
      const ref = [title, artist].find(isLrclibRef);
      if (ref) {
        const r = await lrclibById(ref);
        if (!r) setError('Couldn’t find that LRCLIB entry.');
        else {
          await pick(r);
          return;
        }
      } else {
        const list = await searchLrclib(artist, title, duration);
        setResults(list);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t reach LRCLIB.');
    }
    setBusy(false);
  };

  // the search is made as the view opens, so the choices are there without typing
  const first = useRef(true);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    if (initial.artist.trim() || initial.title.trim()) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <button className="lyr-back" onClick={onBack}>
        ← Back
      </button>
      <div className="lyr-h">Which lyrics are right?</div>
      <form
        className="lyr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          <span>Artist</span>
          <input className="txt" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Porter Robinson" />
        </label>
        <label>
          <span>Song</span>
          <input className="txt" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song name, or a lrclib.net link" />
        </label>
        <div className="lyr-row">
          <button className="btn sm primary" type="submit" disabled={busy || (!artist.trim() && !title.trim())}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      {error && <p className="lyr-p lyr-err">{error}</p>}
      {results && (
        <div className="lyr-results">
          {results.length === 0 && <p className="lyr-p">Nothing found. Try fewer words, or just the song name.</p>}
          {results.map((r) => {
            const timed = !!(r.syncedLyrics || r.lyricsfile);
            const diff = duration ? r.duration - duration : 0;
            const start = opening(r.syncedLyrics || r.plainLyrics || '');
            const inUse = !!start && start === now;
            return (
              <button key={r.id} className={`lyr-res ${inUse ? 'now' : ''}`} disabled={busy} onClick={() => void pick(r)}>
                <b>
                  {r.artistName} — {r.trackName}
                </b>
                <span>
                  {[r.albumName, fmtLen(r.duration)].filter(Boolean).join(' · ')}
                  {Math.abs(diff) > 2 && <em> ({diff > 0 ? '+' : '−'}{fmtLen(Math.abs(diff))} vs this file)</em>}
                </span>
                {start && <span className="lyr-lines">{start}</span>}
                <i className={`lyr-tag ${r.instrumental ? 'inst' : timed ? 'timed' : 'words'}`}>{inUse ? 'in use' : r.instrumental ? 'instrumental' : timed ? 'timed' : 'words only'}</i>
              </button>
            );
          })}
        </div>
      )}
      <p className="lyr-p">Only the artist and song name go to LRCLIB.</p>
    </>
  );
}
