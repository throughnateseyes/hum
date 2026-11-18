import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { Stage } from '../render/stage';
import { live } from '../state/live';
import { useStudio, type Aspect } from '../state/store';
import { handleFiles, loadDemo, useMic } from '../state/tracks';
import { Mic, Upload } from './Icons';

const RATIOS: Record<Exclude<Aspect, 'fill'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

export function StageView() {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const aspect = useStudio((s) => s.aspect);
  const perform = useStudio((s) => s.perform);
  const quality = useStudio((s) => s.quality);
  const track = useStudio((s) => s.track);
  const recording = useStudio((s) => s.recording);
  const previewing = useStudio((s) => s.previewId !== null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stage = new Stage(canvas.current!);
    live.stage = stage;
    // the layout effect may have measured before the stage existed
    const fr = frame.current!;
    stage.setSize(fr.clientWidth, fr.clientHeight);
    stage.start();
    return () => {
      live.stage = null;
      stage.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const fit = () => {
      const cs = getComputedStyle(el);
      const pw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ph = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      let w = pw;
      let h = ph;
      if (aspect !== 'fill') {
        const r = RATIOS[aspect];
        if (pw / ph > r) w = ph * r;
        else h = pw / r;
      }
      w = Math.max(2, Math.floor(w));
      h = Math.max(2, Math.floor(h));
      setSize({ w, h });
      live.stage?.setSize(w, h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, perform, quality]);

  return (
    <div className="stage-wrap" ref={wrap}>
      <div className="stage-frame" ref={frame} style={{ width: size.w, height: size.h }}>
        <canvas ref={canvas} />
        <div className="stage-hud">
          {recording && (
            <span className="hud-pill rec">
              <i /> Recording
            </span>
          )}
          {previewing && !recording && <span className="hud-pill">Previewing · click to keep</span>}
        </div>
        {!track && (
          <div className="empty">
            <div className="empty-card">
              <h2>Drop a song to begin</h2>
              <p>Hum listens for the sub, the kick, the air and the drop, then paints with them.</p>
              <div className="row" style={{ marginBottom: 10 }}>
                {DEMO_TRACKS.map((d) => (
                  <button key={d.id} className="demo-btn" onClick={() => void loadDemo(d.id)}>
                    <b>{d.name}</b>
                    <span>{d.description}</span>
                  </button>
                ))}
              </div>
              <div className="row">
                <button className="btn" onClick={() => fileInput.current?.click()}>
                  <Upload width={14} height={14} /> Choose audio
                </button>
                <button className="btn" onClick={() => void useMic()}>
                  <Mic width={14} height={14} /> Use microphone
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*,image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
