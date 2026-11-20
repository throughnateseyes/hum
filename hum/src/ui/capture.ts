/**
 * Saving what's on the stage as it plays: a live recording (video + sound) and a still. The top bar
 * and the phone's Export panel share these.
 */
import { live } from '../state/live';
import { useStudio } from '../state/store';
import { Recorder, download } from '../render/recorder';

const recorder = new Recorder();

/** start recording what plays, or stop and save the clip */
export async function toggleRecording() {
  const stage = live.stage;
  const { set, flash } = useStudio.getState();
  if (!stage) return;
  if (!recorder.active) {
    try {
      recorder.start(stage.canvas);
      set({ recording: true });
    } catch (e) {
      flash(`Recording isn't supported here: ${String(e)}`);
    }
  } else {
    const blob = await recorder.stop();
    set({ recording: false });
    const ext = recorder.mime.includes('mp4') ? 'mp4' : 'webm';
    download(blob, `hum-${Date.now()}.${ext}`);
    flash(`Saved a ${ext.toUpperCase()} clip`);
  }
}

/** save the picture on the stage as a PNG */
export async function saveStill() {
  const url = await live.stage?.snapshot();
  if (url) download(url, `hum-${Date.now()}.png`);
}
