import type { GameState } from '@/core/types';
import type { LevelDraft } from '@/gen/generator';
import { Difficulty } from '@/player/difficulty';
import { newModel, type PlayerModel, MODEL_VERSION } from '@/player/model';
import { initialThreeStars } from '@/player/stars';
import { loadJson, saveText } from '@/platform/platform';
import type { AttemptRecord } from '@/telemetry/attempt';
import { timed } from '@/telemetry/perf';

const KEY = 'glimmerfall-save';
const VERSION = 5;

export interface Settings {
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
  /** hide the phone's status and navigation bars */
  fullscreen: boolean;
  /** board size, percent of the space it may take */
  boardSize: number;
  difficulty: Difficulty;
}

/** Board size steps: a big tablet screen otherwise fills edge to edge with huge pieces. */
export const BoardSize = { Min: 60, Max: 100, Step: 10 } as const;

/** An attempt in progress: the game, what replays it, and the numbers its level was finalized with. */
export interface Attempt {
  game: GameState;
  record: AttemptRecord;
  target: number;
  threeStars: number;
}

/** The level being played: as built for the player, failures so far, and the unfinished attempt, if any. */
export interface CurrentLevel {
  /** each attempt is finalized from it for the target win rate of that moment */
  draft: LevelDraft;
  fails: number;
  attempt: Attempt | null;
}

/** What the game has learned about the player. */
export interface PlayerState {
  model: PlayerModel;
  /** how much faster than their twin bot the player finishes, in log units */
  pace: number;
  /** the twin's score quantile that earns this player 3 stars */
  threeStars: number;
}

export interface SaveData {
  version: number;
  /** the player's own seed: their levels differ from everyone else's */
  seed: number;
  /** next level to play */
  level: number;
  /** best stars per level, index = level - 1 */
  stars: number[];
  player: PlayerState;
  settings: Settings;
  current: CurrentLevel | null;
}

export function defaultSave(): SaveData {
  return {
    version: VERSION,
    seed: randomSeed(),
    level: 1,
    stars: [],
    player: { model: newModel(), pace: 0, threeStars: initialThreeStars() },
    settings: {
      sound: true,
      haptics: true,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      fullscreen: true,
      boardSize: BoardSize.Max,
      difficulty: Difficulty.Normal,
    },
    current: null,
  };
}

export async function loadSave(): Promise<SaveData> {
  const data = await loadJson<SaveData>(KEY);
  if (!data) return defaultSave();
  const defaults = defaultSave();
  // Settings merge one level deeper: a setting added later gets its default in an older save.
  const settings = { ...defaults.settings, ...data.settings };
  if (data.version < VERSION) {
    // Before v3 the bars stayed visible by default; v3 turned fullscreen on for everyone.
    if (data.version < 3) settings.fullscreen = true;
    // v4 built levels per player, v5 learns the player as a bot: progress, stars, settings and the player's
    // seed stay; what was learned about the player under the old model, and the level in progress, start over.
    return { ...defaults, seed: data.version === 4 ? data.seed : defaults.seed, level: data.level, stars: data.stars, settings };
  }
  if (data.version !== VERSION) return defaults;
  // Player fields merge too: one added later starts from its default; a model of another version starts over.
  const player = { ...defaults.player, ...data.player };
  if (player.model.version !== MODEL_VERSION) player.model = newModel();
  return { ...defaults, ...data, player, settings };
}

/** Writes are serialized so a slow write never lands after a newer one. */
let queue: Promise<void> = Promise.resolve();

export function persist(data: SaveData): void {
  const text = timed('persist', () => JSON.stringify(data));
  queue = queue.then(() => saveText(KEY, text)).catch(() => undefined);
}

/** A random 32-bit seed, unsigned. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
