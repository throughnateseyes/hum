/**
 * The start screen: one calm island over a blurred stage, whose only job is to get a song in.
 *
 * A plain line says what Hum does, one large target chooses a song (or takes one dropped anywhere on
 * the page), the two demo songs are a quiet second choice, and the bottom section asks for an AI
 * access code up front (AccessSection: Claude directs the video with one, Hum's built-in director
 * without). The microphone and another tab live in the song menu in the top bar. The live picture
 * behind is veiled, so the island is what you look at.
 *
 * After a reload the song from last time comes back on its own (restoreSession in state/tracks.ts).
 * That takes a moment, and the start screen must not flash up in between: WelcomeLayer first asks
 * whether a song was saved, and while one is coming back it shows a short "Bringing back" note.
 */
import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { recallSong } from '../state/saved';
import { useStudio } from '../state/store';
import { learnNeed } from '../director/access';
import { handleFiles, loadDemo } from '../state/tracks';
import { AccessSection } from './AccessSection';
import { Upload } from './Icons';

/** plain-words descriptions of the demo songs (the ids are from audio/demoTracks.ts) */
const DEMO_LINE: Record<string, string> = {
  pressure: 'Heavy bass, a big drop',
  driftwood: 'Slow piano and rain',
};

export function Welcome() {
  const input = useRef<HTMLInputElement>(null);

  // ask the server once whether it wants a code (free, no Claude call), so the bottom section knows
  // what to show before anyone presses anything
  useEffect(() => {
    void learnNeed();
  }, []);

  return (
    <section className="welcome" aria-labelledby="wl-title">
      <h2 className="wl-title" id="wl-title">
        Turn any song into a music video
      </h2>
      <p className="wl-lede">Hum listens to your song and makes a video that moves with it. Change any part you like, then save it.</p>

      <button
        className="wl-drop"
        onClick={() => {
          // this tap is the gesture that lets the song play once it's planned (the picker's own
          // change event doesn't count as one on iPhone)
          audioEngine.unlock();
          input.current?.click();
        }}
        aria-label="Choose a song"
        aria-describedby="wl-drop-hint"
      >
        <span className="wl-drop-icon" aria-hidden>
          <Upload width={20} height={20} />
        </span>
        <span className="wl-drop-btn">Choose a song</span>
        <span className="wl-drop-hint" id="wl-drop-hint">
          <span className="wl-idle">or drop one anywhere on this page</span>
          <span className="wl-over" aria-hidden>
            Let go to use it
          </span>
        </span>
      </button>
      <p className="wl-also">MP3, WAV, M4A, FLAC or a music video. Video clips and photos can be dropped in too.</p>

      <div className="wl-demos" role="group" aria-labelledby="wl-demos-h">
        <span className="wl-demos-h" id="wl-demos-h">
          No song to hand? Try one of ours
        </span>
        <div className="wl-demo-row">
          {DEMO_TRACKS.map((d) => (
            <button key={d.id} className="wl-demo" onClick={() => void loadDemo(d.id)}>
              <b>{d.name}</b>
              <span>{DEMO_LINE[d.id] ?? d.description}</span>
            </button>
          ))}
        </div>
      </div>

      <AccessSection />

      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,image/*,.hum"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </section>
  );
}

/** what the start-up check found: still asking, a saved song is coming back, or nothing was saved */
type Boot = 'asking' | 'restoring' | 'none';
/** the check runs once per page load; after that (a song closed, say) the start screen shows at once */
let bootSeen: Boot | null = null;
let bootName = '';
/** if a saved song hasn't appeared by now, something went wrong: show the start screen after all */
const RESTORE_GIVE_UP_MS = 9000;

/** the start screen only shows before there's a song */
export function WelcomeLayer() {
  const track = useStudio((s) => s.track);
  const [boot, setBoot] = useState<Boot>(bootSeen === 'none' ? 'none' : 'asking');

  useEffect(() => {
    if (bootSeen === 'none') return;
    let alive = true;
    const done = () => {
      bootSeen = 'none';
      if (alive) setBoot('none');
    };
    void recallSong().then((song) => {
      if (!alive) return;
      if (!song) return done();
      bootName = song.name;
      bootSeen = 'restoring';
      setBoot('restoring');
    }, done);
    const giveUp = window.setTimeout(done, RESTORE_GIVE_UP_MS);
    return () => {
      alive = false;
      window.clearTimeout(giveUp);
    };
  }, []);

  // a song is in: from here on the start screen is the plain one
  useEffect(() => {
    if (track) bootSeen = 'none';
  }, [track]);

  if (track) return null;
  return (
    <div className="empty wl-layer">
      <div className="wl-veil" aria-hidden />
      {boot === 'none' && <Welcome />}
      {boot === 'restoring' && (
        <div className="wl-back" role="status">
          <span className="spin" aria-hidden />
          <span>
            Bringing back <b>{bootName || 'your song'}</b>
          </span>
        </div>
      )}
    </div>
  );
}
