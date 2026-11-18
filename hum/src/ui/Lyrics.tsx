import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { isLrclibRef, lrclibById, searchLrclib, type LrclibRecord } from '../audio/lyrics';
import { useStudio, type LyricStyle, type LyricsOnBoards, type LyricsSync } from '../state/store';
import { getScene } from '../scenes';
import { treatmentFor } from '../render/lyricAuto';
import { applyLrclibRecord, canSyncLyrics, forgetSavedLyrics, hasSavedLyrics, retryLyrics, saveLyrics, shiftAllLyrics, syncPastedLyrics } from '../state/tracks';
import { Slider } from './controls';

const STYLES: { id: LyricStyle; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'subtitle', label: 'Subtitles' },
  { id: 'big', label: 'Big words' },
  { id: 'cutout', label: 'Cutouts' },
  { id: 'off', label: 'Off' },
];

const ON_BOARDS: { id: LyricsOnBoards; label: string }[] = [
  { id: 'hide', label: 'Hide big lyrics' },
  { id: 'show', label: 'Show anyway' },
];

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function syncLabel(p: NonNullable<LyricsSync>) {
  const pct = `${Math.round(p.frac * 100)}%`;
  if (p.stage === 'download') return `Getting the listening model, first time only · ${pct}`;
  if (p.stage === 'listening') return `Listening for the words · ${pct}`;
  return 'Getting the song ready…';
}

type Mode = 'main' | 'paste' | 'search';

/**
 * Lyrics status beside the track name. Lyrics are found on their own (from the file's tags and
 * LRCLIB); this shows what happened and how they're displayed, lets you search LRCLIB yourself,
 * and lets you paste your own, which are timed by listening to the song on this computer.
 */
export function LyricsChip() {
  const status = useStudio((s) => s.lyricsStatus);
  const lyrics = useStudio((s) => s.lyrics);
  const note = useStudio((s) => s.lyricsNote);
  const style = useStudio((s) => s.lyricStyle);
  const onBoards = useStudio((s) => s.lyricsOnBoards);
  const lookShowsWords = useStudio((s) => !!getScene(s.sceneId)?.showsLyrics);
  const analysis = useStudio((s) => s.analysis);
  const sync = useStudio((s) => s.lyricsSync);
  const matched = useStudio((s) => s.lyricsMatched);
  const query = useStudio((s) => s.lyricsQuery);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('main');
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

  const canPaste = canSyncLyrics();
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
            : canPaste
              ? 'Add lyrics'
              : 'No lyrics';
  const source = lyrics?.source === 'file' ? 'from the file' : lyrics?.source === 'pasted' ? 'you pasted' : 'from LRCLIB';
  const who = lyrics ? [lyrics.artist, lyrics.title].filter(Boolean).join(' — ') : '';
  const searched = [query.artist, query.title].filter(Boolean).join(' — ');
  const startPaste = () => {
    setText(lyrics?.plain ?? (lyrics?.lines.length ? lyrics.lines.map((l) => l.text).join('\n') : ''));
    setMode('paste');
  };
  const changeOffset = (v: number) => {
    shiftAllLyrics(v - offset);
    setOffset(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveLyrics, 600);
  };
  /** Search / Paste: reachable from every state */
  const more = (
    <div className="lyr-row lyr-more">
      <button className="btn sm ghost" onClick={() => setMode('search')}>
        Search LRCLIB
      </button>
      {canPaste && (
        <button className="btn sm ghost" onClick={startPaste}>
          {lyrics ? 'Paste different lyrics' : 'Paste lyrics'}
        </button>
      )}
    </div>
  );

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
              <div className="lyr-h">Syncing the lyrics to the song</div>
              <div className="lyr-bar">
                <i style={{ width: `${Math.round(sync.frac * 100)}%` }} />
              </div>
              <p className="lyr-p">{syncLabel(sync)}</p>
              <p className="lyr-p">Hum is listening for the sung words on this computer. The audio never leaves it.</p>
            </>
          ) : mode === 'search' ? (
            <LyricsSearch
              initial={{ artist: lyrics?.artist ?? query.artist ?? '', title: lyrics?.title ?? query.title ?? '' }}
              onBack={() => setMode('main')}
              onPicked={() => setOpen(false)}
            />
          ) : mode === 'paste' ? (
            <>
              <div className="lyr-h">Paste the lyrics</div>
              <textarea className="txt lyr-paste" autoFocus placeholder={'One line per line, as it’s sung.\n[Chorus] labels are fine.'} value={text} onChange={(e) => setText(e.target.value)} />
              <p className="lyr-p">Hum listens to the song on this computer to time each line. The first time it downloads a listening model (about 95 MB); the audio never leaves your machine.</p>
              <div className="lyr-row">
                <button
                  className="btn sm primary"
                  disabled={!text.trim()}
                  onClick={() => {
                    setMode('main');
                    void syncPastedLyrics(text);
                  }}
                >
                  Sync to song
                </button>
                <button className="btn sm ghost" onClick={() => setMode('main')}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {status === 'found' && (
                <>
                  <div className="lyr-h">
                    {lyrics?.source === 'pasted' ? 'Lyrics you pasted' : `Timed lyrics ${source}`}
                    {lyrics?.lines.some((l) => l.words?.length) && lyrics.source !== 'pasted' ? ', word by word' : ''}
                  </div>
                  {who && <div className="lyr-who">{who}</div>}
                  {matched !== null && <p className="lyr-p">Timed by listening: matched {Math.round(matched * 100)}% of the words.</p>}
                  {note && note !== who && <p className="lyr-p">{note}</p>}
                  <div className="seg lyr-seg">
                    {STYLES.map((s) => (
                      <button key={s.id} className={style === s.id ? 'on' : ''} onClick={() => useStudio.getState().set({ lyricStyle: s.id, lyricStylePicked: true })}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {style === 'auto' && (
                    <p className="lyr-p">
                      Reads the song as {treatmentFor(analysis).label}. Held and louder words get bigger; drops hit hardest.
                    </p>
                  )}
                  {(style === 'big' || style === 'cutout' || style === 'auto') && (
                    <div className="lyr-boards">
                      <span className="param-name">On looks that show the words themselves</span>
                      <div className="seg lyr-seg">
                        {ON_BOARDS.map((o) => (
                          <button key={o.id} className={onBoards === o.id ? 'on' : ''} onClick={() => useStudio.getState().set({ lyricsOnBoards: o.id })}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                      {lookShowsWords && onBoards === 'hide' && <p className="lyr-p">Hidden on this look: it already types the words out.</p>}
                    </div>
                  )}
                  <div className="lyr-offset">
                    <div className="param-top">
                      <span className="param-name">Shift all lines</span>
                      <span className="param-val">
                        {offset > 0 ? '+' : ''}
                        {offset.toFixed(1)} s
                      </span>
                    </div>
                    <Slider value={offset} min={-3} max={3} step={0.05} onChange={changeOffset} />
                  </div>
                  <div className="lyr-row">
                    <button
                      className="btn sm"
                      onClick={() => {
                        setOpen(false);
                        useStudio.getState().set({ tapSync: true });
                      }}
                    >
                      Fix timing
                    </button>
                    {canPaste && lyrics && lyrics.source !== 'pasted' && (
                      <button
                        className="btn sm"
                        title="Listen to this file and line these lyrics up with it"
                        onClick={() => {
                          setOpen(false);
                          void syncPastedLyrics(lyrics.lines.map((l) => l.text).join('\n'), { source: lyrics.source, title: lyrics.title, artist: lyrics.artist });
                        }}
                      >
                        Re-time by listening
                      </button>
                    )}
                  </div>
                  {searched && lyrics?.source !== 'pasted' && <p className="lyr-p">Searched for “{searched}”.</p>}
                </>
              )}
              {status === 'plain' && (
                <>
                  <div className="lyr-h">Words found {source}, without timing</div>
                  {who && <div className="lyr-who">{who}</div>}
                  {canPaste ? (
                    <>
                      <p className="lyr-p">Hum can time them by listening to the song on this computer.</p>
                      <div className="lyr-row">
                        <button
                          className="btn sm primary"
                          onClick={() => {
                            setOpen(false);
                            if (lyrics?.plain) void syncPastedLyrics(lyrics.plain, { source: lyrics.source, title: lyrics.title, artist: lyrics.artist });
                          }}
                        >
                          Sync these
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="lyr-p">The video planner still reads them.</p>
                  )}
                </>
              )}
              {status === 'instrumental' && (
                <>
                  <div className="lyr-h">This one has no vocals</div>
                  {note && <div className="lyr-who">{note}</div>}
                </>
              )}
              {status === 'none' && (
                <>
                  <div className="lyr-h">No lyrics found</div>
                  {note && <p className="lyr-p">{note}</p>}
                  <p className="lyr-p">Search LRCLIB with a different artist or song name, or paste the lyrics and Hum will time them by listening.</p>
                  <div className="lyr-row">
                    <button className="btn sm primary" onClick={() => setMode('search')}>
                      Search LRCLIB
                    </button>
                    {canPaste && (
                      <button className="btn sm" onClick={startPaste}>
                        Paste lyrics
                      </button>
                    )}
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        setOpen(false);
                        retryLyrics();
                      }}
                    >
                      Try again
                    </button>
                  </div>
                </>
              )}
              {status !== 'none' && more}
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
                      Wrong song? Search for the right one
                    </button>
                  )
                ))}
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
      <div className="lyr-h">Search LRCLIB</div>
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
      <p className="lyr-p">Only the artist and song name you type are sent to LRCLIB, a free lyrics library.</p>
    </>
  );
}
