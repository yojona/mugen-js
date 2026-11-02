// Web Audio playback for SND sounds (WAV), decoded once and cached.

import type { Sound } from '../formats/snd';

export class Mixer {
  private ctx: AudioContext | undefined;
  private cache = new WeakMap<Sound, Promise<AudioBuffer | undefined>>();
  volume = 0.7;

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  play(sound: Sound | undefined): void {
    const ctx = this.ctx;
    if (!ctx || !sound) return;
    let buf = this.cache.get(sound);
    if (!buf) {
      // decodeAudioData detaches its input, so give it a copy.
      buf = ctx.decodeAudioData(sound.wav.slice().buffer).catch(() => undefined);
      this.cache.set(sound, buf);
    }
    void buf.then((b) => {
      if (!b) return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      src.buffer = b;
      src.connect(gain).connect(ctx.destination);
      src.start();
    });
  }
}
