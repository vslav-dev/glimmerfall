import { randInt } from '@/core/rng';
import { type Board, type Cell, type Piece, type Pos, NO_COLOR, Special } from '@/core/types';

export function indexOf(b: Board, r: number, c: number): number {
  return r * b.cols + c;
}

export function posOf(b: Board, i: number): Pos {
  return { r: Math.floor(i / b.cols), c: i % b.cols };
}

export function inside(b: Board, r: number, c: number): boolean {
  return r >= 0 && r < b.rows && c >= 0 && c < b.cols;
}

/** Existing cell at (r, c), or null for out of bounds and holes. */
export function cellAt(b: Board, r: number, c: number): Cell | null {
  if (!inside(b, r, c)) return null;
  const cell = b.cells[r * b.cols + c];
  return cell.exists ? cell : null;
}

/** Color that takes part in matching at (r, c), or NO_COLOR. */
export function colorAt(b: Board, r: number, c: number): number {
  const piece = cellAt(b, r, c)?.piece;
  return piece ? piece.color : NO_COLOR;
}

/** Cell can hold a piece (exists and is not a crate). */
export function holdsPiece(cell: Cell): boolean {
  return cell.exists && cell.crate === 0;
}

/** Piece in the cell can be swapped and can fall. */
export function isMovable(cell: Cell): boolean {
  return cell.piece !== null && cell.chain === 0 && cell.crate === 0;
}

export function neighbors4(b: Board, i: number): number[] {
  const { r, c } = posOf(b, i);
  const result: number[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    if (cellAt(b, r + dr, c + dc)) result.push(indexOf(b, r + dr, c + dc));
  }
  return result;
}

export function newPiece(b: Board, color: number, special: Special = Special.None): Piece {
  return { id: b.nextId++, color: special === Special.Prism ? NO_COLOR : color, special };
}

/** Refill color: uniform, so calibration over many boards stays honest. */
export function spawnColor(b: Board): number {
  return randInt(b, b.colors);
}

export function swapPieces(b: Board, i: number, j: number): void {
  const piece = b.cells[i].piece;
  b.cells[i].piece = b.cells[j].piece;
  b.cells[j].piece = piece;
}

export function isAdjacent(a: Pos, b: Pos): boolean {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}

/** Whether a piece of color k at (r, c) would complete a line of 3 with its neighbors. */
export function wouldMatch(b: Board, r: number, c: number, k: number): boolean {
  const at = (dr: number, dc: number): boolean => colorAt(b, r + dr, c + dc) === k;
  const row = (at(0, -1) && (at(0, -2) || at(0, 1))) || (at(0, 1) && at(0, 2));
  const col = (at(-1, 0) && (at(-2, 0) || at(1, 0))) || (at(1, 0) && at(2, 0));
  return row || col;
}

/** Random color that creates no match at (r, c), if one exists. */
export function randomFreeColor(b: Board, r: number, c: number): number {
  const start = randInt(b, b.colors);
  for (let k = 0; k < b.colors; k++) {
    const color = (start + k) % b.colors;
    if (!wouldMatch(b, r, c, color)) return color;
  }
  return start;
}
