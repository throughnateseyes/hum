/**
 * Real-time audio engine.
 *
 * Takes an <audio> element (file playback) or the microphone, and every animation frame
 * produces an AudioFrame: band energies, transient envelopes for kick / snare / hats,
 * a tempo-locked beat phase, slow energy, build-up and drop detection.
 */
import type { AudioFrame, TrackAnalysis } from '../core/types';
import { FFT_SIZE, FrameDsp } from './frameDsp';

export { emptyFrame } from './frameDsp';

export type SourceKind = 'none' | 'file' | 'mic';

/** the levels a held moment keeps (the beat clock keeps running, hits don't repeat) */
const HELD_KEYS = ['level', 'sub', 'bass', 'lowMid', 'mid', 'highMid', 'air', 'kick', 'snare', 'hat', 'energy', 'brightness', 'flux', 'build', 'drop', 'sway'] as const satisfies readonly (keyof AudioFrame)[];

export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  /** for recording: everything audible is also routed here */
  recordDest: MediaStreamAudioDestinationNode | null = null;
  readonly el: HTMLAudioElement;
  private elSource: MediaElementAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private outGain: GainNode | null = null;
  kind: SourceKind = 'none';

  /** the listening itself (bands, hits, beat, drops); a render feeds its own copy from the song file */
  readonly dsp = new FrameDsp();
  get frame(): AudioFrame {
    return this.dsp.frame;
  }
  get analysis(): TrackAnalysis | null {
    return this.dsp.analysis;
  }

  private freqDb = new Float32Array(FFT_SIZE / 2);
  private timeData = new Float32Array(FFT_SIZE);
  private clock = 0;

  /** manual tempo override (tap tempo / analysis). 0 = auto */
  get bpmOverride() {
    return this.dsp.bpmOverride;
  }
  set bpmOverride(v: number) {
    this.dsp.bpmOverride = v;
  }
  /** global input gain multiplier for the reactive signals (sensitivity) */
  get sensitivity() {
    return this.dsp.sensitivity;
  }
  set sensitivity(v: number) {
    this.dsp.sensitivity = v;
  }

  constructor() {
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';
    this.el.loop = true;
  }

  /** must be called from a user gesture the first time */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      // 48 kHz whatever the output device runs at (a Bluetooth headset can sit at 24 kHz), so recordings
      // and clips keep full-range sound; the browser resamples for the speakers
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      } catch {
        ctx = new AudioContext({ latencyHint: 'interactive' });
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -110;
      analyser.maxDecibels = 0;
      const out = ctx.createGain();
      const rec = ctx.createMediaStreamDestination();
      this.elSource = ctx.createMediaElementSource(this.el);
      this.elSource.connect(analyser);
      this.elSource.connect(out);
      out.connect(ctx.destination);
      // recordings take the song before the volume, so turning the page down never quiets a video
      this.elSource.connect(rec);
      out.gain.value = this.vol;
      this.el.volume = 1;
      this.ctx = ctx;
      this.analyser = analyser;
      this.outGain = out;
      this.recordDest = rec;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  async loadFile(file: Blob, analysis: TrackAnalysis | null = null) {
    this.ensureContext();
    this.stopMic();
    if (this.el.src.startsWith('blob:')) URL.revokeObjectURL(this.el.src);
    this.el.src = URL.createObjectURL(file);
    this.kind = 'file';
    this.held = null;
    this.setAnalysis(analysis);
    this.resetState();
    await new Promise<void>((res) => {
      const done = () => {
        this.el.removeEventListener('loadedmetadata', done);
        res();
      };
      this.el.addEventListener('loadedmetadata', done);
      this.el.load();
    });
  }

  setAnalysis(a: TrackAnalysis | null) {
    this.dsp.setAnalysis(a, this.el.currentTime);
  }

  async startMic() {
    const ctx = this.ensureContext();
    this.el.pause();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.listenTo(ctx, stream, false);
  }

  /**
   * Listen to another browser tab (a song playing on YouTube, Spotify's web player…). The browser
   * asks which tab to share; the person must leave "Share tab audio" on. The tab keeps playing out
   * loud on its own, so it's only analysed here, plus sent to recordings. Desktop Chrome and Edge.
   */
  async startTab(onEnded: () => void) {
    const ctx = this.ensureContext();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('unsupported');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Chrome only offers tab audio with a video track too; the picture is never used
      video: { frameRate: 1, width: 320 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
    } as DisplayMediaStreamOptions);
    const audio = stream.getAudioTracks()[0];
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('no_audio');
    }
    this.el.pause();
    this.listenTo(ctx, stream, true);
    // "Stop sharing" in the browser, or the tab closing
    audio.addEventListener('ended', () => {
      if (this.micStream === stream) {
        this.stopMic();
        onEnded();
      }
    });
  }

  private listenTo(ctx: AudioContext, stream: MediaStream, toRecording: boolean) {
    this.stopMic();
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser!);
    // the song is heard from its own tab; recordings still need it
    if (toRecording && this.recordDest) this.micSource.connect(this.recordDest);
    this.kind = 'mic';
    this.dsp.setAnalysis(null, 0);
    this.resetState();
  }

  stopMic() {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micStream = null;
    if (this.kind === 'mic') this.kind = 'none';
  }

  async play() {
    this.ensureContext();
    if (this.kind === 'file') await this.el.play();
  }
  pause() {
    this.el.pause();
  }
  toggle() {
    if (this.el.paused) void this.play();
    else this.pause();
  }
  seek(t: number) {
    this.held = null;
    this.el.currentTime = Math.max(0, Math.min(t, this.el.duration || 0));
    this.setAnalysis(this.analysis);
    this.resetState(false);
  }

  /**
   * While paused, show the sound of one moment instead of easing to idle: scrubbing the render range
   * holds the levels heard at the handle, so the stage looks like that moment. Playing or seeking
   * lets go of it.
   */
  private held: AudioFrame | null = null;
  holdFrame(f: AudioFrame | null) {
    if (!f) {
      this.held = null;
      return;
    }
    this.held = { ...f, spectrum: f.spectrum.slice(), waveform: f.waveform.slice(), layers: { ...f.layers } };
  }
  private songTap: { gain: GainNode; dest: MediaStreamAudioDestinationNode } | null = null;
  /**
   * The loaded song alone, before the volume control, as a stream (clip export: the clip has sound even
   * when the page is turned down). `gain` lets the caller fade it.
   */
  tapSong(): { gain: GainNode; dest: MediaStreamAudioDestinationNode } | null {
    const ctx = this.ensureContext();
    if (!this.elSource) return null;
    if (!this.songTap) {
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      this.elSource.connect(gain);
      gain.connect(dest);
      this.songTap = { gain, dest };
    }
    return this.songTap;
  }

  private vol = 1;
  /** what you hear (0 to 1, already shaped). The analyser sits before it, so the visuals never change. */
  setVolume(v: number) {
    this.vol = Math.min(1, Math.max(0, v));
    if (this.outGain && this.ctx) this.outGain.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.015);
    else this.el.volume = this.vol;
  }

  get playing() {
    return this.kind === 'mic' || (this.kind === 'file' && !this.el.paused);
  }

  /** the player's position right now (frame.time is only as fresh as the last rendered frame) */
  get currentTime() {
    return this.kind === 'file' ? this.el.currentTime : this.frame.time;
  }

  private resetState(full = true) {
    this.dsp.reset(full);
  }

  /** Call once per animation frame. */
  update(dtRaw: number): AudioFrame {
    const dt = Math.min(0.1, Math.max(1 / 240, dtRaw));
    this.clock += dt;
    const playing = this.playing;
    const file = this.kind === 'file';
    const moment = {
      time: file ? this.el.currentTime : this.clock,
      duration: file ? this.el.duration || 0 : 0,
      playing,
      songTime: file ? this.el.currentTime : null,
    };
    const an = this.analyser;
    if (playing) this.held = null;
    if (this.held && file) {
      const f = this.dsp.step(dtRaw, null, moment);
      const h = this.held;
      for (const k of HELD_KEYS) (f[k] as number) = h[k] as number;
      f.spectrum.set(h.spectrum);
      f.waveform.set(h.waveform);
      Object.assign(f.layers, h.layers);
      return f;
    }
    if (!an || !playing) return this.dsp.step(dtRaw, null, moment);
    an.getFloatFrequencyData(this.freqDb);
    an.getFloatTimeDomainData(this.timeData);
    return this.dsp.step(dtRaw, { freqDb: this.freqDb, timeData: this.timeData, sampleRate: this.ctx!.sampleRate }, moment);
  }
}

export const audioEngine = new AudioEngine();
