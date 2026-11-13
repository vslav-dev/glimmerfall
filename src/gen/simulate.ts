import { neighbors4, posOf, swapPieces } from '@/core/board';
import { advance, createGame, playMove } from '@/core/game';
import { findGroups } from '@/core/matches';
import { findMoves, isComboPair, type Move } from '@/core/moves';
import { random, type RngHolder } from '@/core/rng';
import { type Board, type GameState, type LevelDef, ObjectiveKind, Special } from '@/core/types';

export interface SimResult {
  /** moves the bot needed to complete all objectives, or null when it ran out */
  movesNeeded: number | null;
  /** score at completion (or at the end) */
  score: number;
  /** score after each move, for score objectives */
  scoreAt: number[];
}

const LAST_CHANCE_REACH = 0.5;

const SPECIAL_VALUE: Record<Special, number> = {
  [Special.None]: 0,
  [Special.LineH]: 6,
  [Special.LineV]: 6,
  [Special.Bomb]: 8,
  [Special.Spark]: 5,
  [Special.Prism]: 14,
};

/**
 * A plausible "average player": greedy on the immediate effect of a move, with noise.
 * It does not look at cascades, which keeps it cheap and humanly short-sighted.
 */
export function simulate(level: LevelDef, seed: number, maxMoves: number, noise = 0.6): SimResult {
  const game = createGame({ ...level, moves: maxMoves }, seed);
  const bot: RngHolder = { rng: seed ^ 0x5bd1e995 };
  const scoreAt: number[] = [];
  const wanted = new Set(level.objectives.filter((o) => o.kind === ObjectiveKind.Collect).map((o) => o.color));

  // The earliest move count at which running out of moves would still win through the last chance.
  let chanceWin: number | null = null;
  while (game.status === 'playing') {
    const move = chooseMove(game, wanted, bot, noise);
    if (!move) break;
    const b = game.board;
    playMove(game, posOf(b, move[0]), posOf(b, move[1]));
    scoreAt.push(game.score);
    if (chanceWin === null && game.status === 'playing' && winsByLastChance(game)) chanceWin = game.movesMade;
  }
  const won = game.status === 'won' ? game.movesMade : null;
  return { movesNeeded: chanceWin ?? won, score: game.score, scoreAt };
}

/**
 * Would the specials on the board finish the level if the moves ran out right now?
 * Tried only when every goal is at least LAST_CHANCE_REACH done: one volley of specials closes a gap, not a level.
 */
function winsByLastChance(game: GameState): boolean {
  const near = game.level.objectives.every((o, k) => game.progress[k] >= o.target * LAST_CHANCE_REACH);
  if (!near || !game.board.cells.some((c) => c.piece && c.piece.special !== Special.None)) return false;
  const trial: GameState = { ...game, board: structuredClone(game.board), progress: [...game.progress], fuse: [...(game.fuse ?? [])], movesLeft: 0 };
  while (advance(trial)) continue;
  return trial.status === 'won';
}

function chooseMove(game: GameState, wanted: Set<number>, bot: RngHolder, noise: number): Move | null {
  const b = game.board;
  let best: Move | null = null;
  let bestValue = -Infinity;
  for (const move of findMoves(b)) {
    const value = evaluate(b, move, wanted) * (1 + noise * (random(bot) - 0.5));
    if (value > bestValue) {
      bestValue = value;
      best = move;
    }
  }
  return best;
}

function evaluate(b: Board, [i, j]: Move, wanted: Set<number>): number {
  const pi = b.cells[i].piece!;
  const pj = b.cells[j].piece!;
  if (isComboPair(pi, pj)) return 30 + SPECIAL_VALUE[pi.special] + SPECIAL_VALUE[pj.special];

  swapPieces(b, i, j);
  let value = 0;
  for (const g of findGroups(b, [j, i])) {
    value += g.cells.length + SPECIAL_VALUE[g.special];
    for (const k of g.cells) {
      const cell = b.cells[k];
      if (cell.ice > 0) value += 3;
      if (cell.chain > 0) value += 2;
      if (wanted.has(g.color)) value += 2;
      if (cell.piece && cell.piece.special !== Special.None) value += SPECIAL_VALUE[cell.piece.special];
      for (const n of neighbors4(b, k)) if (b.cells[n].crate > 0) value += 2;
    }
    // Lower matches shake more of the board: a mild, human-like preference.
    value += (Math.floor(g.cells[0] / b.cols) / b.rows) * 1.5;
  }
  swapPieces(b, i, j);
  return value;
}
