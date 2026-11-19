import { indexOf, posOf } from '@/core/board';
import { advance, createGame, makeMove, startFinale } from '@/core/game';
import type { Board, GameState, LevelDef, Pos } from '@/core/types';
import { GEN_VERSION, type LevelDraft } from '@/gen/generator';
import type { Difficulty } from '@/player/difficulty';
import type { PlayerModel } from '@/player/model';
import { track } from '@/telemetry/telemetry';

/**
 * One attempt as the least that replays it: the game is deterministic, so the starting board seed and
 * the player's moves rebuild every board, cascade and score offline. Each move also keeps when it was made
 * (board steps since the previous move: swaps are allowed mid-cascade), how long the player thought,
 * and whether a hint was showing. Sent as one `attempt` event: a summary always, the moves for a share of players.
 * Swaps that matched nothing are only counted: they show what the player misreads, and change no state.
 */
export interface AttemptRecord {
  /** seed of the starting board */
  board: number;
  /** one packed move each: cell 7 bits, direction 2, hint 1, board steps before it 8, think time 8 (0.1 s) */
  moves: number[];
  /** board steps played since the last move */
  steps: number;
  /** swaps tried that matched nothing */
  bad: number;
}

export const AttemptEnd = {
  Won: 'won',
  Lost: 'lost',
  Restart: 'restart',
} as const;
export type AttemptEnd = (typeof AttemptEnd)[keyof typeof AttemptEnd];

/** Players (by seed) whose attempts carry the moves; the summary comes from everyone. Lowered as the audience grows. */
const REPLAY_PERCENT = 100;
const BYTE = 255;
/** right, down, left, up */
const DIRECTIONS: readonly Pos[] = [
  { r: 0, c: 1 },
  { r: 1, c: 0 },
  { r: 0, c: -1 },
  { r: -1, c: 0 },
];

export function newRecord(board: number): AttemptRecord {
  return { board, moves: [], steps: 0, bad: 0 };
}

/** A board step was played (a clear, a shuffle, the last chance). */
export function recordStep(rec: AttemptRecord): void {
  rec.steps = Math.min(BYTE, rec.steps + 1);
}

/** A valid swap of `a` onto `b`. */
export function recordMove(rec: AttemptRecord, board: Board, a: Pos, b: Pos, hint: boolean, thinkMs: number): void {
  const cell = indexOf(board, a.r, a.c);
  const dir = DIRECTIONS.findIndex((d) => d.r === b.r - a.r && d.c === b.c - a.c);
  const think = Math.min(BYTE, Math.round(thinkMs / 100));
  rec.moves.push(cell | (dir << 7) | ((hint ? 1 : 0) << 9) | (rec.steps << 10) | (think << 18));
  rec.steps = 0;
}

/** Plays the recorded attempt again on its level, through the finale of a win. */
export function replayAttempt(level: LevelDef, rec: Pick<AttemptRecord, 'board' | 'moves'>): GameState {
  const game = createGame(level, rec.board);
  for (const packed of rec.moves) {
    const steps = (packed >>> 10) & BYTE;
    for (let k = 0; k < steps; k++) advance(game);
    const a = posOf(game.board, packed & 127);
    const d = DIRECTIONS[(packed >>> 7) & 3];
    makeMove(game, a, { r: a.r + d.r, c: a.c + d.c });
  }
  while (advance(game)) continue;
  // As in the app: the finale runs only with moves left over.
  if (game.status === 'won' && game.movesLeft > 0) {
    startFinale(game);
    while (advance(game)) continue;
  }
  return game;
}

/** Four little-endian bytes per move, base64. */
export function encodeMoves(moves: number[]): string {
  const bytes = new Uint8Array(new Uint32Array(moves).buffer);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function decodeMoves(text: string): number[] {
  const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  return [...new Uint32Array(bytes.buffer)];
}

export interface AttemptReport {
  draft: LevelDraft;
  game: GameState;
  record: AttemptRecord;
  end: AttemptEnd;
  /** moves left when the attempt ended; for a win, before the finale used them up */
  left: number;
  stars: number;
  fails: number;
  difficulty: Difficulty;
  /** the win rate the attempt was finalized for, before the twin's own rate at the chosen moves */
  target: number;
  /** the 3-star quantile it was finalized with */
  threeStars: number;
  model: PlayerModel;
}

/**
 * Everything that rebuilds the level: the generator that built it, the player seed, number, the twin it was
 * built for, and the exact numbers it was finalized with. Then the twin's prediction, the model as it stood,
 * and how the attempt went. `rules` is the game code that played it: replays need the same.
 */
export function trackAttempt(r: AttemptReport): void {
  const { request, variant } = r.draft;
  const { game } = r;
  const level = game.level;
  track('attempt', {
    gen: r.draft.version,
    rules: GEN_VERSION,
    seed: request.seed,
    n: request.number,
    variant,
    style: request.style,
    pace: request.pace,
    difficulty: r.difficulty,
    fails: r.fails,
    target: r.target,
    threeStars: r.threeStars,
    p: round2(level.targetWinRate),
    model: [round2(r.model.strength), round2(r.model.rank), r.model.moves],
    moves: level.moves,
    board: r.record.board,
    end: r.end,
    made: game.movesMade,
    left: r.left,
    score: game.score,
    stars: r.stars,
    goals: level.objectives.map((o, k) => round2(game.progress[k] / o.target)),
    bad: r.record.bad,
    rec: request.seed % 100 < REPLAY_PERCENT ? encodeMoves(r.record.moves) : null,
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
