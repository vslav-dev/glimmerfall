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

/** Whether the piece at index i is part of a line of 3+ or a 2x2 square. Used for quick move checks. */
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
  if (down - up >= 2) return true;

  for (const [dr, dc] of [
    [-1, -1],
    [-1, 0],
    [0, -1],
    [0, 0],
  ]) {
    const tr = r + dr;
    const tc = c + dc;
    if (
      colorAt(b, tr, tc) === k &&
      colorAt(b, tr + 1, tc) === k &&
      colorAt(b, tr, tc + 1) === k &&
      colorAt(b, tr + 1, tc + 1) === k
    ) {
      return true;
    }
  }
  return false;
}

/**
 * All match groups on the board. Lines and squares that share cells merge into one group;
 * the group's shape decides which special piece it creates.
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

  return [...components.values()].map((parts) => buildGroup(b, parts, preferred));
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
  else if (parts.some((p) => p.kind === ShapeKind.Square)) special = Special.Spark;

  if (special === Special.None) return { cells, color, special, at: -1 };

  // A chained piece only loses its chain, so the special cannot appear on it.
  const free = cells.filter((i) => b.cells[i].chain === 0);
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
