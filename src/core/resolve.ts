import { neighbors4, newPiece, posOf } from '@/core/board';
import { settle } from '@/core/fall';
import { findGroups, type MatchGroup } from '@/core/matches';
import { isComboPair } from '@/core/moves';
import { random, shuffleInPlace } from '@/core/rng';
import {
  type Blast,
  BlastKind,
  type Board,
  type CreatedPiece,
  type GameEvent,
  type LayerChange,
  type LitPiece,
  MAX_COLORS,
  NO_COLOR,
  type PendingSwap,
  type Piece,
  type Pos,
  type RemovedPiece,
  type ScorePopup,
  Special,
} from '@/core/types';

const PIECE_POINTS = 10;
const LAYER_POINTS = 20;
const MAX_MULTIPLIER = 5;
/** Most moves the finale turns into specials; moves beyond it add nothing. */
export const FINALE_CONVERSIONS = 12;
const SPARK_PAIR_TARGETS = 4;

const SPECIAL_BONUS: Record<Special, number> = {
  [Special.None]: 0,
  [Special.LineH]: 40,
  [Special.LineV]: 40,
  [Special.Bomb]: 60,
  [Special.Spark]: 30,
  [Special.Prism]: 100,
};

/** What one move produced, for objectives and score. */
export interface Tally {
  score: number;
  collected: number[];
  ice: number;
  crate: number;
}

/** How attractive a cell is as a spark target, given what the current step has gained so far. The game derives it from its objectives. */
export type TargetScorer = (b: Board, i: number, tally: Tally) => number;

/** What a step did: the playback script and its gains. */
export interface Step {
  events: GameEvent[];
  tally: Tally;
}

interface Activation {
  piece: Piece;
  i: number;
  order: number;
  /** special a spark carries to its target */
  carry: Special;
}

/** One clear step: everything removed at once before pieces fall. */
interface Ctx {
  b: Board;
  tally: Tally;
  scorer: TargetScorer;
  events: GameEvent[];
  multiplier: number;
  cascade: number;
  removed: RemovedPiece[];
  blasts: Blast[];
  layers: Map<number, LayerChange>;
  popups: ScorePopup[];
  /** the special going off this step */
  queue: Activation[];
  /** cells of specials matched this step: due at once, yet only one goes off per step */
  matched: number[];
  pending: { i: number; piece: Piece }[];
  crateHits: Set<number>;
  /** ids of lit specials waiting their turn, shared across steps */
  fuse: number[];
  lit: LitPiece[];
  /** center of the player's combo this step */
  combo: Pos | null;
  /** matches other than the player's own create their specials; off once the moves are spent */
  specials: boolean;
}

export function newTally(): Tally {
  return { score: 0, collected: new Array<number>(MAX_COLORS).fill(0), ice: 0, crate: 0 };
}

/**
 * One board step: the pending player swap (combo or match) and every ready match clear together,
 * one special goes off, pieces fall.
 * Exactly one special goes off per step, so chain reactions play out one by one while the board refills:
 * a special hit by a blast is lit, stays on the board (falling with it) and is due from the next step on;
 * a matched special is due at once, but when another one goes off first it is lit and waits likewise.
 * With `specials` off, only the player's own match leaves a special behind; the others just clear.
 * Null when nothing matches and nothing is lit: the board is calm.
 */
export function resolveStep(
  b: Board,
  swap: PendingSwap | null,
  cascadeLevel: number,
  scorer: TargetScorer,
  fuse: number[],
  specials = true,
): Step | null {
  const step: Step = { events: [], tally: newTally() };
  const ctx = newCtx(b, step, scorer, cascadeLevel, fuse, specials);
  return stepInto(ctx, swap) ? step : null;
}

/** Finale opening: up to `count` random plain pieces turn into line specials. */
export function convertForFinale(b: Board, count: number): CreatedPiece[] {
  const plain = shuffleInPlace(
    b,
    b.cells.flatMap((cell, i) => (cell.piece && cell.chain === 0 && cell.piece.special === Special.None ? [i] : [])),
  );
  return plain.slice(0, Math.min(count, FINALE_CONVERSIONS)).map((i) => {
    const piece = b.cells[i].piece!;
    piece.special = random(b) < 0.5 ? Special.LineH : Special.LineV;
    return { pos: posOf(b, i), piece };
  });
}

/** Finale and last chance on a calm board: every special not lit yet is lit, in random order. */
export function lightAll(b: Board, fuse: number[]): LitPiece[] {
  const specials = shuffleInPlace(
    b,
    b.cells.flatMap((cell, i) => (cell.piece && cell.piece.special !== Special.None && !fuse.includes(cell.piece.id) ? [i] : [])),
  );
  return specials.map((i) => {
    const id = b.cells[i].piece!.id;
    fuse.push(id);
    return { id, pos: posOf(b, i), order: 0 };
  });
}

/** Appends one step to `step`; false when there is nothing to clear. */
function stepInto(ctx: Ctx, swap: PendingSwap | null): boolean {
  const b = ctx.b;
  // Only specials lit in earlier steps are due: whatever this step lights waits for the next one.
  const due = ctx.fuse.length;
  if (swap && isComboPair(b.cells[swap.to].piece!, b.cells[swap.from].piece!)) runCombo(ctx, swap.to, swap.from);
  // The player's match is found before the fuse goes off, so a blast never steals it.
  const groups = findGroups(b, swap ? [swap.to, swap.from] : []);
  clearGroups(ctx, groups, swap);
  const fired = fireNext(ctx, due);
  if (ctx.removed.length === 0 && groups.length === 0 && !fired) return false;
  finishStep(ctx);
  ctx.events.push({ type: 'fall', moves: settle(b) });
  return true;
}

/**
 * The topmost due special goes off (leftmost on a tie), so a field of lit specials burns from the top down
 * instead of the upper ones falling into the blasts below. Due are those lit before this step and those matched in it;
 * matched ones left over are lit. Lit ones swapped into a combo meanwhile are gone already.
 */
function fireNext(ctx: Ctx, due: number): boolean {
  const ids = ctx.fuse.splice(0, due);
  const live = ids.flatMap((id) => {
    const i = ctx.b.cells.findIndex((cell) => cell.piece?.id === id);
    return i === -1 ? [] : [{ i, matched: false }];
  });
  for (const i of ctx.matched) if (!ids.includes(ctx.b.cells[i].piece!.id)) live.push({ i, matched: true });
  if (live.length === 0) return false;
  // Row-major cells: the smallest index is the topmost, then leftmost.
  const next = live.reduce((top, s) => (s.i < top.i ? s : top));
  const rest = live.filter((s) => s !== next);
  ctx.fuse.unshift(...rest.flatMap((s) => (s.matched ? [] : [ctx.b.cells[s.i].piece!.id])));
  for (const s of rest) if (s.matched) light(ctx, s.i, 0);
  unchain(ctx, next.i, 0);
  removePiece(ctx, next.i, 0, -1, true);
  return true;
}

function newCtx(b: Board, step: Step, scorer: TargetScorer, cascadeLevel: number, fuse: number[], specials: boolean): Ctx {
  return {
    b,
    tally: step.tally,
    scorer,
    events: step.events,
    multiplier: Math.min(cascadeLevel + 1, MAX_MULTIPLIER),
    cascade: cascadeLevel,
    removed: [],
    blasts: [],
    layers: new Map(),
    popups: [],
    queue: [],
    matched: [],
    pending: [],
    crateHits: new Set(),
    fuse,
    lit: [],
    combo: null,
    specials,
  };
}

/** Fires queued specials, places newly created ones and emits the clear event. */
function finishStep(ctx: Ctx): void {
  while (ctx.queue.length > 0) activate(ctx, ctx.queue.shift()!);

  const created: CreatedPiece[] = [];
  for (const { i, piece } of ctx.pending) {
    const cell = ctx.b.cells[i];
    if (cell.piece) continue;
    cell.piece = piece;
    created.push({ pos: posOf(ctx.b, i), piece });
  }
  for (const popup of ctx.popups) ctx.tally.score += popup.value;
  ctx.events.push({
    type: 'clear',
    cascade: ctx.cascade,
    removed: ctx.removed,
    created,
    blasts: ctx.blasts,
    layers: [...ctx.layers.values()],
    popups: ctx.popups,
    lit: ctx.lit,
    combo: ctx.combo,
  });
}

function clearGroups(ctx: Ctx, groups: MatchGroup[], swap: PendingSwap | null): void {
  for (const g of groups) {
    // The player's own match always earns its special; other matches only while `specials` is on.
    const own = swap !== null && (g.cells.includes(swap.to) || g.cells.includes(swap.from));
    const special = (own || ctx.specials) && g.special !== Special.None ? newPiece(ctx.b, g.color, g.special) : null;
    let points = 0;
    for (const i of g.cells) {
      const cell = ctx.b.cells[i];
      if (cell.chain > 0) {
        cell.chain--;
        markLayer(ctx, i, 0);
        points += LAYER_POINTS;
      } else if (cell.piece && cell.piece.special !== Special.None) {
        ctx.matched.push(i);
      } else if (cell.piece) {
        points += removePiece(ctx, i, 0, special ? special.id : -1, false);
      }
      points += hitCratesAround(ctx, i, 0);
    }
    if (special) {
      ctx.pending.push({ i: g.at, piece: special });
      points += SPECIAL_BONUS[special.special];
    }
    const center = centroid(ctx.b, g.cells);
    ctx.popups.push({ ...center, value: points, order: 0 });
  }
}

/** A piece cleared like a match damages the crates next to it; each crate once per step. Returns points. */
function hitCratesAround(ctx: Ctx, i: number, order: number): number {
  let points = 0;
  for (const j of neighbors4(ctx.b, i)) {
    if (ctx.b.cells[j].crate > 0 && !ctx.crateHits.has(j)) {
      ctx.crateHits.add(j);
      points += hit(ctx, j, order);
    }
  }
  return points;
}

/**
 * Damages whatever is in the cell: chain first, then the piece (and its ice), or a crate. Returns points.
 * A special is lit instead of removed: it goes off in a later step.
 */
function hit(ctx: Ctx, i: number, order: number): number {
  const cell = ctx.b.cells[i];
  if (!cell.exists) return 0;
  if (cell.piece) {
    if (cell.chain > 0) {
      cell.chain--;
      markLayer(ctx, i, order);
      return LAYER_POINTS;
    }
    if (cell.piece.special !== Special.None) {
      light(ctx, i, order);
      return 0;
    }
    return removePiece(ctx, i, order, -1, true);
  }
  if (cell.crate > 0) {
    cell.crate--;
    if (cell.crate === 0) ctx.tally.crate++;
    markLayer(ctx, i, order);
    return LAYER_POINTS;
  }
  return 0;
}

function removePiece(ctx: Ctx, i: number, order: number, mergeInto: number, activateSpecial: boolean): number {
  const cell = ctx.b.cells[i];
  const piece = cell.piece!;
  cell.piece = null;
  ctx.removed.push({ id: piece.id, pos: posOf(ctx.b, i), color: piece.color, order, mergeInto });
  if (piece.color !== NO_COLOR) ctx.tally.collected[piece.color]++;
  let points = PIECE_POINTS * ctx.multiplier;
  if (cell.ice > 0) {
    cell.ice--;
    if (cell.ice === 0) ctx.tally.ice++;
    markLayer(ctx, i, order);
    points += LAYER_POINTS;
  }
  if (activateSpecial && piece.special !== Special.None) {
    ctx.queue.push({ piece, i, order: order + 1, carry: Special.None });
  }
  return points;
}

/** Queues the special in the cell to go off in a later step; lit once, further hits change nothing. */
function light(ctx: Ctx, i: number, order: number): void {
  const id = ctx.b.cells[i].piece!.id;
  if (ctx.fuse.includes(id)) return;
  ctx.fuse.push(id);
  ctx.lit.push({ id, pos: posOf(ctx.b, i), order });
}

/** Forced removal (a lit special going off) breaks every chain layer at once. */
function unchain(ctx: Ctx, i: number, order: number): void {
  if (ctx.b.cells[i].chain === 0) return;
  ctx.b.cells[i].chain = 0;
  markLayer(ctx, i, order);
}

function markLayer(ctx: Ctx, i: number, order: number): void {
  const cell = ctx.b.cells[i];
  const prev = ctx.layers.get(i);
  ctx.layers.set(i, {
    pos: posOf(ctx.b, i),
    ice: cell.ice,
    crate: cell.crate,
    chain: cell.chain,
    order: prev ? Math.min(prev.order, order) : order,
  });
}

// ---------- specials ----------

type Activator = (ctx: Ctx, a: Activation) => void;

/** Special piece behavior. A new special kind = one entry here + its art. */
const ACTIVATORS: Record<Special, Activator> = {
  [Special.None]: () => undefined,
  [Special.LineH]: (ctx, a) => blast(ctx, BlastKind.Row, a.i, rowCells(ctx.b, a.i), a.order),
  [Special.LineV]: (ctx, a) => blast(ctx, BlastKind.Col, a.i, colCells(ctx.b, a.i), a.order),
  [Special.Bomb]: (ctx, a) => blast(ctx, BlastKind.Bomb, a.i, squareCells(ctx.b, a.i, 1), a.order),
  [Special.Spark]: (ctx, a) => spark(ctx, a.i, a.order, a.carry),
  [Special.Prism]: (ctx, a) => wipeColor(ctx, a.i, mostCommonColor(ctx.b), a.order),
};

function activate(ctx: Ctx, a: Activation): void {
  ACTIVATORS[a.piece.special](ctx, a);
}

/** `splash`: every hit cell also damages neighboring crates, as if its piece were matched. */
function blast(ctx: Ctx, kind: BlastKind, origin: number, cells: number[], order: number, color = NO_COLOR, splash = false): void {
  ctx.blasts.push({
    kind,
    origin: posOf(ctx.b, origin),
    cells: cells.map((i) => posOf(ctx.b, i)),
    order,
    target: null,
    color,
  });
  let points = 0;
  for (const i of cells) {
    points += hit(ctx, i, order);
    if (splash) points += hitCratesAround(ctx, i, order);
  }
  const o = posOf(ctx.b, origin);
  if (points > 0) ctx.popups.push({ r: o.r, c: o.c, value: points, order });
}

/** `splash`: the spark also hits the four cells around its origin; a pair of sparks splashes once, not per spark. */
function spark(ctx: Ctx, origin: number, order: number, carry: Special, splash = true): void {
  const around = neighbors4(ctx.b, origin);
  const near = splash ? around : [];
  const target = pickTarget(ctx, new Set([origin, ...around]));
  ctx.blasts.push({
    kind: BlastKind.Spark,
    origin: posOf(ctx.b, origin),
    cells: near.map((i) => posOf(ctx.b, i)),
    order,
    target: target === -1 ? null : posOf(ctx.b, target),
    color: NO_COLOR,
  });
  let points = 0;
  for (const i of near) points += hit(ctx, i, order);
  if (target !== -1) {
    if (carry === Special.None) points += hit(ctx, target, order + 1);
    else ACTIVATORS[carry](ctx, { piece: { id: -1, color: NO_COLOR, special: carry }, i: target, order: order + 1, carry: Special.None });
  }
  const o = posOf(ctx.b, origin);
  if (points > 0) ctx.popups.push({ r: o.r, c: o.c, value: points, order });
}

function pickTarget(ctx: Ctx, exclude: Set<number>): number {
  let best = -1;
  let bestScore = -Infinity;
  ctx.b.cells.forEach((cell, i) => {
    if (!cell.exists || exclude.has(i) || (!cell.piece && cell.crate === 0)) return;
    // A lit special goes off anyway: a spark spent on it would be wasted.
    if (cell.piece && ctx.fuse.includes(cell.piece.id)) return;
    const score = ctx.scorer(ctx.b, i, ctx.tally) + random(ctx.b) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function wipeColor(ctx: Ctx, origin: number, color: number, order: number): void {
  if (color === NO_COLOR) return;
  const cells = ctx.b.cells.flatMap((cell, i) => (cell.piece?.color === color ? [i] : []));
  // Wiped pieces count as matched: crates next to them crack, like next to any match.
  blast(ctx, BlastKind.Prism, origin, cells, order, color, true);
}

function mostCommonColor(b: Board): number {
  const counts = new Array<number>(MAX_COLORS).fill(0);
  for (const cell of b.cells) if (cell.piece && cell.piece.color !== NO_COLOR) counts[cell.piece.color]++;
  const max = Math.max(...counts);
  return max === 0 ? NO_COLOR : counts.indexOf(max);
}

// ---------- combos ----------

const Kind = { Plain: 'plain', Line: 'line', Bomb: 'bomb', Spark: 'spark', Prism: 'prism' } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

function kindOf(s: Special): Kind {
  switch (s) {
    case Special.LineH:
    case Special.LineV:
      return Kind.Line;
    case Special.Bomb:
      return Kind.Bomb;
    case Special.Spark:
      return Kind.Spark;
    case Special.Prism:
      return Kind.Prism;
    default:
      return Kind.Plain;
  }
}

/** Combo effect at `center`; `p` and `q` are the two swapped pieces (already removed from the board). */
type ComboFn = (ctx: Ctx, center: number, p: Piece, q: Piece) => void;

/** Keyed by the two kinds in alphabetical order. A new combo = one entry. */
const COMBOS: Partial<Record<string, ComboFn>> = {
  'line+line': (ctx, center) => {
    blast(ctx, BlastKind.Row, center, rowCells(ctx.b, center), 0);
    blast(ctx, BlastKind.Col, center, colCells(ctx.b, center), 0);
  },
  'bomb+line': (ctx, center) => {
    const { r, c } = posOf(ctx.b, center);
    for (let d = -1; d <= 1; d++) {
      if (r + d >= 0 && r + d < ctx.b.rows) blast(ctx, BlastKind.Row, center + d * ctx.b.cols, rowCells(ctx.b, center + d * ctx.b.cols), 0);
      if (c + d >= 0 && c + d < ctx.b.cols) blast(ctx, BlastKind.Col, center + d, colCells(ctx.b, center + d), 0);
    }
  },
  'bomb+bomb': (ctx, center) => blast(ctx, BlastKind.Bomb, center, squareCells(ctx.b, center, 2), 0),
  // Two sparks make a rare combo: twice what two separate sparks would hit.
  'spark+spark': (ctx, center) => {
    for (let k = 0; k < SPARK_PAIR_TARGETS; k++) spark(ctx, center, k, Special.None, k === 0);
  },
  'line+spark': (ctx, center, p, q) => spark(ctx, center, 0, p.special === Special.Spark ? q.special : p.special),
  'bomb+spark': (ctx, center) => spark(ctx, center, 0, Special.Bomb),
  'prism+prism': (ctx, center) => {
    const all = ctx.b.cells.flatMap((cell, i) => (cell.exists ? [i] : []));
    blast(ctx, BlastKind.Prism, center, all, 0);
  },
};

function runCombo(ctx: Ctx, center: number, otherCell: number): void {
  const p = ctx.b.cells[center].piece!;
  const q = ctx.b.cells[otherCell].piece!;
  const kinds = [kindOf(p.special), kindOf(q.special)].sort();
  const key = kinds.join('+');
  ctx.combo = posOf(ctx.b, center);

  // Prism with a plain piece wipes its color; with a special it turns that color into copies of it.
  if (kinds.includes(Kind.Prism) && key !== 'prism+prism') {
    const partner = p.special === Special.Prism ? q : p;
    const prismCell = p.special === Special.Prism ? center : otherCell;
    removePiece(ctx, prismCell, 0, -1, false);
    if (partner.special === Special.None) {
      wipeColor(ctx, prismCell, partner.color, 0);
    } else {
      spreadSpecial(ctx, prismCell, partner);
    }
    return;
  }

  removePiece(ctx, center, 0, -1, false);
  removePiece(ctx, otherCell, 0, -1, false);
  COMBOS[key]?.(ctx, center, p, q);
}

/** The partner's color turns into copies of it, all lit: they go off one by one, nearest to the prism first. */
function spreadSpecial(ctx: Ctx, origin: number, partner: Piece): void {
  const o = posOf(ctx.b, origin);
  const distance = (i: number): number => {
    const p = posOf(ctx.b, i);
    return Math.hypot(p.r - o.r, p.c - o.c);
  };
  const targets = ctx.b.cells
    .flatMap((cell, i) => (cell.piece?.color === partner.color ? [i] : []))
    .sort((x, y) => distance(x) - distance(y));
  const isLine = kindOf(partner.special) === Kind.Line;
  const pieces = targets.map((i) => {
    const piece = ctx.b.cells[i].piece!;
    if (piece.special === Special.None) {
      piece.special = isLine ? (random(ctx.b) < 0.5 ? Special.LineH : Special.LineV) : partner.special;
    }
    return { pos: posOf(ctx.b, i), piece };
  });
  ctx.events.push({ type: 'transform', pieces });
  ctx.blasts.push({
    kind: BlastKind.Prism,
    origin: o,
    cells: targets.map((i) => posOf(ctx.b, i)),
    order: 0,
    target: null,
    color: partner.color,
  });
  for (const i of targets) light(ctx, i, 1);
}

// ---------- areas ----------

function rowCells(b: Board, i: number): number[] {
  const r = Math.floor(i / b.cols);
  return Array.from({ length: b.cols }, (_, c) => r * b.cols + c).filter((j) => b.cells[j].exists);
}

function colCells(b: Board, i: number): number[] {
  const c = i % b.cols;
  return Array.from({ length: b.rows }, (_, r) => r * b.cols + c).filter((j) => b.cells[j].exists);
}

function squareCells(b: Board, i: number, radius: number): number[] {
  const { r, c } = posOf(b, i);
  const cells: number[] = [];
  for (let y = r - radius; y <= r + radius; y++) {
    for (let x = c - radius; x <= c + radius; x++) {
      if (y >= 0 && y < b.rows && x >= 0 && x < b.cols && b.cells[y * b.cols + x].exists) cells.push(y * b.cols + x);
    }
  }
  return cells;
}

function centroid(b: Board, cells: number[]): { r: number; c: number } {
  let r = 0;
  let c = 0;
  for (const i of cells) {
    const p = posOf(b, i);
    r += p.r;
    c += p.c;
  }
  return { r: r / cells.length, c: c / cells.length };
}
