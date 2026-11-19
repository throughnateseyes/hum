import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Stage } from '../render/stage';
import { live } from '../state/live';
import { useStudio, type Aspect } from '../state/store';
import { LoadingStage } from './Loading';
import { TasteHud } from './Taste';
import { WelcomeLayer } from './Welcome';

const RATIOS: Record<Exclude<Aspect, 'fill'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

export function StageView() {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const aspect = useStudio((s) => s.aspect);
  const perform = useStudio((s) => s.perform);
  const quality = useStudio((s) => s.quality);
  const recording = useStudio((s) => s.recording);
  const [size, setSize] = useState({ w: 800, h: 450 });

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
        <LoadingStage />
        <TasteHud />
        <div className="stage-hud">
          {recording && (
            <span className="hud-pill rec">
              <i /> Recording
            </span>
          )}
        </div>
        <WelcomeLayer />
      </div>
    </div>
  );
}
