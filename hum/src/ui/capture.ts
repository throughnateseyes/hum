/** Saving the picture on the stage as a still. The top bar and the phone's Export panel share it. */
import { live } from '../state/live';
import { download } from '../render/recorder';

/** save the picture on the stage as a PNG */
export async function saveStill() {
  const url = await live.stage?.snapshot();
  if (url) download(url, `hum-${Date.now()}.png`);
}
