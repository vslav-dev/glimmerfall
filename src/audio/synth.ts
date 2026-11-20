/**
 * Every sound the game plays, and its synthesized placeholder: one of the variants to pick from (see sounds.ts).
 */

export const Sfx = {
  Button: 'button',
  /** a special on the calm board lights up to go off (last chance, finale) */
  Light: 'light',
  Swap: 'swap',
  SwapFail: 'swap-fail',
  Match: 'match',
  /** a match made a special */
  Create: 'create',
  /** finale: the moves left turn into specials */
  Transform: 'transform',
  LastChance: 'last-chance',
  Line: 'line',
  Bomb: 'bomb',
  Prism: 'prism',
  Spark: 'spark',
  Ice: 'ice',
  Crate: 'crate',
  Chain: 'chain',
  Shuffle: 'shuffle',
  Star: 'star',
  Win: 'win',
  Lose: 'lose',
} as const;
export type Sfx = (typeof Sfx)[keyof typeof Sfx];

interface ToneOptions {
  type?: OscillatorType;
  from: number;
  to?: number;
  at?: number;
  duration: number;
  gain?: number;
  attack?: number;
}

interface NoiseOptions {
  filter: BiquadFilterType;
  from: number;
  to?: number;
  at?: number;
  duration: number;
  gain?: number;
  q?: number;
}

type Recipe = { duration: number; build: (ctx: OfflineAudioContext) => void };

function tone(ctx: OfflineAudioContext, o: ToneOptions): void {
  const at = o.at ?? 0;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.from, at);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + o.duration);
  const peak = o.gain ?? 0.3;
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(peak, at + (o.attack ?? 0.005));
  amp.gain.exponentialRampToValueAtTime(0.0001, at + o.duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + o.duration + 0.02);
}

function noise(ctx: OfflineAudioContext, o: NoiseOptions): void {
  const at = o.at ?? 0;
  const length = Math.ceil(ctx.sampleRate * o.duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = o.filter;
  filter.Q.value = o.q ?? 1;
  filter.frequency.setValueAtTime(o.from, at);
  if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, at + o.duration);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(o.gain ?? 0.3, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + o.duration);
  src.connect(filter).connect(amp).connect(ctx.destination);
  src.start(at);
}

function notes(ctx: OfflineAudioContext, freqs: number[], step: number, length: number, gain: number, type: OscillatorType = 'sine'): void {
  freqs.forEach((f, i) => {
    tone(ctx, { type, from: f, at: i * step, duration: length, gain });
    tone(ctx, { from: f * 2, at: i * step, duration: length * 0.6, gain: gain * 0.25 });
  });
}

const create: Recipe = {
  duration: 0.35,
  build: (c) => {
    tone(c, { from: 520, to: 1040, duration: 0.22, gain: 0.25 });
    notes(c, [1568, 2093], 0.08, 0.2, 0.08);
  },
};

export const RECIPES: Record<Sfx, Recipe> = {
  [Sfx.Button]: { duration: 0.08, build: (c) => tone(c, { from: 900, to: 700, duration: 0.07, gain: 0.2 }) },
  [Sfx.Light]: { duration: 0.06, build: (c) => tone(c, { from: 1300, to: 1500, duration: 0.05, gain: 0.12 }) },
  [Sfx.Swap]: {
    duration: 0.12,
    build: (c) => {
      tone(c, { type: 'triangle', from: 420, to: 640, duration: 0.1, gain: 0.22 });
      noise(c, { filter: 'highpass', from: 3000, duration: 0.06, gain: 0.05 });
    },
  },
  [Sfx.SwapFail]: {
    duration: 0.25,
    build: (c) => {
      tone(c, { type: 'triangle', from: 320, to: 220, duration: 0.1, gain: 0.25 });
      tone(c, { type: 'triangle', from: 260, to: 170, at: 0.11, duration: 0.12, gain: 0.22 });
    },
  },
  [Sfx.Match]: {
    duration: 0.22,
    build: (c) => {
      tone(c, { from: 660, to: 990, duration: 0.16, gain: 0.3 });
      tone(c, { type: 'triangle', from: 1320, to: 1980, duration: 0.12, gain: 0.08 });
    },
  },
  [Sfx.Create]: create,
  [Sfx.Transform]: create,
  [Sfx.LastChance]: create,
  [Sfx.Line]: {
    duration: 0.35,
    build: (c) => {
      noise(c, { filter: 'bandpass', from: 1500, to: 7000, duration: 0.3, gain: 0.35, q: 2 });
      tone(c, { type: 'sawtooth', from: 220, to: 1400, duration: 0.25, gain: 0.08 });
    },
  },
  [Sfx.Bomb]: {
    duration: 0.6,
    build: (c) => {
      noise(c, { filter: 'lowpass', from: 1200, to: 80, duration: 0.55, gain: 0.6 });
      tone(c, { from: 140, to: 40, duration: 0.45, gain: 0.5 });
    },
  },
  [Sfx.Prism]: {
    duration: 0.7,
    build: (c) => {
      notes(c, [660, 880, 1100, 1320, 1760], 0.06, 0.35, 0.16);
      noise(c, { filter: 'highpass', from: 5000, duration: 0.5, gain: 0.08 });
    },
  },
  [Sfx.Spark]: {
    duration: 0.25,
    build: (c) => {
      tone(c, { from: 1200, to: 2600, duration: 0.18, gain: 0.18 });
      tone(c, { from: 1800, to: 3200, at: 0.05, duration: 0.15, gain: 0.1 });
    },
  },
  [Sfx.Ice]: {
    duration: 0.2,
    build: (c) => {
      noise(c, { filter: 'highpass', from: 3500, duration: 0.14, gain: 0.3 });
      tone(c, { from: 2400, to: 1800, duration: 0.1, gain: 0.08 });
    },
  },
  [Sfx.Crate]: {
    duration: 0.25,
    build: (c) => {
      noise(c, { filter: 'lowpass', from: 700, to: 250, duration: 0.2, gain: 0.45 });
      tone(c, { type: 'triangle', from: 190, to: 110, duration: 0.15, gain: 0.25 });
    },
  },
  [Sfx.Chain]: {
    duration: 0.25,
    build: (c) => {
      tone(c, { type: 'square', from: 1250, duration: 0.07, gain: 0.06 });
      tone(c, { type: 'square', from: 1580, at: 0.08, duration: 0.1, gain: 0.05 });
    },
  },
  [Sfx.Shuffle]: {
    duration: 0.5,
    build: (c) => noise(c, { filter: 'bandpass', from: 600, to: 3000, duration: 0.45, gain: 0.25, q: 3 }),
  },
  [Sfx.Star]: { duration: 0.5, build: (c) => notes(c, [1047, 1568], 0.03, 0.45, 0.18) },
  [Sfx.Win]: { duration: 1.0, build: (c) => notes(c, [523, 659, 784, 1047], 0.12, 0.5, 0.2) },
  [Sfx.Lose]: { duration: 0.9, build: (c) => notes(c, [440, 392, 330], 0.18, 0.45, 0.18, 'triangle') },
};

export async function renderRecipe(recipe: Recipe, sampleRate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * recipe.duration), sampleRate);
  recipe.build(ctx);
  return ctx.startRendering();
}
