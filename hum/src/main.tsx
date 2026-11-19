import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// no StrictMode: the WebGL stage owns a single context and should mount once
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.DEV) {
  void Promise.all([import('./state/store'), import('./presets'), import('./fx'), import('./scenes'), import('./state/live'), import('./audio/engine'), import('./dev/thumbs'), import('./dev/perfProbe'), import('./render/quality')]).then(
    ([store, presets, fx, scenes, live, engine, thumbs, perf, q]) => {
      (window as unknown as Record<string, unknown>).__hum = {
        useStudio: store.useStudio,
        PRESETS: presets.PRESETS,
        fx,
        scenes,
        live: live.live,
        engine: engine.audioEngine,
        makeThumbs: thumbs.makeThumbs,
        perf,
        quality: q.quality,
      };
    },
  );
}
