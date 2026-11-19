import { swapPieces } from '@/core/board';
import { type GroupScan, newGroupScan, scanGroup } from '@/core/matches';
import { findMoves, isComboPair, type Move } from '@/core/moves';
import { type Board, type GameState, ObjectiveKind, Special } from '@/core/types';

/** The goals still open: what a move is worth depends on them. */
export interface Goals {
  /** one bit per collect color still wanted */
  wanted: number;
  ice: boolean;
  crate: boolean;
}

/**
 * Every move on a calm board with its value in two parts: `plain` is what it clears and how it serves
 * the goals, `bonus` is the specials it creates or sets off together. A style weighs the two.
 * The bots play by these values and the player's style is read against them, so both see the same game.
 */
export interface MoveOptions {
  moves: Move[];
  plain: Float64Array;
  bonus: Float64Array;
}

const SPECIAL_VALUE: Record<Special, number> = {
  [Special.None]: 0,
  [Special.LineH]: 6,
  [Special.LineV]: 6,
  [Special.Bomb]: 8,
  [Special.Spark]: 5,
  [Special.Prism]: 14,
};
const COMBO_PLAIN = 12;
const COMBO_BONUS = 20;
/** A new special next to another one: a combo waiting for the next move. */
const SETUP = 4;
const CHAIN = 2;
const WANTED = 2;
const ICE_GOAL = 3;
const CRATE_GOAL = 3;
/** Layers that are no goal still open the board a little. */
const LAYER = 0.5;
/** Lower matches shake more of the board: a mild, human-like preference. */
const LOW = 1.5;

export function goalsOf(state: GameState): Goals {
  const goals: Goals = { wanted: 0, ice: false, crate: false };
  state.level.objectives.forEach((o, k) => {
    if (state.progress[k] >= o.target) return;
    if (o.kind === ObjectiveKind.Collect) goals.wanted |= 1 << o.color;
    else if (o.kind === ObjectiveKind.Ice) goals.ice = true;
    else if (o.kind === ObjectiveKind.Crate) goals.crate = true;
  });
  return goals;
}

/** One scratch scan per thread: the evaluation runs synchronously, never nested. */
const scan: GroupScan = newGroupScan();

/** Values only the immediate effect of each move; cascades are left to chance, as a human sees them. */
export function moveOptions(b: Board, goals: Goals): MoveOptions {
  const moves = findMoves(b);
  const plain = new Float64Array(moves.length);
  const bonus = new Float64Array(moves.length);
  // Cells counted for the current group carry its stamp: crates next to several matched cells count once.
  const seen = new Int32Array(b.cells.length);
  let stamp = 0;
  for (let m = 0; m < moves.length; m++) {
    const [i, j] = moves[m];
    const pi = b.cells[i].piece!;
    const pj = b.cells[j].piece!;
    if (isComboPair(pi, pj)) {
      plain[m] = COMBO_PLAIN;
      bonus[m] = COMBO_BONUS + SPECIAL_VALUE[pi.special] + SPECIAL_VALUE[pj.special];
      continue;
    }
    swapPieces(b, i, j);
    if (scanGroup(b, i, scan)) valueGroup(b, i, goals, seen, ++stamp, plain, bonus, m);
    if (scanGroup(b, j, scan)) valueGroup(b, j, goals, seen, ++stamp, plain, bonus, m);
    swapPieces(b, i, j);
  }
  return { moves, plain, bonus };
}

/** Adds the value of the scanned group through swapped cell x to option m. */
function valueGroup(b: Board, x: number, goals: Goals, seen: Int32Array, stamp: number, plain: Float64Array, bonus: Float64Array, m: number): void {
  let value = (Math.floor(x / b.cols) / b.rows) * LOW;
  for (let k = 0; k < scan.count; k++) {
    const i = scan.cells[k];
    seen[i] = stamp;
    const cell = b.cells[i];
    // A chained piece only loses its chain: it is not removed, so it collects nothing.
    if (cell.chain > 0) {
      value += CHAIN;
      continue;
    }
    const piece = cell.piece!;
    value += 1 + SPECIAL_VALUE[piece.special];
    if (goals.wanted & (1 << piece.color)) value += WANTED;
    if (cell.ice > 0) value += goals.ice ? ICE_GOAL : LAYER;
  }
  const crate = goals.crate ? CRATE_GOAL : LAYER;
  for (let k = 0; k < scan.count; k++) {
    const i = scan.cells[k];
    const r = Math.floor(i / b.cols);
    const c = i - r * b.cols;
    if (r > 0) value += crateHit(b, i - b.cols, seen, stamp, crate);
    if (r < b.rows - 1) value += crateHit(b, i + b.cols, seen, stamp, crate);
    if (c > 0) value += crateHit(b, i - 1, seen, stamp, crate);
    if (c < b.cols - 1) value += crateHit(b, i + 1, seen, stamp, crate);
  }
  plain[m] += value;

  if (scan.special === Special.None) return;
  const r = Math.floor(x / b.cols);
  const c = x - r * b.cols;
  let extra = SPECIAL_VALUE[scan.special];
  if (r > 0) extra += setup(b, x - b.cols, seen, stamp);
  if (r < b.rows - 1) extra += setup(b, x + b.cols, seen, stamp);
  if (c > 0) extra += setup(b, x - 1, seen, stamp);
  if (c < b.cols - 1) extra += setup(b, x + 1, seen, stamp);
  bonus[m] += extra;
}

/** A crate next to the group cracks once, however many matched cells touch it. */
function crateHit(b: Board, n: number, seen: Int32Array, stamp: number, worth: number): number {
  if (b.cells[n].crate === 0 || seen[n] === stamp) return 0;
  seen[n] = stamp;
  return worth;
}

/** A special next to the new one, and not used up by this match. */
function setup(b: Board, n: number, seen: Int32Array, stamp: number): number {
  const piece = b.cells[n].piece;
  return piece && piece.special !== Special.None && seen[n] !== stamp ? SETUP : 0;
}
