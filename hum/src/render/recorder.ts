import { audioEngine } from '../audio/engine';

/** Records the stage canvas + the audio graph into a video file. */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  mime = '';

  static pickMime(): string {
    const prefs = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return prefs.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
  }

  start(canvas: HTMLCanvasElement, fps = 60) {
    const stream = canvas.captureStream(fps);
    const dest = audioEngine.recordDest;
    if (dest) dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    this.mime = Recorder.pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 16_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }

  stop(): Promise<Blob> {
    return new Promise((res) => {
      const r = this.rec;
      if (!r) return res(new Blob());
      r.onstop = () => res(new Blob(this.chunks, { type: this.mime || 'video/webm' }));
      r.stop();
      this.rec = null;
    });
  }

  get active() {
    return !!this.rec;
  }
}

export function download(blob: Blob | string, name: string) {
  const a = document.createElement('a');
  a.href = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
