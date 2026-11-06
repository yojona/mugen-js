// Background music (bgm.c, bgmstream.c, bgmthread.c): one track at a time,
// read from the MUGEN tree and decoded by the browser. MP3, Ogg and WAV work
// everywhere; MIDI and tracker modules have no decoder here and stay silent.

import type { Mixer } from './mixer';

/** BgmInfo: a track and how it plays. */
export interface BgmInfo {
  path: string;
  /** Percent. */
  volume: number;
  loop: boolean;
  /** Sample numbers; -1 for the file's start and end. */
  loopStart: number;
  loopEnd: number;
}

/** The sample rate loop points count in (mugen.cfg [Sound] SampleRate): the decoder resamples the file. */
const LOOP_POINT_RATE = 44100;

/**
 * Bgm_ReadInfoKeys: the track of `key` and its parameters, with their defaults
 * when missing or unreadable; undefined without a path.
 */
export function readBgm(
  get: (key: string) => string | undefined,
  key: string,
  keys = { volume: `${key}.volume`, loop: `${key}.loop`, start: `${key}.loopstart`, end: `${key}.loopend` },
): BgmInfo | undefined {
  const path = get(key)?.trim();
  if (!path) return undefined;
  const int = (k: string, d: number) => {
    const n = parseInt(get(k) ?? '', 10);
    return Number.isFinite(n) ? n : d;
  };
  const number = parseFloat(get(keys.volume) ?? '');
  const loopStart = int(keys.start, -1);
  const loopEnd = int(keys.end, -1);
  return {
    path,
    volume: Number.isFinite(number) ? number : 100,
    loop: int(keys.loop, 1) !== 0,
    loopStart,
    loopEnd: loopEnd <= loopStart ? -1 : loopEnd,
  };
}

export class Music {
  private track: BgmInfo | undefined;
  private buffer: AudioBuffer | undefined;
  private source: AudioBufferSourceNode | undefined;
  private gain: GainNode | undefined;
  /** Where the track is, in seconds, when `startedAt` was the context's time. */
  private offset = 0;
  private startedAt = 0;
  private held = false;
  /** Bgm_Stop or Bgm_Play came after a load: that load's result is old. */
  private serial = 0;
  /** Bgm_SetVolume: [Sound] MasterVolume * BGMVolume, 0..1. */
  private master = 1;

  constructor(
    private mixer: Mixer,
    private read: (path: string) => Promise<Uint8Array>,
  ) {
    // A browser only starts audio after a gesture: the track waits for it.
    mixer.onUnlock = () => void this.load();
  }

  set volume(v: number) {
    this.master = v;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.master * (Math.max(0, this.track?.volume ?? 100) / 100);
  }

  /** Bgm_Play: this track, which goes on if it is already playing. Nothing to play stops the music. */
  play(info: BgmInfo | null): void {
    if (!info) {
      this.stop();
      return;
    }
    const t = this.track;
    if (t && t.path.toLowerCase() === info.path.toLowerCase() && t.loop === info.loop) return;
    this.stop();
    this.track = info;
    void this.load();
  }

  /** Bgm_Stop. */
  stop(): void {
    this.serial++;
    this.stopSource();
    this.track = undefined;
    this.buffer = undefined;
    this.offset = 0;
    this.held = false;
  }

  /** Holds the track where it is (a game pause, AssertSpecial NoMusic). */
  hold(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    if (held) {
      this.offset = this.position();
      this.stopSource();
    } else this.start();
  }

  private position(): number {
    const ctx = this.mixer.context;
    const b = this.buffer;
    if (!ctx || !b || !this.source) return this.offset;
    const t = this.offset + ctx.currentTime - this.startedAt;
    const src = this.source;
    if (!src.loop) return Math.min(t, b.duration);
    const end = src.loopEnd > 0 ? src.loopEnd : b.duration;
    return t < end ? t : src.loopStart + ((t - src.loopStart) % (end - src.loopStart));
  }

  private async load(): Promise<void> {
    const ctx = this.mixer.context;
    const track = this.track;
    if (!ctx || !track || this.buffer) return;
    const serial = ++this.serial;
    try {
      // decodeAudioData detaches its input, so give it a copy.
      const buffer = await ctx.decodeAudioData((await this.read(track.path)).slice().buffer);
      if (serial !== this.serial) return;
      this.buffer = buffer;
      this.start();
    } catch {
      // Bgm_StreamOpen: an unreadable file or format only leaves no music.
      if (serial === this.serial) console.warn(`mugen-js: could not play ${track.path}`);
    }
  }

  private start(): void {
    const ctx = this.mixer.context;
    const track = this.track;
    if (!ctx || !track || !this.buffer || this.held || this.source) return;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = track.loop;
    if (track.loopStart > 0) source.loopStart = track.loopStart / LOOP_POINT_RATE;
    if (track.loopEnd > 0) source.loopEnd = track.loopEnd / LOOP_POINT_RATE;
    this.gain ??= ctx.createGain();
    this.gain.connect(ctx.destination);
    this.applyVolume();
    source.connect(this.gain);
    source.start(0, this.offset);
    this.source = source;
    this.startedAt = ctx.currentTime;
  }

  private stopSource(): void {
    const source = this.source;
    this.source = undefined;
    if (!source) return;
    source.stop();
    source.disconnect();
  }
}
