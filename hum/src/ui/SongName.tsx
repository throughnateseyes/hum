import { useEffect, useState } from 'react';
import { cleanSongName, nameInFile, songCredit } from '../state/songName';
import { useStudio } from '../state/store';
import { Toggle } from './controls';
import { changeLyrics } from './lyricsOpen';

/**
 * What the song is called, at the top of the song menu: the title and artist the video writes. Typing one
 * takes effect when the field is left (or on Enter); an emptied field goes back to what the file says.
 */
export function SongNameFields({ onDone }: { onDone: () => void }) {
  const track = useStudio((s) => s.track);
  const own = useStudio((s) => s.songName);
  const title = useStudio((s) => songCredit(s).title);
  const artist = useStudio((s) => songCredit(s).artist);
  const lyrics = useStudio((s) => s.lyricsStatus);
  if (!track || track.source === 'mic') return null;
  const file = track.source === 'file' ? nameInFile(track.name) : { title: track.name, artist: '' };
  const put = (p: { title?: string; artist?: string; hidden?: boolean }) => {
    const next = { title: own?.title ?? '', artist: own?.artist ?? '', hidden: own?.hidden, ...p };
    // the file's own word for it isn't a change
    if (next.title === file.title) next.title = '';
    if (next.artist === file.artist) next.artist = '';
    useStudio.getState().set({ songName: cleanSongName(next) });
  };
  return (
    <div className="song-name">
      <div className="song-name-h">
        This song
        {own && (own.title || own.artist) && (
          <button className="song-name-reset" onClick={() => put({ title: '', artist: '' })} title={`Back to “${[file.artist, file.title].filter(Boolean).join(' - ')}”`}>
            Use the file’s name
          </button>
        )}
      </div>
      <NameField label="Title" value={title} onPut={(v) => put({ title: v })} />
      <NameField label="Artist" value={artist} placeholder="Not known" onPut={(v) => put({ artist: v })} />
      <label className="sw song-name-show">
        <Toggle on={!own?.hidden} onChange={(v) => put({ hidden: !v })} label="Show the title on clips and photos" />
        Show the title on clips and photos
      </label>
      {track.source === 'file' && lyrics !== 'searching' && (
        <button
          className="song-name-lyrics"
          onClick={() => {
            onDone();
            changeLyrics();
          }}
        >
          Change the lyrics…
        </button>
      )}
    </div>
  );
}

function NameField({ label, value, placeholder, onPut }: { label: string; value: string; placeholder?: string; onPut: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const done = () => {
    const v = text.replace(/\s+/g, ' ').trim();
    if (v !== value) onPut(v);
    // (an emptied field shows the file's name again)
    if (!v) setText(value);
  };
  return (
    <label className="song-name-f">
      <span>{label}</span>
      <input
        className="txt"
        value={text}
        maxLength={80}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(value);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
      />
    </label>
  );
}
