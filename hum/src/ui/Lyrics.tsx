import { useEffect, useRef, useState } from 'react';
import { useStudio, type LyricStyle } from '../state/store';
import { retryLyrics } from '../state/tracks';

const STYLES: { id: LyricStyle; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'subtitle', label: 'Subtitles' },
  { id: 'big', label: 'Big words' },
];

/**
 * Lyrics status beside the track name. Lyrics are found on their own (from the file's tags and
 * LRCLIB); this only shows what happened and how they're displayed.
 */
export function LyricsChip() {
  const status = useStudio((s) => s.lyricsStatus);
  const lyrics = useStudio((s) => s.lyrics);
  const note = useStudio((s) => s.lyricsNote);
  const style = useStudio((s) => s.lyricStyle);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  if (status === 'idle') return null;

  const label =
    status === 'searching'
      ? 'Finding lyrics…'
      : status === 'found'
        ? style === 'off'
          ? 'Lyrics hidden'
          : 'Lyrics'
        : status === 'plain'
          ? 'Lyrics (not timed)'
          : status === 'instrumental'
            ? 'Instrumental'
            : 'No lyrics';
  const source = lyrics?.source === 'file' ? 'from the file' : 'from LRCLIB';
  const who = lyrics ? [lyrics.artist, lyrics.title].filter(Boolean).join(' — ') : note;

  return (
    <div className="lyr" ref={box}>
      <button className={`lyr-chip ${status}`} onClick={() => status !== 'searching' && setOpen(!open)}>
        {status === 'searching' ? <span className="spin" /> : <i className="lyr-dot" />}
        {label}
      </button>
      {open && (
        <div className="lyr-pop">
          {status === 'found' && (
            <>
              <div className="lyr-h">
                Timed lyrics {source}
                {lyrics?.lines.some((l) => l.words?.length) ? ', word by word' : ''}
              </div>
              {who && <div className="lyr-who">{who}</div>}
              <div className="seg lyr-seg">
                {STYLES.map((s) => (
                  <button key={s.id} className={style === s.id ? 'on' : ''} onClick={() => useStudio.getState().set({ lyricStyle: s.id })}>
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="lyr-p">They also go to the video planner, so each part’s look can follow what’s being sung.</p>
            </>
          )}
          {status === 'plain' && (
            <>
              <div className="lyr-h">Words found {source}, without timing</div>
              {who && <div className="lyr-who">{who}</div>}
              <p className="lyr-p">They can’t be shown in time yet, but the video planner still reads them.</p>
            </>
          )}
          {status === 'instrumental' && (
            <>
              <div className="lyr-h">This one has no vocals</div>
              {who && <div className="lyr-who">{who}</div>}
            </>
          )}
          {status === 'none' && (
            <>
              <div className="lyr-h">No lyrics found</div>
              <p className="lyr-p">{note}</p>
              <p className="lyr-p">Hum looks for the song’s title and artist in the file, then asks LRCLIB, a free lyrics library. Songs that aren’t released yet won’t be there.</p>
              <button
                className="btn sm"
                onClick={() => {
                  setOpen(false);
                  retryLyrics();
                }}
              >
                Try again
              </button>
            </>
          )}
          {(status === 'found' || status === 'plain') && (
            <button
              className="btn sm ghost lyr-wrong"
              onClick={() => {
                useStudio.getState().set({ lyrics: null, lyricsStatus: 'none', lyricsNote: `Hidden: these were for “${who}”.` });
                setOpen(false);
              }}
            >
              Wrong song? Hide these
            </button>
          )}
        </div>
      )}
    </div>
  );
}
