// Web Audio playback for SND sounds (WAV), decoded once and cached.

import type { Sound } from '../formats/snd';

export class Mixer {
  private ctx: AudioContext | undefined;
  private cache = new WeakMap<Sound, Promise<AudioBuffer | undefined>>();
  volume = 0.7;

  private paused = false;
  /** The context now exists: what was waiting for a user gesture can start. */
  onUnlock?: () => void;

  get context(): AudioContext | undefined {
    return this.ctx;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.onUnlock?.();
    }
    if (!this.paused && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** No sound can be heard yet: the browser is waiting for a user gesture, or it's paused. */
  get locked(): boolean {
    return this.ctx?.state !== 'running';
  }

  /** Holds the sounds that are playing, to continue them with resume(). */
  pause(): void {
    this.paused = true;
    void this.ctx?.suspend();
  }

  resume(): void {
    this.paused = false;
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  /** Stops every sound and frees the audio context. */
  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = undefined;
  }

  /** Sounds playing on a named channel (PlaySnd channel per player). */
  private channels = new Map<string, { src: AudioBufferSourceNode; pan: StereoPannerNode; ended: boolean }>();
  /** Every source still playing (StopSnd -1 stops them all). */
  private live = new Set<AudioBufferSourceNode>();

  /**
   * Start a sound. `key`: its channel (the sound there is cut; with
   * lowPriority nothing starts while one is playing). volume 0..100
   * (Sound_SetSlotVolume clamps), pan -127..127, loop.
   */
  play(sound: Sound | undefined, o: { key?: string; lowPriority?: boolean; volume?: number; loop?: boolean; pan?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || !sound) return;
    if (o.key !== undefined) {
      const cur = this.channels.get(o.key);
      if (cur && !cur.ended) {
        if (o.lowPriority) return;
        stopEntry(cur);
      }
    }
    let buf = this.cache.get(sound);
    if (!buf) {
      // decodeAudioData detaches its input, so give it a copy.
      buf = ctx.decodeAudioData(sound.wav.slice().buffer).catch(() => undefined);
      this.cache.set(sound, buf);
    }
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.gain.value = (this.volume * Math.max(0, Math.min(100, o.volume ?? 100))) / 100;
    pan.pan.value = (o.pan ?? 0) / 127;
    src.loop = !!o.loop;
    src.connect(gain).connect(pan).connect(ctx.destination);
    const entry = { src, pan, ended: false };
    if (o.key !== undefined) this.channels.set(o.key, entry);
    this.live.add(src);
    src.onended = () => {
      entry.ended = true;
      this.live.delete(src);
    };
    void buf.then((b) => {
      if (!b || entry.ended) return;
      src.buffer = b;
      src.start();
    });
  }

  /** StopSnd: one channel, or every sound (undefined). */
  stop(key?: string): void {
    if (key === undefined) {
      for (const e of this.channels.values()) stopEntry(e);
      for (const src of this.live) stopEntry({ src, ended: false });
      this.live.clear();
      return;
    }
    const e = this.channels.get(key);
    if (e) stopEntry(e);
  }

  /** SndPan: re-pan the sound on a channel. */
  setPan(key: string, pan: number): void {
    const e = this.channels.get(key);
    if (e && !e.ended) e.pan.pan.value = pan / 127;
  }

  /** Run a tick's sound commands; `resolve` finds the sound of a play. */
  run(
    cmds: readonly import('../engine/world').SoundCmd[],
    resolve: (owner: import('../engine/player').Player | null, group: number, number: number) => Sound | undefined,
  ): void {
    for (const c of cmds) {
      if (c.kind === 'stop') this.stop(c.key);
      else if (c.kind === 'pan') this.setPan(c.key, c.pan);
      else this.play(resolve(c.owner, c.group, c.number), c);
    }
  }
}

/** Stops a sound; one still decoding never starts (it sees `ended`). */
function stopEntry(e: { src: AudioBufferSourceNode; ended: boolean }): void {
  if (e.ended) return;
  e.ended = true;
  try {
    e.src.stop();
  } catch {
    /* not started yet */
  }
}
