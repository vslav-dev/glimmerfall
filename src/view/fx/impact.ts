import { type Blast, BlastKind } from '@/core/types';

/**
 * How hard an event hits, one scale for every effect: shake, hitstop, the board's punch, particle counts.
 * ~0.1 a spark, ~0.2 a line, ~0.4 a bomb, ~0.75 a big bomb or a whole-color prism, 1+ the biggest combos.
 */
export function blastPower(b: Blast): number {
  switch (b.kind) {
    case BlastKind.Row:
    case BlastKind.Col:
      return 0.2;
    case BlastKind.Bomb:
      return bombRadius(b) >= 2 ? 0.75 : 0.42;
    case BlastKind.Prism:
      return Math.min(0.9, 0.3 + 0.012 * b.cells.length);
    case BlastKind.Spark:
      return 0.1;
  }
}

/** Two specials going off together hit harder than both apart. */
export const COMBO_POWER = 0.35;

/** Deeper cascades hit a little harder each step. */
export function cascadeBoost(cascade: number): number {
  return 1 + 0.08 * Math.min(cascade, 6);
}

/** Freeze length for a hit: only big hits freeze, so the freeze itself tells how big. */
export function hitstopMs(power: number): number {
  return power < 0.6 ? 0 : Math.round(40 + 50 * Math.min(1, (power - 0.6) / 0.6));
}

/** Rings out as far as the farthest cell it took. */
export function bombRadius(b: Blast): number {
  return Math.max(1, ...b.cells.map((p) => Math.max(Math.abs(p.r - b.origin.r), Math.abs(p.c - b.origin.c))));
}
