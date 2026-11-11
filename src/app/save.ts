import type { GameState, LevelDef } from '@/core/types';
import { type DirectorState, newDirector } from '@/difficulty/director';
import { loadJson, saveText } from '@/platform/platform';

const KEY = 'glimmerfall-save';
const VERSION = 2;

export interface Settings {
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
}

/** The level being played: its definition, failures so far, and the unfinished game, if any. */
export interface CurrentLevel {
  def: LevelDef;
  fails: number;
  game: GameState | null;
}

export interface SaveData {
  version: number;
  /** next level to play */
  level: number;
  /** best stars per level, index = level - 1 */
  stars: number[];
  director: DirectorState;
  settings: Settings;
  current: CurrentLevel | null;
}

export function defaultSave(): SaveData {
  return {
    version: VERSION,
    level: 1,
    stars: [],
    director: newDirector(),
    settings: {
      sound: true,
      haptics: true,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    },
    current: null,
  };
}

export async function loadSave(): Promise<SaveData> {
  const data = await loadJson<SaveData>(KEY);
  if (!data) return defaultSave();
  // v1 games predate step-by-step resolution; progress stays, the unfinished attempt restarts.
  if (data.version === 1 && data.current) data.current.game = null;
  if (data.version === 1) data.version = VERSION;
  if (data.version !== VERSION) return defaultSave();
  return { ...defaultSave(), ...data };
}

/** Writes are serialized so a slow write never lands after a newer one. */
let queue: Promise<void> = Promise.resolve();

export function persist(data: SaveData): void {
  const text = JSON.stringify(data);
  queue = queue.then(() => saveText(KEY, text)).catch(() => undefined);
}
