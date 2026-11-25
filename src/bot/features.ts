import { swapPieces } from '@/core/board';
import { type GroupScan, newGroupScan, scanGroup } from '@/core/matches';
import { findMoves, isComboPair, type Move } from '@/core/moves';
import { type Board, type GameState, ObjectiveKind, Special } from '@/core/types';

/**
 * What a player can see in a move before making it. Every move on a calm board gets one row of these;
 * a style is a weight per feature, and a move is picked with probability ∝ exp(weights · features).
 * The bots play by them and the player's style is learned from them, so both see the same game.
 * Changing the features changes the meaning of stored weights: bump MODEL_VERSION in the player model.
 */
export const Feature = {
  /** cells the match clears */
  Cells: 0,
  /** of them, cells of a collect color still wanted */
  Wanted: 1,
  /** of them, cells on ice while an ice goal is open */
  Ice: 2,
  /** goal crates next to the match */
  Crate: 3,
  /** chained cells in the match: they lose the chain instead of the piece */
  Chain: 4,
  /** specials the move sets off */
  Used: 5,
  /** the special the match creates */
  Line: 6,
  Bomb: 7,
  Prism: 8,
  /** two specials (or a prism with anything) swapped together */
  Combo: 9,
  /** specials next to the one created: a combo waiting for the next move */
  Setup: 10,
  /** how low the move is, 0 at the top row, 1 at the bottom */
  Low: 11,
  /** cells away from the previous move, capped: where the player is already looking */
  Far: 12,
  /**
   * how much closer the move brings pearls to the bottom while a pearl goal is open, in cells left under them:
   * each cleared cell under a pearl lowers it one, and a pearl swapped moves by the cells under it there and here
   * (down one; sideways onto a shorter column more; up, a step back)
   */
  Pearl: 13,
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];
export const FEATURE_COUNT = 14;
export const FEATURE_NAMES = ['cells', 'wanted', 'ice', 'crate', 'chain', 'used', 'line', 'bomb', 'prism', 'combo', 'setup', 'low', 'far', 'pearl'] as const;

/** Distance cap, and the distance assumed when there is no previous move: a typical one. */
const FAR_CAP = 8;
const FAR_UNKNOWN = 4;

/** The goals still open: what a move is worth depends on them. */
export interface Goals {
  /** one bit per collect color still wanted */
  wanted: number;
  ice: boolean;
  crate: boolean;
  pearl: boolean;
}

/** Every valid move with its feature row: `features[m * FEATURE_COUNT + k]`. */
export interface MoveOptions {
  moves: Move[];
  features: Float64Array;
}

export function goalsOf(state: GameState): Goals {
  const goals: Goals = { wanted: 0, ice: false, crate: false, pearl: false };
  state.level.objectives.forEach((o, k) => {
    if (state.progress[k] >= o.target) return;
    if (o.kind === ObjectiveKind.Collect) goals.wanted |= 1 << o.color;
    else if (o.kind === ObjectiveKind.Ice) goals.ice = true;
    else if (o.kind === ObjectiveKind.Crate) goals.crate = true;
    else if (o.kind === ObjectiveKind.Pearl) goals.pearl = true;
  });
  return goals;
}

/** One scratch scan per thread: the extraction runs synchronously, never nested. */
const scan: GroupScan = newGroupScan();

/** Features of every move on a calm board; `last` is the cell of the previous move, or -1. Leaves the board as it was. */
export function moveOptions(b: Board, goals: Goals, last: number): MoveOptions {
  const moves = findMoves(b);
  const features = new Float64Array(moves.length * FEATURE_COUNT);
  // Cells counted for the current group carry its stamp: a crate next to several matched cells counts once.
  const seen = new Int32Array(b.cells.length);
  let stamp = 0;
  for (let m = 0; m < moves.length; m++) {
    const [i, j] = moves[m];
    const row = m * FEATURE_COUNT;
    features[row + Feature.Low] = (Math.floor(i / b.cols) + Math.floor(j / b.cols)) / 2 / Math.max(1, b.rows - 1);
    features[row + Feature.Far] = last < 0 ? FAR_UNKNOWN : Math.min(FAR_CAP, distance(b, last, i), distance(b, last, j));
    const pi = b.cells[i].piece!;
    const pj = b.cells[j].piece!;
    if (goals.pearl) features[row + Feature.Pearl] = pi.pearl ? cellsUnder(b, i) - cellsUnder(b, j) : pj.pearl ? cellsUnder(b, j) - cellsUnder(b, i) : 0;
    if (isComboPair(pi, pj)) {
      features[row + Feature.Combo] = 1;
      features[row + Feature.Used] = 2;
      continue;
    }
    swapPieces(b, i, j);
    if (scanGroup(b, i, scan)) addGroup(b, i, goals, seen, ++stamp, features, row);
    if (scanGroup(b, j, scan)) addGroup(b, j, goals, seen, ++stamp, features, row);
    swapPieces(b, i, j);
  }
  return { moves, features };
}

/** Value of option `m` for a style: weights · features. */
export function score(o: MoveOptions, m: number, weights: readonly number[]): number {
  let value = 0;
  const row = m * FEATURE_COUNT;
  for (let k = 0; k < FEATURE_COUNT; k++) value += weights[k] * o.features[row + k];
  return value;
}

const MADE: Partial<Record<Special, Feature>> = {
  [Special.LineH]: Feature.Line,
  [Special.LineV]: Feature.Line,
  [Special.Bomb]: Feature.Bomb,
  [Special.Prism]: Feature.Prism,
};

/** Adds the scanned group through swapped cell x to the feature row. */
function addGroup(b: Board, x: number, goals: Goals, seen: Int32Array, stamp: number, f: Float64Array, row: number): void {
  for (let k = 0; k < scan.count; k++) {
    const i = scan.cells[k];
    seen[i] = stamp;
    const cell = b.cells[i];
    f[row + Feature.Cells]++;
    if (cell.chain > 0) {
      f[row + Feature.Chain]++;
      continue;
    }
    const piece = cell.piece!;
    if (piece.special !== Special.None) f[row + Feature.Used]++;
    if (goals.wanted & (1 << piece.color)) f[row + Feature.Wanted]++;
    if (goals.ice && cell.ice > 0) f[row + Feature.Ice]++;
    if (goals.pearl) f[row + Feature.Pearl] += pearlsAbove(b, i);
  }
  if (goals.crate) {
    for (let k = 0; k < scan.count; k++) {
      const i = scan.cells[k];
      const r = Math.floor(i / b.cols);
      const c = i - r * b.cols;
      if (r > 0) f[row + Feature.Crate] += crateHit(b, i - b.cols, seen, stamp);
      if (r < b.rows - 1) f[row + Feature.Crate] += crateHit(b, i + b.cols, seen, stamp);
      if (c > 0) f[row + Feature.Crate] += crateHit(b, i - 1, seen, stamp);
      if (c < b.cols - 1) f[row + Feature.Crate] += crateHit(b, i + 1, seen, stamp);
    }
  }
  const made = MADE[scan.special];
  if (made === undefined) return;
  f[row + made]++;
  const r = Math.floor(x / b.cols);
  const c = x - r * b.cols;
  if (r > 0) f[row + Feature.Setup] += special(b, x - b.cols, seen, stamp);
  if (r < b.rows - 1) f[row + Feature.Setup] += special(b, x + b.cols, seen, stamp);
  if (c > 0) f[row + Feature.Setup] += special(b, x - 1, seen, stamp);
  if (c < b.cols - 1) f[row + Feature.Setup] += special(b, x + 1, seen, stamp);
}

/** A crate next to the group counts once, however many matched cells touch it. */
function crateHit(b: Board, n: number, seen: Int32Array, stamp: number): number {
  if (b.cells[n].crate === 0 || seen[n] === stamp) return 0;
  seen[n] = stamp;
  return 1;
}

/** A special next to the new one, and not used up by this match. */
function special(b: Board, n: number, seen: Int32Array, stamp: number): number {
  const piece = b.cells[n].piece;
  return piece && piece.special !== Special.None && seen[n] !== stamp ? 1 : 0;
}

/** Cells of the board under cell `i` in its column: how far a pearl there still has to go. */
function cellsUnder(b: Board, i: number): number {
  let count = 0;
  for (let j = i + b.cols; j < b.cells.length; j += b.cols) if (b.cells[j].exists) count++;
  return count;
}

/** Pearls the cell's piece holds up: above it in its column, holes skipped, up to a crate or a chain that stops the fall. */
function pearlsAbove(b: Board, i: number): number {
  let count = 0;
  for (let j = i - b.cols; j >= 0; j -= b.cols) {
    const cell = b.cells[j];
    if (!cell.exists) continue;
    if (cell.crate > 0 || cell.chain > 0) break;
    if (cell.piece?.pearl) count++;
  }
  return count;
}

function distance(b: Board, a: number, c: number): number {
  return Math.abs(Math.floor(a / b.cols) - Math.floor(c / b.cols)) + Math.abs((a % b.cols) - (c % b.cols));
}
