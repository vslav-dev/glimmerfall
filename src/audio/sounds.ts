import { Sfx } from '@/audio/synth';

/** Recorded variants, built by tools/sfx.sh: sfx/<sound>/<NN-name>.m4a. Only URLs here; a file loads when picked. */
const FILES = import.meta.glob<string>('./sfx/*/*.m4a', { eager: true, query: '?url', import: 'default' });

/** The synthesized placeholder and silence are variants too: recordings compare against both. */
export const Variant = { Synth: 'synth', Off: 'off' } as const;

/** The variant picked for each sound; a sound missing here plays its first variant. */
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

/** The variant a sound plays: the picked one, or the first when none is picked or the picked one is gone. */
export function chosen(choice: SoundChoice, id: Sfx): string {
  const variant = choice[id];
  return variant !== undefined && VARIANTS[id].includes(variant) ? variant : VARIANTS[id][0];
}
