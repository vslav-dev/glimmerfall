import { cellAt, holdsPiece, indexOf, isMovable, newPiece, spawnColor } from '@/core/board';
import type { Board, FallMove, Piece, Pos } from '@/core/types';

/**
 * Gravity and refill until nothing moves.
 * Pieces fall straight down through holes; under crates and chained pieces they slide in diagonally.
 * New pieces spawn at the top existing cell of each column that is open to the sky.
 * Returns the path of every piece that moved, for playback.
 */
export function settle(b: Board): FallMove[] {
  const moves = new Map<number, FallMove>();
  const spawned = new Array<number>(b.cols).fill(0);

  const record = (piece: Piece, from: Pos, to: Pos, isSpawn: boolean): void => {
    const move = moves.get(piece.id);
    if (move) move.path.push(to);
    else moves.set(piece.id, { piece, path: [from, to], spawned: isSpawn });
  };

  const isEmpty = (r: number, c: number): boolean => {
    const cell = cellAt(b, r, c);
    return cell !== null && holdsPiece(cell) && cell.piece === null;
  };

  /** Row of the nearest existing cell above (holes are skipped), or -1 when the column is open to the sky. */
  const sourceRow = (r: number, c: number): number => {
    for (let y = r - 1; y >= 0; y--) if (cellAt(b, y, c)) return y;
    return -1;
  };

  /** Row of the nearest existing cell below (holes are skipped), or -1. */
  const targetRow = (r: number, c: number): number => {
    for (let y = r + 1; y < b.rows; y++) if (cellAt(b, y, c)) return y;
    return -1;
  };

  const verticalPass = (): boolean => {
    let changed = false;
    for (let c = 0; c < b.cols; c++) {
      for (let r = b.rows - 1; r >= 0; r--) {
        if (!isEmpty(r, c)) continue;
        const src = sourceRow(r, c);
        const target = b.cells[indexOf(b, r, c)];
        if (src === -1) {
          const piece = newPiece(b, spawnColor(b));
          target.piece = piece;
          record(piece, { r: r - 1 - spawned[c], c }, { r, c }, true);
          spawned[c]++;
          changed = true;
          continue;
        }
        const source = b.cells[indexOf(b, src, c)];
        if (isMovable(source)) {
          target.piece = source.piece;
          source.piece = null;
          record(target.piece!, { r: src, c }, { r, c }, false);
          changed = true;
        }
      }
    }
    return changed;
  };

  const diagonalPass = (): boolean => {
    for (let r = b.rows - 1; r >= 1; r--) {
      for (let c = 0; c < b.cols; c++) {
        if (!isEmpty(r, c)) continue;
        const src = sourceRow(r, c);
        // An empty cell above will be filled first; only a real obstacle blocks the straight supply.
        if (src === -1 || isEmpty(src, c)) continue;
        const sides = (r + c) % 2 === 0 ? [-1, 1] : [1, -1];
        for (const dc of sides) {
          const sr = r - 1;
          const sc = c + dc;
          const side = cellAt(b, sr, sc);
          if (!side || !isMovable(side)) continue;
          const below = targetRow(sr, sc);
          if (below !== -1 && isEmpty(below, sc)) continue;
          const target = b.cells[indexOf(b, r, c)];
          target.piece = side.piece;
          side.piece = null;
          record(target.piece!, { r: sr, c: sc }, { r, c }, false);
          return true;
        }
      }
    }
    return false;
  };

  while (verticalPass() || diagonalPass()) {
    // keep settling
  }
  return [...moves.values()];
}
