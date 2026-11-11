import { cellAt, indexOf, isAdjacent, isMovable, newPiece, randomFreeColor, swapPieces } from '@/core/board';
import { hasMove, isValidSwap, shuffleBoard } from '@/core/moves';
import { convertForFinale, resolveDetonation, resolveStep, type Tally, type TargetScorer } from '@/core/resolve';
import {
  type Board,
  type Cell,
  type GameEvent,
  type GameState,
  type LevelDef,
  type Objective,
  ObjectiveKind,
  type Pos,
  type SwapEvent,
} from '@/core/types';

export const EXTRA_MOVES = 5;
/** cap on finale detonations: cascades can keep creating specials */
const FINALE_ROUNDS = 20;

export function createBoard(level: LevelDef, seed: number): Board {
  const cells: Cell[] = level.mask.map((m, i) => ({
    exists: m === 1,
    piece: null,
    ice: m === 1 ? level.ice[i] : 0,
    crate: m === 1 ? level.crate[i] : 0,
    chain: m === 1 ? level.chain[i] : 0,
  }));
  const b: Board = {
    rows: level.rows,
    cols: level.cols,
    colors: level.colors,
    cells,
    nextId: 1,
    rng: seed,
    bias: level.assistBias,
  };
  fillBoard(b);
  return b;
}

/** Fills every free cell without ready matches; refills until at least one move exists. */
function fillBoard(b: Board): void {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const cell of b.cells) cell.piece = null;
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        const cell = b.cells[indexOf(b, r, c)];
        if (cell.exists && cell.crate === 0) cell.piece = newPiece(b, randomFreeColor(b, r, c));
      }
    }
    if (hasMove(b)) return;
  }
}

/** `seed` picks the starting board: the level's layout and goals stay, the gems differ per attempt. */
export function createGame(level: LevelDef, seed: number): GameState {
  return {
    level,
    board: createBoard(level, seed),
    movesLeft: level.moves,
    movesMade: 0,
    score: 0,
    progress: level.objectives.map(() => 0),
    extraMovesUsed: false,
    status: 'playing',
    pending: null,
    cascade: 0,
    finale: 0,
  };
}

/** The player may swap now: the level runs, moves remain, and no earlier swap still waits for its step. */
export function canAct(state: GameState): boolean {
  return state.status === 'playing' && state.movesLeft > 0 && state.pending === null;
}

export function canSwap(state: GameState, a: Pos, b: Pos): boolean {
  if (!canAct(state) || !isAdjacent(a, b)) return false;
  const ca = cellAt(state.board, a.r, a.c);
  const cb = cellAt(state.board, b.r, b.c);
  return ca !== null && cb !== null && isMovable(ca) && isMovable(cb);
}

/**
 * Player swaps piece `a` onto `b`, also in the middle of a cascade.
 * A valid swap costs a move and waits as `pending` for the next step; an invalid one only bounces.
 */
export function makeMove(state: GameState, a: Pos, b: Pos): SwapEvent | null {
  if (!canSwap(state, a, b)) return null;
  const board = state.board;
  const from = indexOf(board, a.r, a.c);
  const to = indexOf(board, b.r, b.c);
  const valid = isValidSwap(board, from, to);
  if (valid) {
    swapPieces(board, from, to);
    state.pending = { from, to };
    state.movesLeft--;
    state.movesMade++;
  }
  return { type: 'swap', a, b, valid };
}

/**
 * Advances the board by one step and applies its gains right away, so goals count up during a cascade.
 * Null once the board rests; that is when a level without moves is lost.
 */
export function advance(state: GameState): GameEvent[] | null {
  const { board, pending } = state;
  const level = pending ? 0 : state.cascade;
  state.pending = null;
  const step = resolveStep(board, pending, level, scorerFor(state));
  if (step) {
    state.cascade = level + 1;
    applyTally(state, step.tally);
    if (state.status === 'playing' && isComplete(state)) state.status = 'won';
    return step.events;
  }
  if (state.finale > 0) {
    const round = FINALE_ROUNDS - state.finale;
    state.finale--;
    const blast = resolveDetonation(board, round, scorerFor(state));
    if (blast) {
      state.cascade = round + 1;
      applyTally(state, blast.tally);
      return blast.events;
    }
    state.finale = 0;
  }
  state.cascade = 0;
  if (state.status !== 'playing') return null;
  if (state.movesLeft <= 0) {
    state.status = 'lost';
    return null;
  }
  return hasMove(board) ? null : [{ type: 'shuffle', pieces: shuffleBoard(board) }];
}

/** Makes a move and runs the board to rest at once, without playback (bot, tests). */
export function playMove(state: GameState, a: Pos, b: Pos): boolean {
  const valid = makeMove(state, a, b)?.valid ?? false;
  while (advance(state)) continue;
  return valid;
}

/**
 * Remaining moves become line specials; the following steps fire them round by round,
 * so the score grows live like in any cascade. Call once after a win, at rest.
 */
export function startFinale(state: GameState): GameEvent[] {
  const pieces = convertForFinale(state.board, state.movesLeft);
  state.movesLeft = 0;
  state.finale = FINALE_ROUNDS;
  return pieces.length > 0 ? [{ type: 'transform', pieces }] : [];
}

export function addExtraMoves(state: GameState): void {
  state.movesLeft += EXTRA_MOVES;
  state.extraMovesUsed = true;
  state.status = 'playing';
}

export function isComplete(state: GameState): boolean {
  return state.level.objectives.every((o, k) => state.progress[k] >= o.target);
}

export function starsFor(state: GameState): number {
  if (state.status !== 'won') return 0;
  const [, two, three] = state.level.stars;
  return state.score >= three ? 3 : state.score >= two ? 2 : 1;
}

function applyTally(state: GameState, tally: Tally): void {
  state.score += tally.score;
  state.level.objectives.forEach((o, k) => {
    const value = o.kind === ObjectiveKind.Score ? state.score : state.progress[k] + objectiveGain(o, tally);
    state.progress[k] = Math.min(o.target, value);
  });
}

function objectiveGain(o: Objective, tally: Tally): number {
  switch (o.kind) {
    case ObjectiveKind.Score:
      return 0;
    case ObjectiveKind.Collect:
      return tally.collected[o.color];
    case ObjectiveKind.Ice:
      return tally.ice;
    case ObjectiveKind.Crate:
      return tally.crate;
  }
}

/** Sparks fly to what the objectives need: crates, ice, wanted colors. */
export function scorerFor(state: GameState): TargetScorer {
  const wanted = new Set(state.level.objectives.filter((o) => o.kind === ObjectiveKind.Collect).map((o) => o.color));
  return (b, i) => {
    const cell = b.cells[i];
    let score = 0;
    if (cell.crate > 0) score += 3;
    if (cell.ice > 0) score += 2 + cell.ice;
    if (cell.chain > 0) score += 1;
    if (cell.piece && wanted.has(cell.piece.color)) score += 2;
    return score;
  };
}
