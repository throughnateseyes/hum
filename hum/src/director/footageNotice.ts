/**
 * The line about small frames going to Claude, and whether it has been on screen. Nothing of the
 * person's clips or photos leaves the browser before it has (state/plan.ts makeVideo).
 */
const KEY = 'hum.frames';

let shown = false;
let sent = false;
try {
  sent = localStorage.getItem(KEY) === 'sent';
} catch {
  // storage is off: the line simply shows again next time
}

/** the line is on screen now */
export function framesNoteShown() {
  shown = true;
}

/** may frames be sent: the line is or was on screen */
export const framesNoted = () => shown || sent;

/** frames have been sent before: the line has done its job */
export const framesSentBefore = () => sent;

/** the first frames are on their way */
export function framesSent() {
  sent = true;
  try {
    localStorage.setItem(KEY, 'sent');
  } catch {
    // as above
  }
}
