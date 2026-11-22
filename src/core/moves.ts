import { cellAt, indexOf, isMovable, neighbors4, posOf, randomFreeColor, swapPieces } from '@/core/board';
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

/**
 * Whether matches can reach every chain, crate and ice on the board. A chained piece keeps its color and moves
 * nowhere, so a row of chains in clashing colors can leave no line through it to complete, and what lies behind
 * stays shut for good: no shuffle helps, the shuffle moves only free pieces.
 *
 * Plays the opening up forward. A free cell is live when free cells link it to the top of a column: refills and
 * swaps can bring it any color. A line of three can be completed when it has a live cell, no crate, and its other
 * cells are chained pieces of one color. A free cell cut off from the refill keeps its piece, so it completes no
 * line. A completed line breaks its chains and the crates next to it, which can make more cells live.
 * Specials are left out: the board must open up through plain matches.
 */
export function canReachBlockers(b: Board): boolean {
  const chained = b.cells.map((cell) => cell.exists && cell.chain > 0);
  const crated = b.cells.map((cell) => cell.exists && cell.crate > 0);
  const reached = b.cells.map(() => false);
  const lines = linesOfThree(b);
  for (let changed = true; changed; ) {
    changed = false;
    const live = liveCells(b, chained, crated);
    for (const line of lines) {
      if (!canComplete(b, line, live, chained, crated)) continue;
      for (const i of line) {
        if (reached[i]) continue;
        reached[i] = true;
        chained[i] = false;
        for (const j of neighbors4(b, i)) crated[j] = false;
        changed = true;
      }
    }
  }
  return b.cells.every((cell, i) => !chained[i] && !crated[i] && (cell.ice === 0 || reached[i]));
}

/** Every three cells in a row or a column with no hole between them. */
function linesOfThree(b: Board): number[][] {
  const lines: number[][] = [];
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const cells = [0, 1, 2].map((k) => ({ r: r + dr * k, c: c + dc * k }));
        if (cells.every((p) => cellAt(b, p.r, p.c))) lines.push(cells.map((p) => indexOf(b, p.r, p.c)));
      }
    }
  }
  return lines;
}

/** Free cells linked through free cells to the top cell of a column, where the refill comes in. */
function liveCells(b: Board, chained: boolean[], crated: boolean[]): boolean[] {
  const free = (i: number): boolean => b.cells[i].exists && !chained[i] && !crated[i];
  const live = b.cells.map(() => false);
  const queue: number[] = [];
  for (let c = 0; c < b.cols; c++) {
    const top = b.cells.findIndex((cell, i) => i % b.cols === c && cell.exists);
    if (top !== -1 && free(top)) {
      live[top] = true;
      queue.push(top);
    }
  }
  while (queue.length > 0) {
    for (const j of neighbors4(b, queue.pop()!)) {
      if (live[j] || !free(j)) continue;
      live[j] = true;
      queue.push(j);
    }
  }
  return live;
}

function canComplete(b: Board, line: number[], live: boolean[], chained: boolean[], crated: boolean[]): boolean {
  if (line.some((i) => crated[i]) || !line.some((i) => live[i])) return false;
  const fixed = line.filter((i) => !live[i]);
  if (fixed.some((i) => !chained[i])) return false;
  return fixed.every((i) => b.cells[i].piece?.color === b.cells[fixed[0]].piece?.color);
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

