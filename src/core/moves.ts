import { indexOf, isMovable, posOf, randomFreeColor, swapPieces } from '@/core/board';
import { matchesAt } from '@/core/matches';
import { shuffleInPlace } from '@/core/rng';
import { type Board, type CreatedPiece, type Piece, Special } from '@/core/types';

export type Move = [number, number];

/** Two specials, or a prism with anything, make a combo that is valid without a match. */
export function isComboPair(a: Piece, b: Piece): boolean {
  return a.special === Special.Prism || b.special === Special.Prism || (a.special !== Special.None && b.special !== Special.None);
}

export function isValidSwap(b: Board, i: number, j: number): boolean {
  const ci = b.cells[i];
  const cj = b.cells[j];
  if (!isMovable(ci) || !isMovable(cj)) return false;
  if (isComboPair(ci.piece!, cj.piece!)) return true;
  swapPieces(b, i, j);
  const ok = matchesAt(b, i) || matchesAt(b, j);
  swapPieces(b, i, j);
  return ok;
}

export function findMoves(b: Board): Move[] {
  const moves: Move[] = [];
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      const i = indexOf(b, r, c);
      if (c + 1 < b.cols && isValidSwap(b, i, i + 1)) moves.push([i, i + 1]);
      if (r + 1 < b.rows && isValidSwap(b, i, i + b.cols)) moves.push([i, i + b.cols]);
    }
  }
  return moves;
}

export function hasMove(b: Board): boolean {
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      const i = indexOf(b, r, c);
      if (c + 1 < b.cols && isValidSwap(b, i, i + 1)) return true;
      if (r + 1 < b.rows && isValidSwap(b, i, i + b.cols)) return true;
    }
  }
  return false;
}

export function hasAnyMatch(b: Board): boolean {
  return b.cells.some((cell, i) => cell.piece !== null && matchesAt(b, i));
}

/**
 * Rearranges movable pieces until the board has no ready matches and at least one move.
 * Falls back to recoloring plain pieces when the existing set cannot be arranged.
 */
export function shuffleBoard(b: Board): CreatedPiece[] {
  const slots = b.cells.flatMap((cell, i) => (isMovable(cell) ? [i] : []));
  const pieces = slots.map((i) => b.cells[i].piece!);

  let ok = false;
  for (let attempt = 0; attempt < 60 && !ok; attempt++) {
    shuffleInPlace(b, pieces);
    slots.forEach((i, k) => (b.cells[i].piece = pieces[k]));
    ok = !hasAnyMatch(b) && hasMove(b);
  }
  for (let attempt = 0; attempt < 60 && !ok; attempt++) {
    for (const i of slots) {
      const piece = b.cells[i].piece!;
      if (piece.special !== Special.None) continue;
      piece.color = -1;
    }
    for (const i of slots) {
      const piece = b.cells[i].piece!;
      if (piece.color === -1 && piece.special === Special.None) {
        const { r, c } = posOf(b, i);
        piece.color = randomFreeColor(b, r, c);
      }
    }
    ok = !hasAnyMatch(b) && hasMove(b);
  }
  return slots.map((i) => ({ pos: posOf(b, i), piece: b.cells[i].piece! }));
}

