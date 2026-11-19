import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { isLrclibRef, lrclibById, searchLrclib, type LrclibRecord } from '../audio/lyrics';
import { LYRIC_FONTS, useStudio, type LyricStyle, type LyricsOnBoards, type LyricsSync } from '../state/store';
import { applyLrclibRecord, canSyncLyrics, forgetSavedLyrics, hasSavedLyrics, retryLyrics, saveLyrics, shiftAllLyrics, syncPastedLyrics } from '../state/tracks';
import { LYRIC_FONT_NAME, previewFamily } from '../render/lyricFonts';
import { Slider } from './controls';

const STYLES: { id: LyricStyle; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'subtitle', label: 'Subtitles' },
  { id: 'big', label: 'Big' },
  { id: 'cutout', label: 'Cutouts' },
  { id: 'off', label: 'Off' },
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

type Mode = 'main' | 'paste' | 'search';

/**
 * Lyrics beside the track name. Lyrics are found on their own (the file's tags, then LRCLIB). The
 * panel keeps to what matters: sync by listening (the one main action), the style and the font.
 * Searching, pasting, nudging and tap timing sit under More.
 */
export function LyricsChip() {
  const status = useStudio((s) => s.lyricsStatus);
  const lyrics = useStudio((s) => s.lyrics);
  const note = useStudio((s) => s.lyricsNote);
  const style = useStudio((s) => s.lyricStyle);
  const font = useStudio((s) => s.lyricFont);
  const onBoards = useStudio((s) => s.lyricsOnBoards);
  const sync = useStudio((s) => s.lyricsSync);
  const matched = useStudio((s) => s.lyricsMatched);
  const query = useStudio((s) => s.lyricsQuery);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('main');
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    if (!open) {
      setMode('main');
      setOffset(0);
    }
  }, [open]);

  if (status === 'idle' && !sync) return null;

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
  const startPaste = () => {
    setText(words);
    setMode('paste');
  };
  const changeOffset = (v: number) => {
    shiftAllLyrics(v - offset);
    setOffset(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveLyrics, 600);
  };

  return (
    <div className="lyr" ref={box}>
      <button className={`lyr-chip ${sync ? 'searching' : status}`} onClick={() => status !== 'searching' && setOpen(!open)}>
        {sync || status === 'searching' ? <span className="spin" /> : <i className="lyr-dot" />}
        {label}
      </button>
      {open && (
        <div className={`lyr-pop ${mode === 'search' ? 'wide' : ''}`}>
          {sync ? (
            <>
              <div className="lyr-h">Syncing to the singing</div>
              <div className="lyr-bar">
                <i style={{ width: `${Math.round(sync.frac * 100)}%` }} />
              </div>
              <p className="lyr-p">{syncLabel(sync)}</p>
            </>
          ) : mode === 'search' ? (
            <LyricsSearch
              initial={{ artist: lyrics?.artist ?? query.artist ?? '', title: lyrics?.title ?? query.title ?? '' }}
              onBack={() => setMode('main')}
              onPicked={() => setOpen(false)}
            />
          ) : mode === 'paste' ? (
            <>
              <div className="lyr-h">Paste lyrics</div>
              <textarea className="txt lyr-paste" autoFocus placeholder={'One line per line, as it’s sung.'} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="lyr-row">
                <button
                  className="btn sm primary"
                  disabled={!text.trim()}
                  onClick={() => {
                    setMode('main');
                    setOpen(false);
                    void syncPastedLyrics(text);
                  }}
                >
                  Sync by listening
                </button>
                <button className="btn sm ghost" onClick={() => setMode('main')}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="lyr-top">
                {who && <div className="lyr-h">{who}</div>}
                <div className="lyr-status">{status1}</div>
              </div>

              {(status === 'found' || status === 'plain') && canListen && (
                <button className="btn primary lyr-main" onClick={listen} disabled={!words}>
                  Sync by listening
                </button>
              )}
              {status === 'none' && (
                <button className="btn primary lyr-main" onClick={() => setMode('search')}>
                  Find lyrics
                </button>
              )}

              {status === 'found' && (
                <>
                  <div className="lyr-field">
                    <span className="lyr-label">Style</span>
                    <div className="seg lyr-seg">
                      {STYLES.map((s) => (
                        <button key={s.id} className={style === s.id ? 'on' : ''} onClick={() => useStudio.getState().set({ lyricStyle: s.id, lyricStylePicked: true })}>
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
                    <button className="btn sm" onClick={() => setMode('search')}>
                      Search
                    </button>
                    {canListen && (
                      <button className="btn sm" onClick={startPaste}>
                        Paste
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
                  {(status === 'found' || status === 'plain') &&
                    (hasSavedLyrics() ? (
                      <button
                        className="btn sm ghost lyr-wrong"
                        onClick={() => {
                          setOpen(false);
                          forgetSavedLyrics();
                        }}
                      >
                        Forget my lyrics for this song
                      </button>
                    ) : (
                      lyrics?.source !== 'pasted' && (
                        <button
                          className="btn sm ghost lyr-wrong"
                          onClick={() => {
                            useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: `Hidden: these were for “${who}”.`, lyricsMatched: null });
                            setMode('search');
                          }}
                        >
                          Wrong song?
                        </button>
                      )
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Artist + Song fields that search LRCLIB, or a lrclib.net link; click a result to use it */
function LyricsSearch({ initial, onBack, onPicked }: { initial: { artist: string; title: string }; onBack: () => void; onPicked: () => void }) {
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

  return (
    <>
      <div className="lyr-h">Search lyrics</div>
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
          <input className="txt" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song name, or a lrclib.net link" />
        </label>
        <div className="lyr-row">
          <button className="btn sm primary" type="submit" disabled={busy || (!artist.trim() && !title.trim())}>
            {busy ? 'Searching…' : 'Search'}
          </button>
          <button className="btn sm ghost" type="button" onClick={onBack}>
            Back
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
            return (
              <button key={r.id} className="lyr-res" disabled={busy} onClick={() => void pick(r)}>
                <b>
                  {r.artistName} — {r.trackName}
                </b>
                <span>
                  {[r.albumName, fmtLen(r.duration)].filter(Boolean).join(' · ')}
                  {Math.abs(diff) > 2 && <em> ({diff > 0 ? '+' : '−'}{fmtLen(Math.abs(diff))} vs this file)</em>}
                </span>
                <i className={`lyr-tag ${r.instrumental ? 'inst' : timed ? 'timed' : 'words'}`}>{r.instrumental ? 'instrumental' : timed ? 'timed' : 'words only'}</i>
              </button>
            );
          })}
        </div>
      )}
      <p className="lyr-p">Only the artist and song name go to LRCLIB.</p>
    </>
  );
}
