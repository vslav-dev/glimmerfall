import { cellAt, indexOf, isAdjacent, isMovable, newPiece, randomFreeColor } from '@/core/board';
import { hasMove } from '@/core/moves';
import { resolveFinale, resolveSwap, type Tally, type TargetScorer } from '@/core/resolve';
import {
  type Board,
  type Cell,
  type GameEvent,
  type GameState,
  type LevelDef,
  type Objective,
  ObjectiveKind,
  type Pos,
} from '@/core/types';

export const EXTRA_MOVES = 5;

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

export function createGame(level: LevelDef, seed = level.seed): GameState {
  return {
    level,
    board: createBoard(level, seed),
    movesLeft: level.moves,
    movesMade: 0,
    score: 0,
    progress: level.objectives.map(() => 0),
    extraMovesUsed: false,
    status: 'playing',
  };
}

export interface MoveResult {
  valid: boolean;
  events: GameEvent[];
}

export function canSwap(state: GameState, a: Pos, b: Pos): boolean {
  if (state.status !== 'playing' || !isAdjacent(a, b)) return false;
  const ca = cellAt(state.board, a.r, a.c);
  const cb = cellAt(state.board, b.r, b.c);
  return ca !== null && cb !== null && isMovable(ca) && isMovable(cb);
}

/** Player swaps piece `a` onto `b`. Invalid swaps cost nothing and only produce a bounce event. */
export function makeMove(state: GameState, a: Pos, b: Pos): MoveResult {
  if (!canSwap(state, a, b)) return { valid: false, events: [] };
  const board = state.board;
  const res = resolveSwap(board, indexOf(board, a.r, a.c), indexOf(board, b.r, b.c), scorerFor(state));
  if (!res.valid) return res;

  state.movesLeft--;
  state.movesMade++;
  applyTally(state, res.tally);
  if (isComplete(state)) state.status = 'won';
  else if (state.movesLeft <= 0) state.status = 'lost';
  return res;
}

/** Remaining moves become fireworks. Call once after a win. */
export function runFinale(state: GameState): GameEvent[] {
  const { events, tally } = resolveFinale(state.board, state.movesLeft, scorerFor(state));
  state.movesLeft = 0;
  applyTally(state, tally);
  return events;
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
