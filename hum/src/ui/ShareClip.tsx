/**
 * Share clip (the phone's Export panel): a 15, 30 or 60 s vertical clip around the song's best part
 * (the biggest drop or hook, src/audio/clipWindow.ts), or the stretch picked on the song map, made at
 * 9:16 (1080×1920, 30 fps) by the render timeline (renderVideos: H.264 + AAC in an MP4, frame by
 * frame, nothing plays while it works), then handed to the phone's share sheet so it can go straight
 * to Instagram or TikTok.
 *
 * The share sheet needs a fresh tap (browsers only open it from one), so when the clip is ready a big
 * Share button takes over; if the tap that started the render still counts, the sheet opens at once.
 * Where the browser can't share files, the clip downloads instead, with a note on where to find it.
 */
import { useEffect, useState } from 'react';
import { pickClip } from '../audio/clipWindow';
import type { TrackAnalysis } from '../core/types';
import { cancelClip } from '../render/clipExport';
import { download } from '../render/recorder';
import { cancelRender, RENDER_SIZES, renderBlocker, renderVideos } from '../render/timeline';
import { useStudio } from '../state/store';
import { useRenderMode } from './RenderBar';
import { fmtTime } from './song';
import { usePhoneUi } from './layout';
import { Share } from './Icons';

type Len = 15 | 30 | 60;
const LENS: Len[] = [15, 30, 60];
const PREF_KEY = 'hum.share';

function loadLen(): Len {
  try {
    const v = Number(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}').len);
    return v === 15 || v === 60 ? v : 30;
  } catch {
    return 30;
  }
}

/** the stretch for a clip of about `len` seconds, built around the biggest drop or hook */
export function shareWindow(a: TrackAnalysis, len: Len): { start: number; end: number; why: string } {
  if (a.duration <= len + 1) return { start: 0, end: a.duration, why: 'the whole song' };
  const w = pickClip(a, len, len * 0.85, len * 1.15);
  return { start: w.start, end: w.end, why: w.why };
}

/** can this browser hand a video file to the share sheet? */
function canShareFiles(): boolean {
  try {
    const f = new File([new Blob([], { type: 'video/mp4' })], 'clip.mp4', { type: 'video/mp4' });
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [f] });
  } catch {
    return false;
  }
}

type Ready = { blob: Blob; name: string; secs: number };

export function ShareClip() {
  const analysis = useStudio((s) => s.analysis);
  const clip = useStudio((s) => s.clip);
  const blocked = useStudio((s) => renderBlocker(s));
  const range = useRenderMode((s) => (s.range && s.forSong === analysis?.duration && s.range.label === 'your selection' ? s.range : null));
  const [len, setLen] = useState<Len>(loadLen);
  const [around, setAround] = useState<'best' | 'range'>('best');
  const [making, setMaking] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);
  const [note, setNote] = useState('');
  const sharable = canShareFiles();

  // a new song: start over
  useEffect(() => {
    setReady(null);
    setNote('');
  }, [analysis]);
  useEffect(() => {
    if (!range && around === 'range') setAround('best');
  }, [range, around]);

  const pickLen = (v: Len) => {
    setLen(v);
    setReady(null);
    setAround('best');
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ len: v }));
    } catch {
      /* private window */
    }
  };

  const win = analysis ? (around === 'range' && range ? { start: range.start, end: range.end, why: 'your stretch' } : shareWindow(analysis, len)) : null;

  const share = async (r: Ready) => {
    const file = new File([r.blob], r.name, { type: r.blob.type || 'video/mp4' });
    if (sharable && navigator.canShare?.({ files: [file] })) {
      try {
        // only the file: Instagram and TikTok take a video, and text alongside can make them refuse it
        await navigator.share({ files: [file] });
        setNote('Shared. Pick Instagram or TikTok in the sheet to post it.');
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // closed the sheet
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          setNote('Tap Share again to open the share sheet.');
          return;
        }
      }
    }
    saveFile(r);
  };

  const saveFile = (r: Ready) => {
    download(r.blob, r.name);
    setNote(
      sharable
        ? 'Saved to your downloads.'
        : 'Saved to your downloads. In Instagram or TikTok, start a new post and pick it from your videos (on iPhone, save it to Photos from the Files app first).',
    );
  };

  const make = async () => {
    if (!win || making || clip) return;
    setMaking(true);
    setReady(null);
    setNote('');
    // the stage shows the frames as they're made: keep the panel at half so both are in view
    if (usePhoneUi.getState().snap === 'full') usePhoneUi.setState({ snap: 'half' });
    const res = await renderVideos({ start: win.start, end: win.end, sizes: [RENDER_SIZES[0]], fps: 30, label: win.why, keep: true });
    setMaking(false);
    const f = res.files[0];
    if (!f) {
      setNote(res.failure ? `The clip couldn't be made: ${res.failure}` : res.cancelled ? 'Stopped. Nothing was saved.' : '');
      return;
    }
    const r = { blob: f.blob, name: f.name, secs: Math.round(win.end - win.start) };
    setReady(r);
    if (!f.blob.type.includes('mp4')) setNote('This browser could only record a WebM. Instagram and TikTok want MP4, so this one may need converting first.');
    // the tap that started it may still count: then the share sheet opens without another tap
    const act = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (act?.isActive) void share(r);
  };

  const stop = () => {
    cancelRender();
    cancelClip();
  };

  if (!analysis) return <p className="sheet-empty">{blocked ?? 'Load a song to make a clip.'}</p>;

  const running = making && !!clip;
  return (
    <div className="share">
      <div className="share-h">
        <b>Share clip</b>
        <span>9:16 for Instagram Reels and TikTok</span>
      </div>

      <div className="seg share-len" role="radiogroup" aria-label="Clip length">
        {LENS.map((v) => (
          <button key={v} role="radio" aria-checked={around === 'best' && len === v} className={around === 'best' && len === v ? 'on' : ''} disabled={making} onClick={() => pickLen(v)}>
            {v} s
          </button>
        ))}
        {range && (
          <button role="radio" aria-checked={around === 'range'} className={around === 'range' ? 'on' : ''} disabled={making} onClick={() => (setAround('range'), setReady(null))}>
            Your stretch
          </button>
        )}
      </div>
      {win && (
        <p className="share-what">
          {fmtTime(win.start)}–{fmtTime(win.end)} · {Math.round(win.end - win.start)} s · {around === 'range' ? 'the stretch picked on the song map' : `around ${win.why}`}
        </p>
      )}

      {running ? (
        <div className="share-run">
          <div className="share-bar">
            <i style={{ transform: `scaleX(${clip.phase === 'prep' ? 0.02 : clip.frac})` }} />
          </div>
          <div className="share-run-row">
            <span>{clip.phase === 'prep' ? 'Getting ready…' : clip.phase === 'save' ? 'Saving…' : `Making your clip · ${Math.round(clip.frac * 100)}%`}</span>
            <button className="btn share-cancel" onClick={stop}>
              Cancel
            </button>
          </div>
        </div>
      ) : ready ? (
        <div className="share-ready">
          <button className="btn primary share-go" onClick={() => void share(ready)}>
            <Share width={18} height={18} />
            {sharable ? 'Share to Instagram or TikTok' : 'Save the clip'}
          </button>
          <div className="share-row">
            {sharable && (
              <button className="btn" onClick={() => saveFile(ready)}>
                Save video
              </button>
            )}
            <button className="btn ghost" onClick={() => void make()}>
              Make it again
            </button>
          </div>
        </div>
      ) : (
        <button className="btn primary share-go" disabled={!!blocked || making} onClick={() => void make()} title={blocked ?? undefined}>
          Make a {around === 'range' && win ? `${Math.round(win.end - win.start)} s` : `${len} s`} clip
        </button>
      )}
      {note && <p className="share-note">{note}</p>}
      {!ready && !running && !note && blocked && <p className="share-note">{blocked}</p>}
    </div>
  );
}
