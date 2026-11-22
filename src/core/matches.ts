import { colorAt, indexOf, posOf } from '@/core/board';
import { type Board, NO_COLOR, Special } from '@/core/types';

export interface MatchGroup {
  cells: number[];
  color: number;
  special: Special;
  /** cell where the special piece appears, -1 when none */
  at: number;
}

const ShapeKind = { Row: 0, Col: 1, Square: 2 } as const;
type ShapeKind = (typeof ShapeKind)[keyof typeof ShapeKind];

interface Shape {
  kind: ShapeKind;
  cells: number[];
}

/** Whether the piece at index i is part of a line of 3+: a square alone is no match. Used for quick move checks. */
export function matchesAt(b: Board, i: number): boolean {
  const { r, c } = posOf(b, i);
  const k = colorAt(b, r, c);
  if (k === NO_COLOR) return false;

  let left = c;
  while (colorAt(b, r, left - 1) === k) left--;
  let right = c;
  while (colorAt(b, r, right + 1) === k) right++;
  if (right - left >= 2) return true;

  let up = r;
  while (colorAt(b, up - 1, c) === k) up--;
  let down = r;
  while (colorAt(b, down + 1, c) === k) down++;
  return down - up >= 2;
}

/** Reusable result of `scanGroup`, so hot loops (bots, move estimates) allocate nothing. */
export interface GroupScan {
  /** the first `count` entries are the group's cells */
  cells: Int32Array;
  count: number;
  special: Special;
}

/** A group holds each cell once, so it is never bigger than the board: boards stay well below this. */
const MAX_SCAN = 128;

export function newGroupScan(): GroupScan {
  return { cells: new Int32Array(MAX_SCAN), count: 0, special: Special.None };
}

const SQUARE_CORNERS = [
  [-1, -1],
  [-1, 0],
  [0, -1],
  [0, 0],
] as const;

/**
 * The group through cell x on a board where only x changed since it was calm: every new line passes through x
 * and squares join the group only by touching it, so this local scan finds exactly what `findGroups` would,
 * without scanning the board. Returns whether there is a match.
 */
export function scanGroup(b: Board, x: number, scan: GroupScan): boolean {
  scan.count = 0;
  scan.special = Special.None;
  const r = Math.floor(x / b.cols);
  const c = x % b.cols;
  const k = colorAt(b, r, c);
  if (k === NO_COLOR) return false;

  let left = c;
  while (colorAt(b, r, left - 1) === k) left--;
  let right = c;
  while (colorAt(b, r, right + 1) === k) right++;
  let up = r;
  while (colorAt(b, up - 1, c) === k) up--;
  let down = r;
  while (colorAt(b, down + 1, c) === k) down++;
  const h = right - left + 1;
  const v = down - up + 1;

  if (h >= 3) for (let col = left; col <= right; col++) addCell(scan, r * b.cols + col);
  if (v >= 3) for (let row = up; row <= down; row++) addCell(scan, row * b.cols + c);
  if (scan.count === 0) return false;
  // Squares touching the group join it, and so do squares touching those: `count` grows as they are added.
  let square = false;
  for (let n = 0; n < scan.count; n++) if (addSquares(b, scan.cells[n], k, scan)) square = true;

  // Same rules as buildGroup: the longest line first, then a crossing, a line of four, a square.
  const longest = Math.max(h >= 3 ? h : 0, v >= 3 ? v : 0);
  if (longest >= 5) scan.special = Special.Prism;
  else if (h >= 3 && v >= 3) scan.special = Special.Bomb;
  else if (longest === 4) scan.special = h === 4 ? Special.LineV : Special.LineH;
  else if (square) scan.special = Special.Bomb;
  return true;
}

/** Adds every square of color k through cell i; returns whether there is one. */
function addSquares(b: Board, i: number, k: number, scan: GroupScan): boolean {
  const r = Math.floor(i / b.cols);
  const c = i % b.cols;
  let found = false;
  for (const [dr, dc] of SQUARE_CORNERS) {
    const tr = r + dr;
    const tc = c + dc;
    if (colorAt(b, tr, tc) === k && colorAt(b, tr + 1, tc) === k && colorAt(b, tr, tc + 1) === k && colorAt(b, tr + 1, tc + 1) === k) {
      found = true;
      const top = tr * b.cols + tc;
      addCell(scan, top);
      addCell(scan, top + 1);
      addCell(scan, top + b.cols);
      addCell(scan, top + b.cols + 1);
    }
  }
  return found;
}

function addCell(scan: GroupScan, i: number): void {
  for (let k = 0; k < scan.count; k++) if (scan.cells[k] === i) return;
  scan.cells[scan.count++] = i;
}

/**
 * All match groups on the board. Lines and squares that share cells merge into one group;
 * a square on its own is no match. The group's shape decides which special piece it creates.
 * `preferred` cells (the swapped pair) get the special when they belong to the group.
 */
export function findGroups(b: Board, preferred: readonly number[]): MatchGroup[] {
  const shapes = collectShapes(b);
  if (shapes.length === 0) return [];

  const parent = shapes.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const owner = new Map<number, number>();
  shapes.forEach((shape, s) => {
    for (const cell of shape.cells) {
      const other = owner.get(cell);
      if (other === undefined) owner.set(cell, s);
      else parent[root(s)] = root(other);
    }
  });

  const components = new Map<number, Shape[]>();
  shapes.forEach((shape, s) => {
    const key = root(s);
    const list = components.get(key);
    if (list) list.push(shape);
    else components.set(key, [shape]);
  });

  return [...components.values()].filter((parts) => parts.some((p) => p.kind !== ShapeKind.Square)).map((parts) => buildGroup(b, parts, preferred));
}

function collectShapes(b: Board): Shape[] {
  const shapes: Shape[] = [];
  for (let r = 0; r < b.rows; r++) {
    let c = 0;
    while (c < b.cols) {
      const k = colorAt(b, r, c);
      let end = c + 1;
      while (k !== NO_COLOR && colorAt(b, r, end) === k) end++;
      if (k !== NO_COLOR && end - c >= 3) {
        shapes.push({ kind: ShapeKind.Row, cells: range(c, end).map((x) => indexOf(b, r, x)) });
      }
      c = end;
    }
  }
  for (let c = 0; c < b.cols; c++) {
    let r = 0;
    while (r < b.rows) {
      const k = colorAt(b, r, c);
      let end = r + 1;
      while (k !== NO_COLOR && colorAt(b, end, c) === k) end++;
      if (k !== NO_COLOR && end - r >= 3) {
        shapes.push({ kind: ShapeKind.Col, cells: range(r, end).map((y) => indexOf(b, y, c)) });
      }
      r = end;
    }
  }
  for (let r = 0; r < b.rows - 1; r++) {
    for (let c = 0; c < b.cols - 1; c++) {
      const k = colorAt(b, r, c);
      if (k !== NO_COLOR && colorAt(b, r + 1, c) === k && colorAt(b, r, c + 1) === k && colorAt(b, r + 1, c + 1) === k) {
        shapes.push({
          kind: ShapeKind.Square,
          cells: [indexOf(b, r, c), indexOf(b, r, c + 1), indexOf(b, r + 1, c), indexOf(b, r + 1, c + 1)],
        });
      }
    }
  }
  return shapes;
}

function buildGroup(b: Board, parts: Shape[], preferred: readonly number[]): MatchGroup {
  const cells = [...new Set(parts.flatMap((p) => p.cells))];
  const color = b.cells[cells[0]].piece!.color;
  const rows = parts.filter((p) => p.kind === ShapeKind.Row);
  const cols = parts.filter((p) => p.kind === ShapeKind.Col);
  const lines = [...rows, ...cols];
  const longest = lines.reduce<Shape | null>((best, p) => (!best || p.cells.length > best.cells.length ? p : best), null);
  const longestLength = longest?.cells.length ?? 0;

  let special: Special = Special.None;
  if (longestLength >= 5) special = Special.Prism;
  else if (rows.length > 0 && cols.length > 0) special = Special.Bomb;
  else if (longestLength === 4) special = longest!.kind === ShapeKind.Row ? Special.LineV : Special.LineH;
  else if (parts.some((p) => p.kind === ShapeKind.Square)) special = Special.Bomb;

  if (special === Special.None) return { cells, color, special, at: -1 };

  // A chained piece only loses its chain and a matched special stays until its turn to go off: the new one cannot appear there.
  const free = cells.filter((i) => b.cells[i].chain === 0 && b.cells[i].piece!.special === Special.None);
  if (free.length === 0) return { cells, color, special: Special.None, at: -1 };

  const at =
    free.find((i) => preferred.includes(i)) ??
    (special === Special.Bomb ? free.find((i) => rows.some((p) => p.cells.includes(i)) && cols.some((p) => p.cells.includes(i))) : undefined) ??
    (longest ? longest.cells[Math.floor(longest.cells.length / 2)] : undefined);

  return { cells, color, special, at: at !== undefined && free.includes(at) ? at : free[0] };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}
