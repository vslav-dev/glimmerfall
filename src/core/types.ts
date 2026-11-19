export const Special = {
  None: 0,
  LineH: 1,
  LineV: 2,
  Bomb: 3,
  Spark: 4,
  Prism: 5,
} as const;
export type Special = (typeof Special)[keyof typeof Special];

/** Prism pieces have no color: they match nothing and take the color of what they are swapped with. */
export const NO_COLOR = -1;
export const MAX_COLORS = 6;

export interface Piece {
  id: number;
  color: number;
  special: Special;
}

export interface Cell {
  /** false = hole in the board shape */
  exists: boolean;
  piece: Piece | null;
  /** ice layers under the piece */
  ice: number;
  /** crate durability; a cell with a crate holds no piece */
  crate: number;
  /** chain layers; a chained piece cannot move */
  chain: number;
}

export interface Pos {
  r: number;
  c: number;
}

/** Plain, JSON-serializable board. Owns its RNG state and id counter so a saved board resumes exactly. */
export interface Board {
  rows: number;
  cols: number;
  colors: number;
  cells: Cell[];
  nextId: number;
  rng: number;
}

export const ObjectiveKind = {
  Score: 'score',
  Collect: 'collect',
  Ice: 'ice',
  Crate: 'crate',
} as const;
export type ObjectiveKind = (typeof ObjectiveKind)[keyof typeof ObjectiveKind];

export interface Objective {
  kind: ObjectiveKind;
  target: number;
  /** only for Collect */
  color: number;
}

export const LevelKind = {
  Normal: 'normal',
  Hard: 'hard',
  Relief: 'relief',
  Intro: 'intro',
} as const;
export type LevelKind = (typeof LevelKind)[keyof typeof LevelKind];

export const Mechanic = {
  Ice: 'ice',
  Crate: 'crate',
  Chain: 'chain',
  DoubleGoal: 'double-goal',
} as const;
export type Mechanic = (typeof Mechanic)[keyof typeof Mechanic];

export interface LevelDef {
  number: number;
  rows: number;
  cols: number;
  /** per cell, row-major: 1 = cell exists */
  mask: number[];
  ice: number[];
  crate: number[];
  chain: number[];
  colors: number;
  moves: number;
  objectives: Objective[];
  /** score thresholds for 1, 2, 3 stars */
  stars: [number, number, number];
  kind: LevelKind;
  intro: Mechanic | null;
  /** the twin bot's win rate at these moves: what the level was calibrated for, and the prediction the player is measured against */
  targetWinRate: number;
}

export const BlastKind = {
  Row: 'row',
  Col: 'col',
  Bomb: 'bomb',
  Prism: 'prism',
  Spark: 'spark',
} as const;
export type BlastKind = (typeof BlastKind)[keyof typeof BlastKind];

export interface Blast {
  kind: BlastKind;
  origin: Pos;
  cells: Pos[];
  /** playback order inside a clear step */
  order: number;
  /** spark flight target */
  target: Pos | null;
  /** prism: color it wipes */
  color: number;
}

export interface RemovedPiece {
  id: number;
  pos: Pos;
  color: number;
  order: number;
  /** id of the special piece this one merged into, or -1 */
  mergeInto: number;
}

export interface CreatedPiece {
  pos: Pos;
  piece: Piece;
}

/** A special that was hit and now waits its turn to go off. */
export interface LitPiece {
  id: number;
  pos: Pos;
  order: number;
}

export interface LayerChange {
  pos: Pos;
  ice: number;
  crate: number;
  chain: number;
  order: number;
}

export interface ScorePopup {
  /** fractional board coordinates of the popup center */
  r: number;
  c: number;
  value: number;
  order: number;
}

export interface FallMove {
  piece: Piece;
  /** first point is the start; spawned pieces start above the board (negative or virtual rows) */
  path: Pos[];
  spawned: boolean;
}

export type GameEvent =
  | { type: 'swap'; a: Pos; b: Pos; valid: boolean }
  | {
      type: 'clear';
      cascade: number;
      removed: RemovedPiece[];
      created: CreatedPiece[];
      blasts: Blast[];
      layers: LayerChange[];
      popups: ScorePopup[];
      /** specials this step lit: they stay on the board and go off one per step from the next one on */
      lit: LitPiece[];
    }
  | { type: 'transform'; pieces: CreatedPiece[] }
  | { type: 'fall'; moves: FallMove[] }
  | { type: 'shuffle'; pieces: CreatedPiece[] }
  /** finale and last chance: every special left on the calm board is lit */
  | { type: 'light'; pieces: LitPiece[] }
  /** out of moves with goals left: the specials still on the board are about to fire once */
  | { type: 'lastChance' };

export type SwapEvent = Extract<GameEvent, { type: 'swap' }>;

export type GameStatus = 'playing' | 'won' | 'lost';

/** A valid swap already made on the board, waiting for the next step to clear it. Cell indices. */
export interface PendingSwap {
  from: number;
  /** where the moved piece now is; a created special or a combo centers here */
  to: number;
}

/** Everything that changes during a level. JSON-serializable for save/resume. */
export interface GameState {
  level: LevelDef;
  board: Board;
  movesLeft: number;
  movesMade: number;
  score: number;
  /** progress per objective, same order as level.objectives */
  progress: number[];
  extraMovesUsed: boolean;
  status: GameStatus;
  pending: PendingSwap | null;
  /** cascade depth of the next step: drives the score multiplier and praise */
  cascade: number;
  /** finale lighting rounds left; 0 outside the finale and the last chance */
  finale: number;
  /**
   * Ids of lit specials, in firing order: a hit special does not go off at once but one per step,
   * with the board refilling in between (absent in saves made before it existed).
   */
  fuse?: number[];
  /** the one last-chance detonation is spent (absent in saves made before it existed) */
  lastChance?: boolean;
}
