import { goalsOf, type MoveOptions, moveOptions } from '@/bot/evaluate';
import { posOf } from '@/core/board';
import { advance, createGame, playMove, startFinale } from '@/core/game';
import { findMoves, type Move } from '@/core/moves';
import { random, randInt, type RngHolder } from '@/core/rng';
import { type GameState, type LevelDef, type Pos } from '@/core/types';

/**
 * How a player picks moves. `precision` sharpens the choice towards the best value: 0 picks at random,
 * Infinity always takes the best. `bonus` is how much the specials a move creates or combines count.
 */
export interface BotStyle {
  precision: number;
  bonus: number;
}

/** Plays the best move by value every time and loves specials: the ceiling a level is checked against. */
export const STRONG_BOT: BotStyle = { precision: Infinity, bonus: 1.5 };
/** Taps any valid move. */
export const RANDOM_BOT: BotStyle = { precision: 0, bonus: 0 };

export interface SimResult {
  /** moves needed to complete every goal by play, or null when the moves ran out: a level with at least that many is won */
  needed: number | null;
  /** score when the goals were complete, or at the end */
  score: number;
  /** score the finale adds per move left, measured on a won run when asked for; 0 otherwise */
  finale: number;
  /**
   * Move counts up to `needed` at which a level ending right there is still won, with the final score: [moves, score].
   * Each holds for that exact count only: the last move's cascade makes no specials and the last chance fires,
   * while with more moves the game plays on and may spend its specials.
   */
  chances: [number, number][];
}

export interface SimOptions {
  /** measure the finale on a won run */
  finale?: boolean;
  /** play every move up to this count once more as the last one; 0 skips that, the costly part of a run */
  chancesUpTo?: number;
}

/** Below this share of every goal, one last move and a volley of specials cannot finish the level: the check is skipped. */
const LAST_CHANCE_REACH = 0.5;
/** Moves left over when the finale is measured; below the finale's conversion cap. */
const FINALE_PROBE = 6;

let weights = new Float64Array(64);

/** Index of the chosen option: a softmax over the values, sharpened by precision. */
export function pickMove(o: MoveOptions, style: BotStyle, rng: RngHolder): number {
  const n = o.moves.length;
  if (weights.length < n) weights = new Float64Array(n * 2);
  let best = 0;
  let max = -Infinity;
  for (let m = 0; m < n; m++) {
    const value = o.plain[m] + style.bonus * o.bonus[m];
    weights[m] = value;
    if (value > max) {
      max = value;
      best = m;
    }
  }
  if (style.precision === Infinity) return best;
  let sum = 0;
  for (let m = 0; m < n; m++) {
    weights[m] = Math.exp(style.precision * (weights[m] - max));
    sum += weights[m];
  }
  let roll = random(rng) * sum;
  for (let m = 0; m < n; m++) {
    roll -= weights[m];
    if (roll < 0) return m;
  }
  return n - 1;
}

/** Plays a level to the end with the given style, without playback. */
export function simulate(level: LevelDef, seed: number, maxMoves: number, style: BotStyle, opts: SimOptions = {}): SimResult {
  const game = createGame({ ...level, moves: maxMoves }, seed);
  const rng: RngHolder = { rng: seed ^ 0x5bd1e995 };
  const chances: [number, number][] = [];
  while (game.status === 'playing') {
    const move = chooseMove(game, style, rng);
    if (!move) break;
    const b = game.board;
    const a = posOf(b, move[0]);
    const c = posOf(b, move[1]);
    if (game.movesMade < (opts.chancesUpTo ?? 0)) {
      const score = lastMoveScore(game, a, c);
      if (score !== null) chances.push([game.movesMade + 1, score]);
    }
    playMove(game, a, c);
  }
  if (game.status !== 'won') return { needed: null, score: game.score, finale: 0, chances };
  return { needed: game.movesMade, score: game.score, finale: opts.finale ? finaleValue(game) : 0, chances };
}

function chooseMove(game: GameState, style: BotStyle, rng: RngHolder): Move | null {
  if (style.precision === 0) {
    // A random tapper needs no values: the cheapest bot by far.
    const moves = findMoves(game.board);
    return moves.length > 0 ? moves[randInt(rng, moves.length)] : null;
  }
  const options = moveOptions(game.board, goalsOf(game));
  return options.moves.length > 0 ? options.moves[pickMove(options, style, rng)] : null;
}

/** Score per move left that the finale adds to a won game; finishes the game. */
function finaleValue(game: GameState): number {
  const before = game.score;
  game.movesLeft = FINALE_PROBE;
  startFinale(game);
  while (advance(game)) continue;
  return (game.score - before) / FINALE_PROBE;
}

/**
 * The final score if this move were the level's last, played to the end with the last chance; null when it would lose.
 * Tried only when every goal is at least LAST_CHANCE_REACH done: one move and one volley close a gap, not a level.
 */
function lastMoveScore(game: GameState, a: Pos, b: Pos): number | null {
  if (!game.level.objectives.every((o, k) => game.progress[k] >= o.target * LAST_CHANCE_REACH)) return null;
  const trial: GameState = { ...game, board: structuredClone(game.board), progress: [...game.progress], fuse: [...(game.fuse ?? [])], movesLeft: 1 };
  playMove(trial, a, b);
  return trial.status === 'won' ? trial.score : null;
}
