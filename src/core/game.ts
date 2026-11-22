import { cellAt, indexOf, isAdjacent, isMovable, newPiece, randomFreeColor, swapPieces } from '@/core/board';
import { hasMove, isValidSwap, shuffleBoard } from '@/core/moves';
import { convertForFinale, lightAll, resolveStep, type Tally } from '@/core/resolve';
import {
  type Board,
  type Booster,
  type Cell,
  type GameEvent,
  type GameState,
  type LevelDef,
  type Objective,
  ObjectiveKind,
  type Pos,
  Special,
  type SwapEvent,
} from '@/core/types';

export const EXTRA_MOVES = 5;
/** cap on finale and last-chance lighting rounds: cascades can keep creating specials */
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
    strikes: 0,
    cascade: 0,
    finale: 0,
    fuse: [],
    lastChance: false,
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
 * A booster can be aimed: the board is calm, no cascade running, and the player may act, or the level was just
 * lost for want of moves. Out of moves and goals left is not over while a booster can still finish the job.
 */
export function canStrike(state: GameState): boolean {
  return state.cascade === 0 && (canAct(state) || canRescue(state));
}

/** Lost with every move spent, the board calm: a booster may still finish the goals (a stuck board may not). */
export function canRescue(state: GameState): boolean {
  return state.status === 'lost' && state.movesLeft === 0 && state.pending === null && state.cascade === 0;
}

/**
 * Aims a booster at cell `at`: it goes off in the next step and costs no move.
 * A strike on a level lost for want of moves plays it on: the board then rests won, or lost again.
 * Whether the player has one is up to the caller: the saved stock lives outside the level.
 */
export function strike(state: GameState, booster: Booster, at: Pos): boolean {
  if (!canStrike(state) || !cellAt(state.board, at.r, at.c)) return false;
  if (state.status === 'lost') state.status = 'playing';
  state.pending = { booster, at: indexOf(state.board, at.r, at.c) };
  state.strikes++;
  return true;
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
 * `cascade` counts the steps of one chain, finale included: it drives the score multiplier, praise and playback speed.
 */
export function advance(state: GameState): GameEvent[] | null {
  const { board, pending } = state;
  const fuse = (state.fuse ??= []);
  const level = pending ? 0 : state.cascade;
  state.pending = null;
  // Once the moves are spent, nothing new appears: cascades, the last chance and the finale clear matches
  // without leaving specials. Only the player's own swap still makes one.
  const specials = state.movesLeft > 0;
  let step = resolveStep(board, pending, level, fuse, specials);
  const events: GameEvent[] = [];
  if (!step && state.finale > 0) {
    // Finale and last chance: every special left on the calm board is lit; they go off one per step.
    state.finale--;
    const pieces = lightAll(board, fuse);
    if (pieces.length > 0) {
      events.push({ type: 'light', pieces });
      step = resolveStep(board, null, level, fuse, specials);
    } else {
      state.finale = 0;
    }
  }
  if (step) {
    state.cascade = level + 1;
    applyTally(state, step.tally);
    // The last chance runs on the finale rounds too: its specials can complete the level.
    if (state.status === 'playing' && isComplete(state)) state.status = 'won';
    events.push(...step.events);
    return events;
  }
  // A won chain is not over: the finale picks it up at this depth, so its pace and multiplier run on without a seam.
  if (state.status === 'won') return null;
  state.cascade = 0;
  if (state.status !== 'playing') return null;
  if (state.movesLeft <= 0) {
    const chance = lastChance(state);
    if (chance) return chance;
    state.status = 'lost';
    return null;
  }
  if (hasMove(board)) return null;
  const pieces = shuffleBoard(board);
  // Crates and chains can wall off the refill; when no arrangement of what is left has a move, the level is lost.
  if (!hasMove(board)) state.status = 'lost';
  return [{ type: 'shuffle', pieces }];
}

/**
 * Out of moves with goals left: the specials the player built and left on the board are lit and go off one by one.
 * It adds nothing: with no moves left, its cascades create no specials. A special hit by a blast still goes off.
 * Without specials there is no last chance and the level is lost. Once per level.
 * The bot plays by the same rule, so calibration already prices it into the move count.
 */
function lastChance(state: GameState): GameEvent[] | null {
  if (state.lastChance) return null;
  state.lastChance = true;
  if (!state.board.cells.some((c) => c.piece && c.piece.special !== Special.None)) return null;
  state.finale = 1;
  return [{ type: 'lastChance' }];
}

/** Makes a move and runs the board to rest at once, without playback (bot, tests). */
export function playMove(state: GameState, a: Pos, b: Pos): boolean {
  const valid = makeMove(state, a, b)?.valid ?? false;
  while (advance(state)) continue;
  return valid;
}

/**
 * Remaining moves become line specials; the following steps light them and set them off one by one,
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
