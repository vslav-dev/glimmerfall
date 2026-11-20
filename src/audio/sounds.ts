import { Sfx } from '@/audio/synth';

/** Recorded variants, built by tools/sfx.sh: sfx/<sound>/<NN-name>.m4a. Only URLs here; a file loads when picked. */
const FILES = import.meta.glob<string>('./sfx/*/*.m4a', { eager: true, query: '?url', import: 'default' });

/** The synthesized placeholder and silence are variants too: recordings compare against both. */
export const Variant = { Synth: 'synth', Off: 'off' } as const;

/** The variant picked for each sound; a sound missing here plays its default. */
export type SoundChoice = Partial<Record<Sfx, string>>;

/** Variants of each sound in menu order: recordings by number, then the synth, then silence. */
export const VARIANTS = Object.fromEntries(
  Object.values(Sfx).map((id) => [id, [...recordings(id), Variant.Synth, Variant.Off]]),
) as Record<Sfx, string[]>;

function recordings(id: Sfx): string[] {
  const dir = `./sfx/${id}/`;
  return Object.keys(FILES)
    .filter((path) => path.startsWith(dir))
    .map((path) => path.slice(dir.length, -'.m4a'.length))
    .sort();
}

export function fileUrl(id: Sfx, variant: string): string | undefined {
  return FILES[`./sfx/${id}/${variant}.m4a`];
}

/** Picked by ear on the phone (20.11.2026): what plays until the sound menu picks otherwise. */
const DEFAULTS: Record<Sfx, string> = {
  [Sfx.Button]: '07-tap',
  [Sfx.Light]: '01-pluck',
  [Sfx.Swap]: Variant.Off,
  [Sfx.SwapFail]: Variant.Synth,
  [Sfx.Match]: '01-chips',
  [Sfx.Create]: Variant.Off,
  [Sfx.Transform]: '05-three-tone',
  [Sfx.LastChance]: '07-low-tone',
  [Sfx.Line]: '05-laser',
  [Sfx.Bomb]: '01-punch',
  [Sfx.Prism]: '04-glass-ring',
  [Sfx.Spark]: '08-glass',
  [Sfx.Ice]: '01-glass-light',
  [Sfx.Crate]: '01-wood-light',
  [Sfx.Chain]: '04-metal-heavy',
  [Sfx.Shuffle]: '01-card-fan',
  [Sfx.Star]: '02-glass',
  [Sfx.Win]: '10-confirm',
  [Sfx.Lose]: '10-error',
};

/** The variant a sound plays: the picked one, else the default; the first one when that is gone too. */
export function chosen(choice: SoundChoice, id: Sfx): string {
  return [choice[id], DEFAULTS[id]].find((v) => v !== undefined && VARIANTS[id].includes(v)) ?? VARIANTS[id][0];
}
