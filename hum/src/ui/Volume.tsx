/**
 * The volume control: a speaker you click to mute, and a slider beside it.
 *
 * It only changes what you hear. The analyser listens before the volume, so the visuals react the
 * same at any level, and recordings and clips keep the song at full level too. Scroll over it, or
 * use ↑ ↓ and M anywhere, to change it without aiming.
 */
import { useEffect } from 'react';
import { audioEngine } from '../audio/engine';
import { useStudio } from '../state/store';
import { Slider } from './controls';
import { Speaker } from './Icons';

/** the slider is linear to the eye; ears hear loudness roughly as the square of the gain */
const shape = (v: number) => v * v;

/** keep the engine in step with the store (mount once, near the top) */
export function useVolumeSync() {
  useEffect(() => {
    const apply = (s: { volume: number; muted: boolean }) => audioEngine.setVolume(s.muted ? 0 : shape(s.volume));
    apply(useStudio.getState());
    return useStudio.subscribe((s, prev) => {
      if (s.volume !== prev.volume || s.muted !== prev.muted) apply(s);
    });
  }, []);
}

export function setVolume(v: number, announce = false) {
  const s = useStudio.getState();
  const volume = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
  // moving the slider up un-mutes, the way every player does
  s.set({ volume, muted: volume === 0 });
  if (announce) s.flash(volume === 0 ? 'Muted' : `Volume ${Math.round(volume * 100)}%`);
}

export function nudgeVolume(by: number) {
  const s = useStudio.getState();
  setVolume((s.muted ? 0 : s.volume) + by, true);
}

export function toggleMute(announce = false) {
  const s = useStudio.getState();
  if (s.muted || s.volume === 0) {
    // coming back from 0 needs somewhere to come back to
    s.set({ muted: false, volume: s.volume === 0 ? 0.6 : s.volume });
    if (announce) s.flash(`Volume ${Math.round((s.volume === 0 ? 0.6 : s.volume) * 100)}%`);
  } else {
    s.set({ muted: true });
    if (announce) s.flash('Muted');
  }
}

export function Volume({ dark = false }: { dark?: boolean }) {
  const volume = useStudio((s) => s.volume);
  const muted = useStudio((s) => s.muted);
  const mic = useStudio((s) => s.track?.source === 'mic');
  const shown = muted ? 0 : volume;
  const level = shown === 0 ? 0 : shown < 0.34 ? 1 : shown < 0.67 ? 2 : 3;
  const pct = Math.round(shown * 100);
  // the mic isn't played back here (it would feed back), so there's nothing to turn up
  if (mic) return null;

  return (
    <div
      className={`volume ${dark ? 'dark' : ''}`}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) < 1) return;
        nudgeVolume(e.deltaY < 0 ? 0.05 : -0.05);
      }}
    >
      <button
        className="vol-btn has-tip"
        data-tip={muted || volume === 0 ? 'Unmute  M' : 'Mute  M'}
        aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
        aria-pressed={muted || volume === 0}
        onClick={() => toggleMute()}
      >
        <Speaker level={level} width={16} height={16} />
      </button>
      <div
        className="vol-s"
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={muted ? 'Muted' : `${pct}%`}
        title={`Volume ${muted ? 'muted' : `${pct}%`}`}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.05;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudgeVolume(step);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudgeVolume(-step);
          else if (e.key === 'Home') setVolume(0);
          else if (e.key === 'End') setVolume(1);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Slider value={shown} min={0} max={1} step={0.01} onChange={(v) => setVolume(v)} />
      </div>
    </div>
  );
}
