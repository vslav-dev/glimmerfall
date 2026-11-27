import { hashSeed, pick, randInt, random, type RngHolder, shuffleInPlace } from '@/core/rng';

/**
 * Board shapes (plans/16): a level's archetype picks its size, its symmetry and the cuts that carve its holes.
 * Players notice a board's overall form, not a notch here or there, so the archetypes differ in the large:
 * tall towers, wide floors, diamonds, rings, split boards, skewed ones, a heart, wild asymmetric ones.
 */

export const Symmetry = {
  None: 'none',
  /** left to right */
  Mirror: 'mirror',
  /** a half turn around the center */
  Turn: 'turn',
  /** left to right and top to bottom */
  Quad: 'quad',
} as const;
export type Symmetry = (typeof Symmetry)[keyof typeof Symmetry];

export interface Shape {
  archetype: string;
  rows: number;
  cols: number;
  /** per cell, row-major: 1 = cell exists */
  mask: number[];
  symmetry: Symmetry;
}

/** The cells a layout treats as one: a cell and its images under the board's symmetry. */
export function orbitOf(i: number, rows: number, cols: number, symmetry: Symmetry): number[] {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const mirror = r * cols + cols - 1 - c;
  const turn = (rows - 1 - r) * cols + cols - 1 - c;
  const flip = (rows - 1 - r) * cols + c;
  switch (symmetry) {
    case Symmetry.None:
      return [i];
    case Symmetry.Mirror:
      return [...new Set([i, mirror])];
    case Symmetry.Turn:
      return [...new Set([i, turn])];
    case Symmetry.Quad:
      return [...new Set([i, mirror, flip, turn])];
  }
}

/**
 * [cols, rows]. 6–8 columns, so a cell's size on a screen barely changes from level to level (plans/17): the view
 * draws 6 columns as wide as 7. Big boards grow in height instead: up to 12 rows, what a phone's height holds
 * at the width of 8 columns. At most 99 cells (telemetry packs a cell in 7 bits).
 */
type Size = readonly [number, number];
const STANDARD: Size[] = [[7, 8], [8, 8], [8, 9], [7, 9], [8, 10], [7, 10]];
const BIG: Size[] = [[8, 11], [8, 12], [7, 12]];
const TALL: Size[] = [[6, 9], [6, 10], [6, 11], [6, 12], [7, 11]];
const WIDE: Size[] = [[8, 7], [8, 8]];
const TINY: Size[] = [[6, 6], [6, 7], [7, 6]];

/** Whether the cell at (r, c) is a hole. */
type Hole = (r: number, c: number) => boolean;
/**
 * Draws one cut for a board; `depth` (0…1) is how deep it may go. Cuts look at the whole board:
 * the symmetry is laid over them afterwards.
 */
type Cut = (rows: number, cols: number, depth: number, h: RngHolder) => Hole;

const edge = (x: number, size: number): number => Math.min(x, size - 1 - x);
const mid = (size: number): number => (size - 1) / 2;
/** -1 … 1 across the board */
const unit = (x: number, size: number): number => (x - mid(size)) / Math.max(1, mid(size));

const full: Cut = () => () => false;

/** Diagonal notches at some of the corners. */
const corners: Cut = (rows, cols, depth, h) => {
  const k = 1 + Math.round(depth * 2) + (rows * cols > 80 ? 1 : 0);
  const which = [0, 1, 2, 3].map(() => random(h) < 0.6);
  if (!which.some(Boolean)) which[randInt(h, 4)] = true;
  return (r, c) => which[(r < rows / 2 ? 0 : 2) + (c < cols / 2 ? 0 : 1)] && edge(r, rows) + edge(c, cols) < k;
};

/** Square bites out of the corners: a plus. */
const cross: Cut = (rows, cols, depth) => {
  const k = 1 + Math.round(depth * (Math.min(rows, cols) / 2 - 2.5));
  return (r, c) => edge(r, rows) < k && edge(c, cols) < k;
};

const diamond: Cut = (rows, cols, depth, h) => {
  const reach = 1.6 - 0.5 * depth + 0.1 * random(h);
  return (r, c) => Math.abs(unit(r, rows)) + Math.abs(unit(c, cols)) > reach;
};

const oval: Cut = (rows, cols, depth, h) => {
  const reach = 1.5 - 0.4 * depth + 0.1 * random(h);
  return (r, c) => unit(r, rows) ** 2 + unit(c, cols) ** 2 > reach ** 2;
};

/** A hole in the middle, sometimes off it. */
const donut: Cut = (rows, cols, depth, h) => {
  const cy = mid(rows) + (random(h) < 0.4 ? randInt(h, 3) - 1 : 0);
  const cx = mid(cols) + (random(h) < 0.4 ? randInt(h, 3) - 1 : 0);
  const ry = 0.8 + depth * 1.1 + 0.4 * random(h);
  const rx = 0.8 + depth * 1.1 + 0.4 * random(h);
  return (r, c) => ((r - cy) / ry) ** 2 + ((c - cx) / rx) ** 2 <= 1;
};

/** Narrow in the middle: rows pinched from both walls, or columns pinched from the top and the bottom. */
const hourglass: Cut = (rows, cols, depth, h) => {
  const waist = 1 - 0.55 * depth;
  const across = random(h) < 0.7;
  return (r, c) =>
    across
      ? Math.abs(unit(c, cols)) > waist + (1 - waist) * Math.abs(unit(r, rows)) + 0.12
      : Math.abs(unit(r, rows)) > waist + (1 - waist) * Math.abs(unit(c, cols)) + 0.12;
};

/** A gap from top to bottom, sometimes with a bridge across: two boards side by side. */
const split: Cut = (rows, cols, _depth, h) => {
  const at = 2 + randInt(h, Math.max(1, cols - 4));
  const bridge = random(h) < 0.5 ? 2 + randInt(h, Math.max(1, rows - 5)) : -9;
  return (r, c) => c === at && Math.abs(r - bridge) > 0;
};

/** A gap across the board: pieces fall through it from the upper board into the lower one. */
const band: Cut = (rows, cols, _depth, h) => {
  const at = 3 + randInt(h, Math.max(1, rows - 6));
  const margin = randInt(h, 2);
  return (r, c) => r === at && edge(c, cols) >= margin;
};

/** Gaps every few rows: floors stacked over each other. */
const floors: Cut = (rows, _cols, _depth, h) => {
  const every = pick(h, [4, 4, 5]);
  return (r) => r % every === every - 1 && r < rows - 2;
};

/** Gaps every few columns: towers side by side. */
const towers: Cut = (_rows, cols, _depth, h) => {
  const every = pick(h, [4, 4, 5]);
  return (_r, c) => c % every === every - 1 && c < cols - 2;
};

/** Every other or third column cut short at the bottom or the top. */
const teeth: Cut = (rows, cols, depth, h) => {
  const every = pick(h, [2, 3]);
  const phase = randInt(h, every);
  const deep = 1 + Math.round(depth);
  const bottom = random(h) < 0.5;
  // Counted from the nearer wall: a mirror over the teeth keeps them, where on an even width it filled the gaps between.
  return (r, c) => edge(c, cols) % every === phase && (bottom ? rows - 1 - r : r) < deep;
};

/** Rows shifted step by step: a parallelogram, leaning one way or the other. */
const slant: Cut = (rows, cols, depth, h) => {
  const shift = 1 + Math.round(depth * 2);
  const left = random(h) < 0.5;
  return (r, c) => {
    const off = Math.round((shift * (left ? r : rows - 1 - r)) / (rows - 1));
    return c < off || c > cols - 1 - shift + off;
  };
};

/** A corner sliced off along a diagonal, sometimes the opposite one too. */
const stairs: Cut = (rows, cols, depth, h) => {
  const cut = 0.25 + 0.35 * depth;
  const both = random(h) < 0.5;
  const flip = random(h) < 0.5;
  return (r, c) => {
    const x = flip ? cols - 1 - c : c;
    const along = r / (rows - 1) + x / (cols - 1);
    return along < cut || (both && along > 2 - cut);
  };
};

/** Single holes on a lattice. */
const cheese: Cut = (_rows, _cols, depth, h) => {
  const every = depth > 0.6 ? 3 : pick(h, [3, 4]);
  const [pr, pc] = [randInt(h, every), randInt(h, every)];
  const stagger = random(h) < 0.5;
  return (r, c) => r % every === pr && (c + (stagger && Math.floor(r / every) % 2 === 1 ? 2 : 0)) % every === pc;
};

/** An opening under the board: it stands on legs. */
const arch: Cut = (rows, cols, depth, h) => {
  const tall = 2 + Math.round(depth);
  const half = 1 + Math.round(depth * 0.6 * random(h));
  const at = mid(cols) + (random(h) < 0.3 ? randInt(h, 3) - 1 : 0);
  // The walls stay legs: an opening off the middle, mirrored, would otherwise span a narrow board.
  return (r, c) => rows - 1 - r < tall && Math.abs(c - at) <= half && edge(c, cols) > 0;
};

/** Two lobes on top, a point below. */
const heart: Cut = (rows, cols) => (r, c) => {
  const x = Math.abs(unit(c, cols));
  const y = unit(r, rows);
  return (y > 0.05 && x > 1.05 - y) || (r === 0 && (x < 0.3 || x > 0.75)) || (r === 1 && x > 0.9);
};

/** A few random rectangles knocked out. */
const bites: Cut = (rows, cols, depth, h) => {
  const holes = Array.from({ length: 2 + Math.round(depth * 2) }, () => {
    const w = 1 + randInt(h, 3);
    const t = 1 + randInt(h, 2);
    return [randInt(h, rows - t + 1), randInt(h, cols - w + 1), t, w];
  });
  return (r, c) => holes.some(([y, x, t, w]) => r >= y && r < y + t && c >= x && c < x + w);
};

/** Cuts a wild or a stitched board draws from. */
const ANY_CUT: Cut[] = [corners, cross, diamond, oval, donut, hourglass, split, band, teeth, slant, stairs, cheese, arch, bites];

const oneOf =
  (...cuts: Cut[]): Cut =>
  (rows, cols, depth, h) =>
    pick(h, cuts)(rows, cols, depth, h);

/** Two cuts over each other: nothing about it is planned. */
const wild: Cut = (rows, cols, depth, h) => {
  const a = pick(h, ANY_CUT)(rows, cols, depth, h);
  const b = pick(h, ANY_CUT)(rows, cols, depth * 0.7, h);
  return (r, c) => a(r, c) || b(r, c);
};

/** The left half of one board beside the right half of another. */
const stitch: Cut = (rows, cols, depth, h) => {
  const a = pick(h, ANY_CUT)(rows, cols, depth, h);
  const b = pick(h, ANY_CUT)(rows, cols, depth, h);
  return (r, c) => (c < cols / 2 ? a(r, c) : b(r, c));
};

export interface Archetype {
  name: string;
  sizes: Size[];
  symmetries: Symmetry[];
  cut: Cut;
}

const { None, Mirror, Turn, Quad } = Symmetry;

export const ARCHETYPES: Archetype[] = [
  { name: 'classic', sizes: STANDARD, symmetries: [Mirror], cut: oneOf(full, corners, corners) },
  { name: 'open', sizes: BIG, symmetries: [Mirror], cut: oneOf(full, full, corners) },
  { name: 'tiny', sizes: TINY, symmetries: [Mirror, None], cut: oneOf(full, full, corners) },
  { name: 'tower', sizes: TALL, symmetries: [Mirror, Turn], cut: oneOf(full, corners, teeth, floors) },
  { name: 'wide', sizes: WIDE, symmetries: [Mirror], cut: oneOf(full, teeth, arch) },
  { name: 'diamond', sizes: [...STANDARD, ...BIG], symmetries: [Quad], cut: diamond },
  { name: 'oval', sizes: [...STANDARD, ...BIG], symmetries: [Quad], cut: oval },
  { name: 'donut', sizes: [...STANDARD, ...BIG], symmetries: [Quad, Turn, Mirror], cut: donut },
  { name: 'cross', sizes: [...STANDARD, ...BIG], symmetries: [Quad], cut: cross },
  { name: 'hourglass', sizes: [...STANDARD, ...BIG, ...TALL], symmetries: [Quad], cut: hourglass },
  { name: 'twins', sizes: [...STANDARD, ...BIG, ...WIDE], symmetries: [Mirror, None], cut: split },
  { name: 'floors', sizes: [...STANDARD, ...BIG, ...TALL], symmetries: [Mirror, Turn], cut: oneOf(floors, band) },
  { name: 'towers', sizes: [...STANDARD, ...BIG, ...WIDE], symmetries: [Mirror, None], cut: towers },
  { name: 'skew', sizes: [...STANDARD, ...BIG], symmetries: [Turn, None], cut: slant },
  { name: 'stairs', sizes: [...STANDARD, ...BIG], symmetries: [Turn, None, Mirror], cut: stairs },
  { name: 'cheese', sizes: [...STANDARD, ...BIG], symmetries: [Quad, Turn, None], cut: cheese },
  { name: 'arch', sizes: [...STANDARD, ...BIG, ...WIDE], symmetries: [Mirror], cut: arch },
  { name: 'heart', sizes: [[8, 9], [8, 10], [8, 11]], symmetries: [Mirror], cut: heart },
  { name: 'wild', sizes: [...STANDARD, ...BIG, ...TALL, ...WIDE, ...TINY], symmetries: [None], cut: wild },
  { name: 'stitch', sizes: [...STANDARD, ...BIG], symmetries: [None], cut: stitch },
];

/** The plain board of the shared levels and of a new mechanic's lesson. */
export const PLAIN = 'plain';
/** Levels before this one share the plain board. */
export const DECK_FROM = 6;

/**
 * The archetype of a level: a player's levels walk through shuffled decks of every archetype, one deck after
 * another, so none comes back before all the others have been, and never twice in a row.
 */
export function archetypeOf(seed: number, n: number): Archetype {
  const k = ARCHETYPES.length;
  const m = n - DECK_FROM;
  const deck = deckOf(seed, Math.floor(m / k));
  return deck[m % k];
}

function deckOf(seed: number, index: number): Archetype[] {
  const deck = shuffleInPlace({ rng: hashSeed(seed, index, 0x5ad) }, [...ARCHETYPES]);
  if (index > 0) {
    const before = shuffleInPlace({ rng: hashSeed(seed, index - 1, 0x5ad) }, [...ARCHETYPES]);
    // The previous deck's own fix only swaps its first two: its last card stays.
    if (deck[0] === before[before.length - 1]) [deck[0], deck[1]] = [deck[1], deck[0]];
  }
  return deck;
}

/** Most of a board that may be holes. */
const MAX_HOLES = 0.45;
const MIN_CELLS = 30;
/** Cells a piece of the board cut off from the rest needs at least, to play on its own. */
const MIN_PART = 8;
const TRIES = 20;

/**
 * A board of the archetype. `craft` (0 random taps … 1 planning) sets how deep its cuts go: random tappers
 * get the same forms, opened up. `pearls`: the board's pearl exits are trimmed until each has a line of three
 * across it. A shape that fails every check falls back to the full board of its size.
 */
export function makeShape(archetype: Archetype, craft: number, pearls: boolean, h: RngHolder): Shape {
  const [cols, rows] = pick(h, archetype.sizes);
  const symmetry = pick(h, archetype.symmetries);
  let depth = (0.55 + 0.45 * craft) * (0.75 + 0.25 * random(h));
  for (let attempt = 0; attempt < TRIES; attempt++, depth *= 0.9) {
    const hole = archetype.cut(rows, cols, depth, h);
    const raw = Array.from({ length: rows * cols }, (_, i) => (hole(Math.floor(i / cols), i % cols) ? 0 : 1));
    // The symmetry laid over the cut: a hole anywhere in an orbit opens the whole orbit, so no cut is lost.
    const mask = prune(raw.map((_, i) => (orbitOf(i, rows, cols, symmetry).every((j) => raw[j] === 1) ? 1 : 0)), rows, cols, symmetry, pearls);
    if (isPlayable(mask, rows, cols)) return crop({ archetype: archetype.name, rows, cols, mask, symmetry });
  }
  return { archetype: archetype.name, rows, cols, mask: new Array<number>(rows * cols).fill(1), symmetry };
}

/**
 * The board cut down to its cells: whole empty rows and columns at its edges would only take room on the screen.
 * The mask holds whole orbits, so an empty edge comes with its images and the symmetry holds on the smaller board.
 */
function crop(s: Shape): Shape {
  const { rows, cols, mask } = s;
  const rowUsed = (r: number): boolean => mask.slice(r * cols, (r + 1) * cols).some(Boolean);
  const colUsed = (c: number): boolean => mask.some((m, i) => m === 1 && i % cols === c);
  let [top, bottom, left, right] = [0, rows - 1, 0, cols - 1];
  while (!rowUsed(top)) top++;
  while (!rowUsed(bottom)) bottom--;
  while (!colUsed(left)) left++;
  while (!colUsed(right)) right--;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const cropped = Array.from({ length: width * height }, (_, i) => mask[(top + Math.floor(i / width)) * cols + left + (i % width)]);
  return { ...s, rows: height, cols: width, mask: cropped };
}

/** The plain board: the first levels and a mechanic's lesson, sized as the game always had them. */
export function plainShape(n: number, h: RngHolder): Shape {
  const cols = n <= 3 ? 7 : pick(h, [7, 8, 8]);
  const rows = Math.min(9, cols + pick(h, [0, 1, 1]));
  return { archetype: PLAIN, rows, cols, mask: new Array<number>(rows * cols).fill(1), symmetry: Symmetry.Mirror };
}

/** Whether a piece at (r, c) can be in a line of three across: two cells of the board beside it in a row. */
function across(mask: number[], rows: number, cols: number, r: number, c: number): boolean {
  const at = (x: number): boolean => r >= 0 && r < rows && x >= 0 && x < cols && mask[r * cols + x] === 1;
  return (at(c - 1) && (at(c - 2) || at(c + 1))) || (at(c + 1) && at(c + 2));
}

/** Whether a piece at (r, c) can be in a line of three down its column. */
function down(mask: number[], rows: number, cols: number, r: number, c: number): boolean {
  const at = (y: number): boolean => y >= 0 && y < rows && c >= 0 && c < cols && mask[y * cols + c] === 1;
  return (at(r - 1) && (at(r - 2) || at(r + 1))) || (at(r + 1) && at(r + 2));
}

/**
 * Takes out the cells no line of three runs through, until none is left: the tips and slivers a cut leaves
 * would hold a piece only a special could ever clear. A cell goes with its orbit, so the board keeps its symmetry.
 * `pearls`: a pearl leaves from the lowest cell of its column and is cleared from below only by a line across,
 * so an exit with no line across goes too.
 */
function prune(mask: number[], rows: number, cols: number, symmetry: Symmetry, pearls: boolean): number[] {
  const result = [...mask];
  const isExit = (i: number): boolean => !result.some((m, j) => m === 1 && j > i && j % cols === i % cols);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const [r, c] = [Math.floor(i / cols), i % cols];
      if (result[i] === 0 || across(result, rows, cols, r, c)) continue;
      if (!down(result, rows, cols, r, c) || (pearls && isExit(i))) {
        for (const j of orbitOf(i, rows, cols, symmetry)) result[j] = 0;
        changed = true;
      }
    }
  }
  return result;
}

/** Enough cells, not too many holes, every cell on some line of three, no piece of the board too small to play on. */
export function isPlayable(mask: number[], rows: number, cols: number): boolean {
  const count = mask.filter(Boolean).length;
  if (count < MIN_CELLS || count < rows * cols * (1 - MAX_HOLES)) return false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    const [r, c] = [Math.floor(i / cols), i % cols];
    if (!across(mask, rows, cols, r, c) && !down(mask, rows, cols, r, c)) return false;
  }
  return parts(mask, rows, cols).every((size) => size >= MIN_PART);
}
/** Sizes of the pieces of the board, side by side neighbors joined. */
function parts(mask: number[], rows: number, cols: number): number[] {
  const seen = new Array<boolean>(mask.length).fill(false);
  const sizes: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start]) continue;
    seen[start] = true;
    const stack = [start];
    let size = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;
      const [r, c] = [Math.floor(i / cols), i % cols];
      for (const [y, x] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        const j = y * cols + x;
        if (y < 0 || y >= rows || x < 0 || x >= cols || mask[j] !== 1 || seen[j]) continue;
        seen[j] = true;
        stack.push(j);
      }
    }
    sizes.push(size);
  }
  return sizes;
}
