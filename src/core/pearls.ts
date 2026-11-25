import { indexOf, isMovable } from '@/core/board';
import { randInt } from '@/core/rng';
import { type Board, NO_COLOR, Special } from '@/core/types';

/** One pearl on the board at a time: the next drops in once the last has left through the bottom. */
const PEARLS_AT_ONCE = 1;

/** Whether cell `i` is the bottom of its column, where a pearl leaves the board: no cell of the board under it. */
export function isExit(b: Board, i: number): boolean {
  for (let j = i + b.cols; j < b.cells.length; j += b.cols) if (b.cells[j].exists) return false;
  return true;
}

/** The top cell of every column, where it holds a free piece: where the first pearl can start. */
export function topCells(b: Board): number[] {
  const tops: number[] = [];
  for (let c = 0; c < b.cols; c++) {
    for (let r = 0; r < b.rows; r++) {
      const i = indexOf(b, r, c);
      if (!b.cells[i].exists) continue;
      if (isMovable(b.cells[i]) && b.cells[i].piece!.special === Special.None) tops.push(i);
      break;
    }
  }
  return tops;
}

/**
 * Pearls still to come drop in while the board has room for one: the fresh piece on a random one of `tops`
 * (cells at the top of their column) turns into a pearl.
 */
export function dropPearls(b: Board, tops: number[]): void {
  let room = PEARLS_AT_ONCE - b.cells.filter((cell) => cell.piece?.pearl).length;
  while (b.pearls! > 0 && room > 0 && tops.length > 0) {
    const piece = b.cells[tops.splice(randInt(b, tops.length), 1)[0]].piece!;
    piece.color = NO_COLOR;
    piece.pearl = true;
    b.pearls!--;
    room--;
  }
}
