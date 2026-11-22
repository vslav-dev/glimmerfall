import { type Blast, BlastKind } from '@/core/types';

/**
 * How hard a blast hits, for its own looks (a bomb's recoil). How it shakes the board is up to `feel`.
 * ~0.1 a spark, ~0.3 a line, ~0.4 a bomb, ~0.75 a big bomb or a whole-color prism.
 */
export function blastPower(b: Blast): number {
  switch (b.kind) {
    case BlastKind.Row:
    case BlastKind.Col:
      return 0.3;
    case BlastKind.Bomb:
      return bombRadius(b) >= 2 ? 0.75 : 0.42;
    case BlastKind.Prism:
      return Math.min(0.9, 0.3 + 0.012 * b.cells.length);
    case BlastKind.Spark:
      return 0.1;
  }
}

/** Deeper cascades throw a little more each step. */
export function cascadeBoost(cascade: number): number {
  return 1 + 0.08 * Math.min(cascade, 6);
}

/** How a hit lands: trauma of the shake, swell of the board's punch, length of the freeze (ms). */
export interface Feel {
  shake: number;
  punch: number;
  stopMs: number;
}

/** first hit of a move that freezes the game: the climax of a chain, not every bomb */
const STOP_FROM = 5;

/**
 * How the move's `hit`-th special hit (from 0) lands: every kind alike, building up along the move.
 * The first hits only tremble the board; the punch swells with each next one; from the fifth on each
 * hit also freezes the game a moment, longer and longer, so a long chain plays as a crescendo.
 */
export function feel(hit: number): Feel {
  return {
    shake: Math.min(0.6, 0.2 * (1 + 0.4 * hit)),
    punch: Math.min(0.03, 0.003 * (1 + 0.6 * hit)),
    stopMs: hit < STOP_FROM ? 0 : Math.min(80, 35 + 10 * (hit - STOP_FROM)),
  };
}

/** Rings out as far as the farthest cell it took. */
export function bombRadius(b: Blast): number {
  return Math.max(1, ...b.cells.map((p) => Math.max(Math.abs(p.r - b.origin.r), Math.abs(p.c - b.origin.c))));
}
