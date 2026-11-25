import { type Charges, EARN, newCharges } from '@/app/boosters';
import { DEFAULTS_ID, type SoundChoice } from '@/audio/sounds';
import { type GameState, Mechanic } from '@/core/types';
import type { LevelDraft } from '@/gen/generator';
import { introducedBefore } from '@/gen/plan';
import { Difficulty } from '@/player/difficulty';
import { newModel, type PlayerModel, upgradeModel } from '@/player/model';
import { initialThreeStars } from '@/player/stars';
import { loadJson, saveText } from '@/platform/platform';
import { type AttemptRecord, newRecord } from '@/telemetry/attempt';
import { timed } from '@/telemetry/perf';
import type { FxChoice } from '@/view/fx/switches';

const KEY = 'glimmerfall-save';
const VERSION = 8;
/** the meteor's unit of charge in the saves that counted it differently */
const OLD_METEOR_UNITS: Partial<Record<number, number>> = { 6: 3, 7: 20 };

export interface Settings {
  sound: boolean;
  haptics: boolean;
  /** hide the phone's status and navigation bars */
  fullscreen: boolean;
  /** board size, percent of the space it may take */
  boardSize: number;
  difficulty: Difficulty;
  /** debug sound menu: the variant picked for each sound */
  sounds: SoundChoice;
  /** the sound defaults those picks were made over */
  soundDefaults: string;
  /** debug effects menu: effects switched off */
  effects: FxChoice;
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
  /** boosters saved up across levels */
  boosters: Charges;
  /** mechanics the player has had explained: a level with one not met yet opens with its explanation */
  met: Mechanic[];
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
    boosters: newCharges(),
    met: [],
    settings: {
      sound: true,
      haptics: true,
      fullscreen: true,
      boardSize: BoardSize.Max,
      difficulty: Difficulty.Normal,
      sounds: {},
      soundDefaults: DEFAULTS_ID,
      effects: {},
    },
    current: null,
  };
}

export async function loadSave(): Promise<SaveData> {
  let data = await loadJson<SaveData>(KEY);
  if (!data) return defaultSave();
  // The meteor's charge was counted in thirds up to v6, in twentieths in v7, in eightieths since v8:
  // an older save keeps its share of the way and all the rest.
  const meteorUnit = OLD_METEOR_UNITS[data.version];
  if (meteorUnit) {
    const meteor = Math.round((data.boosters.meteor * EARN.meteor.unit) / meteorUnit);
    data = { ...data, version: VERSION, boosters: { ...data.boosters, meteor } };
  }
  const defaults = defaultSave();
  // `met` came with the pearls: an older save met every mechanic introduced below its level, the pearls aside.
  const met = data.met ?? introducedBefore(data.level).filter((m) => m !== Mechanic.Pearl);
  // Settings merge one level deeper: a setting added later gets its default in an older save.
  const settings = { ...defaults.settings, ...data.settings };
  // New sound defaults reach everyone: picks made over older ones (or before they were tracked) start over.
  if (data.settings.soundDefaults !== DEFAULTS_ID) {
    settings.sounds = {};
    settings.soundDefaults = DEFAULTS_ID;
  }
  if (data.version < VERSION) {
    // Before v3 the bars stayed visible by default; v3 turned fullscreen on for everyone.
    if (data.version < 3) settings.fullscreen = true;
    // v4 built levels per player, v5 learns the player as a bot, v6 swapped the spark for boosters: progress, stars,
    // settings and the player's seed stay. The level in progress starts over (it may hold sparks), and so does
    // what was learned about the player: the moves it learned from are read differently now.
    const player = data.version === 5 ? { ...defaults.player, pace: data.player.pace, threeStars: data.player.threeStars } : defaults.player;
    return { ...defaults, seed: data.version >= 4 ? data.seed : defaults.seed, level: data.level, stars: data.stars, player, met, settings };
  }
  if (data.version !== VERSION) return defaults;
  // Player fields merge too: one added later starts from its default; a model of another version is carried over or starts over.
  const player = { ...defaults.player, ...data.player };
  player.model = upgradeModel(player.model);
  // Record fields merge as well: an attempt saved before a field was added gets its default.
  const attempt = data.current?.attempt;
  if (attempt) attempt.record = { ...newRecord(attempt.record.board), ...attempt.record };
  return { ...defaults, ...data, player, met, settings };
}

/** Writes are serialized so a slow write never lands after a newer one. */
let queue: Promise<void> = Promise.resolve();

export function persist(data: SaveData): void {
  const text = timed('persist', () => JSON.stringify(data));
  queue = queue.then(() => saveText(KEY, text)).catch(() => undefined);
}

/** Resolves once every save asked for so far is written: before a reload, nothing may be lost. */
export function flushSaves(): Promise<void> {
  return queue;
}

/** A random 32-bit seed, unsigned. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
