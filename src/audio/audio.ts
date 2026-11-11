import { RECIPES, renderRecipe, type Sfx } from '@/audio/synth';

const MAX_VOICES = 12;

/** Plays short buffers. Buffers are made on the first user gesture, which mobile browsers require anyway. */
export class AudioBus {
  public enabled = true;
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<Sfx, AudioBuffer>();
  private voices = 0;

  /** Call from a user gesture. Safe to call repeatedly. */
  public unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    const rate = this.ctx.sampleRate;
    for (const [id, recipe] of Object.entries(RECIPES) as [Sfx, (typeof RECIPES)[Sfx]][]) {
      void renderRecipe(recipe, rate).then((buffer) => this.buffers.set(id, buffer));
    }
  }

  /** `rate` shifts pitch (cascades climb), `gain` scales volume. */
  public play(id: Sfx, rate = 1, gain = 1): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id);
    if (!this.enabled || !ctx || !buffer || ctx.state !== 'running' || this.voices >= MAX_VOICES) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    src.connect(amp).connect(ctx.destination);
    this.voices++;
    src.onended = () => this.voices--;
    src.start();
  }

  public suspend(): void {
    void this.ctx?.suspend();
  }

  public resume(): void {
    void this.ctx?.resume();
  }
}
