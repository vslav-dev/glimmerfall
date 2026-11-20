import { chosen, fileUrl, type SoundChoice, Variant } from '@/audio/sounds';
import { RECIPES, renderRecipe, type Sfx } from '@/audio/synth';

const MAX_VOICES = 12;

/**
 * Plays short buffers, one picked variant per sound. Variants load on the first user gesture,
 * which mobile browsers require anyway, and as they are picked; a sound still loading is skipped.
 */
export class AudioBus {
  public enabled = true;
  private ctx: AudioContext | null = null;
  private choice: SoundChoice = {};
  /** loads by "sound/variant"; a failed one is dropped, so the next pick retries it */
  private readonly loads = new Map<string, Promise<AudioBuffer | null>>();
  private readonly ready = new Map<string, AudioBuffer>();
  private voices = 0;

  /** Call from a user gesture. Safe to call repeatedly. */
  public unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume();
    this.loadChosen();
  }

  /** Picks the variant each sound plays; new picks start loading at once. */
  public choose(choice: SoundChoice): void {
    this.choice = choice;
    this.loadChosen();
  }

  /** `rate` shifts pitch (cascades climb), `gain` scales volume. */
  public play(id: Sfx, rate = 1, gain = 1): void {
    const buffer = this.ready.get(key(id, chosen(this.choice, id)));
    if (this.enabled && buffer) this.start(buffer, rate, gain);
  }

  /** Plays one variant once it is loaded, even with sound off: the sound menu asks for it explicitly. */
  public async preview(id: Sfx, variant: string): Promise<void> {
    const buffer = await this.load(id, variant);
    if (buffer) this.start(buffer, 1, 1);
  }

  public suspend(): void {
    void this.ctx?.suspend();
  }

  public resume(): void {
    void this.ctx?.resume();
  }

  private start(buffer: AudioBuffer, rate: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.voices >= MAX_VOICES) return;
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

  private loadChosen(): void {
    for (const id of Object.keys(RECIPES) as Sfx[]) void this.load(id, chosen(this.choice, id));
  }

  private load(id: Sfx, variant: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    const k = key(id, variant);
    let load = this.loads.get(k);
    if (!load) {
      load = decode(ctx, id, variant).then(
        (buffer) => {
          if (buffer) this.ready.set(k, buffer);
          return buffer;
        },
        () => {
          this.loads.delete(k);
          return null;
        },
      );
      this.loads.set(k, load);
    }
    return load;
  }
}

async function decode(ctx: AudioContext, id: Sfx, variant: string): Promise<AudioBuffer | null> {
  if (variant === Variant.Off) return null;
  if (variant === Variant.Synth) return renderRecipe(RECIPES[id], ctx.sampleRate);
  const url = fileUrl(id, variant);
  if (!url) return null;
  const response = await fetch(url);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

const key = (id: Sfx, variant: string): string => `${id}/${variant}`;
