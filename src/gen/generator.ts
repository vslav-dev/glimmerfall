import { RANDOM_BOT, type SimResult, simulate, STRONG_BOT, type BotStyle } from '@/bot/bot';
import { FINALE_CONVERSIONS } from '@/core/resolve';
import { hashSeed, pick, randInt, random, type RngHolder } from '@/core/rng';
import { type LevelDef, LevelKind, Mechanic, NO_COLOR, type Objective, ObjectiveKind } from '@/core/types';
import { type LevelPlan, planLevel } from '@/gen/plan';
import type { TwinStyle } from '@/player/style';

/** Bumped whenever the same request builds a different level: a replay needs the generator that built its level. */
export const GEN_VERSION = 3;
/** Levels everyone shares: the tutorial, and the first read of the player's style. */
const COMMON_LEVELS = 5;
/** How deliberate the shared levels assume the player to be. */
const COMMON_CRAFT = 0.3;
/** Layouts tried per level; the one that suits the player's style wins. */
const CANDIDATES = 3;
/** Twin runs per candidate while its goals are tuned to the intended length. */
const SHAPE_SIMS = 12;
/** Strong and random bot runs per candidate: how much skill matters on it. */
const PROBE_SIMS = 8;
/** Twin runs of the chosen layout that set the moves and the stars: ±7 % on the win rate. */
const SIMS = 48;
/** Won runs that also measure the finale. */
const FINALE_RUNS = 8;
const SIM_MAX_MOVES = 64;
const MIN_MOVES = 14;
const MAX_MOVES = 50;
/** Twin length a level is tuned to at most, so a slow twin still fits the move cap with room for the target win rate. */
const MAX_TWIN_LENGTH = 40;
const MIN_COLORS = 4;
/** Score-goal levels can never be completed early during calibration. */
const UNREACHABLE = Number.MAX_SAFE_INTEGER;
/** Quantiles of the twin's winning final scores: 3 stars about once in 6–7 wins, whatever the difficulty. */
const TWO_STARS = 0.4;
const THREE_STARS = 0.85;

export interface DraftRequest {
  /** the player's own seed: levels after the shared ones differ per player */
  seed: number;
  number: number;
  /** the player's style the level is built and calibrated for */
  style: TwinStyle;
  /** how many times fewer moves than the twin the player needs: goals grow so the player's level lasts its length */
  pace: number;
}

/** One twin run of a goal level: what it takes to win with a given number of moves. */
export interface CalibrationRun {
  /** moves needed to complete the goals by play; any level with at least that many is won */
  needed: number | null;
  /** score at completion */
  score: number;
  /** move counts below `needed` that still win through the last chance, each with its final score */
  chances: [number, number][];
}

/** Twin bot results that let a level be finalized for any target win rate without simulating again. */
export interface Calibration {
  /** goal levels: the twin's runs */
  runs: CalibrationRun[];
  /** goal levels: score the finale adds per move left */
  finale: number;
  /** score levels: score after the fixed moves per run, ascending */
  scores: number[];
  /** score levels: the fixed move count; 0 for goal levels */
  fixedMoves: number;
}

export interface LevelDraft {
  /** the generator that built it */
  version: number;
  request: DraftRequest;
  /** which candidate layout won */
  variant: number;
  level: LevelDef;
  calibration: Calibration;
}

/** Layout, goals and twin calibration. Deterministic per request. */
export function draftLevel(req: DraftRequest): LevelDraft {
  const n = req.number;
  const plan = planLevel(n);
  const common = n <= COMMON_LEVELS;
  const seed = common ? 0 : req.seed;
  const craft = common ? COMMON_CRAFT : req.style.craft;
  // A new mechanic is introduced on its plain layout: the lesson matters more than the fit.
  const count = common || plan.intro ? 1 : CANDIDATES;

  // The twin plays slower or faster than the player: its length is the player's, scaled by their pace.
  const length = Math.min(MAX_TWIN_LENGTH, Math.round(playerLength(n) * req.pace));
  let best: LevelDef | null = null;
  let bestFit = -Infinity;
  let variant = 0;
  for (let v = 0; v < count; v++) {
    const level = buildLayout(n, plan, hashSeed(seed, n, v), craft, length);
    const twin = shapeGoals(level, req.style, length, hashSeed(seed, n, v, 1));
    if (count === 1) {
      best = level;
      break;
    }
    const fit = fitness(level, twin, craft, hashSeed(seed, n, v, 2));
    if (best === null || fit > bestFit) {
      best = level;
      bestFit = fit;
      variant = v;
    }
  }
  return { version: GEN_VERSION, request: req, variant, level: best!, calibration: calibrate(best!, req.style, hashSeed(seed, n, 3)) };
}

/** Picks the moves (or the score goal) so the twin wins with the requested probability, and sets the stars. */
export function finalizeLevel(draft: LevelDraft, targetWinRate: number): LevelDef {
  const level: LevelDef = structuredClone(draft.level);
  const cal = draft.calibration;
  level.targetWinRate = targetWinRate;

  if (cal.fixedMoves > 0) {
    const { scores } = cal;
    const scoreGoal = level.objectives[0];
    scoreGoal.target = roundTo(Math.max(500, scores[scores.length - 1 - rankOf(targetWinRate, scores.length)]), 50);
    level.moves = cal.fixedMoves;
    level.stars = starsFrom(scoreGoal.target, scores.filter((s) => s >= scoreGoal.target));
    return level;
  }

  // The move count whose share of winning runs comes closest to the target; the fewer moves on a tie.
  const winners = (moves: number): number[] => cal.runs.flatMap((run) => finalScore(run, moves, cal.finale) ?? []);
  let best = MIN_MOVES;
  let bestMiss = Infinity;
  for (let moves = MIN_MOVES; moves <= MAX_MOVES; moves++) {
    const miss = Math.abs(winners(moves).length / cal.runs.length - targetWinRate);
    if (miss < bestMiss) {
      best = moves;
      bestMiss = miss;
    }
  }
  level.moves = best;
  level.stars = starsFrom(0, winners(best).sort((a, b) => a - b));
  return level;
}

/**
 * The run's final score with this many moves, or null when it loses. A run that wins with moves to spare
 * scores its finale on top, as the player's game does; a last-chance win holds for its exact move count only.
 */
function finalScore(run: CalibrationRun, moves: number, finale: number): number | null {
  if (run.needed !== null && run.needed <= moves) return run.score + finale * Math.min(FINALE_CONVERSIONS, moves - run.needed);
  return run.chances.find(([m]) => m === moves)?.[1] ?? null;
}

/** Moves the twin typically needs to complete the finalized level; null when most of its runs never do. */
export function twinMoves(draft: LevelDraft, level: LevelDef): number | null {
  const cal = draft.calibration;
  if (cal.fixedMoves > 0) {
    const perMove = quantile(cal.scores, 0.5) / cal.fixedMoves;
    return perMove > 0 ? level.objectives[0].target / perMove : null;
  }
  const typical = median(cal.runs.map((r) => r.needed ?? Infinity));
  return Number.isFinite(typical) ? typical : null;
}

/** Index into ascending results that leaves `rate` of the runs winning. */
function rankOf(rate: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.ceil(rate * count) - 1));
}

/** Star thresholds from the twin's winning final scores, ascending; `first` is the one-star score. */
function starsFrom(first: number, winners: number[]): [number, number, number] {
  const two = Math.max(first + 50, 100, roundTo(quantile(winners, TWO_STARS), 50));
  const three = Math.max(two + 50, roundTo(quantile(winners, THREE_STARS), 50));
  return [first, two, three];
}

// ---------- simulation ----------

function isScoreLevel(level: LevelDef): boolean {
  return level.objectives.some((o) => o.kind === ObjectiveKind.Score);
}

/** Moves the player is meant to spend on a goal level: a level is a stay, not a few quick swaps. */
function playerLength(n: number): number {
  return 18 + Math.min(10, Math.floor(n / 5));
}

function fixedMovesOf(n: number): number {
  return 20 + Math.min(10, Math.floor(n / 8));
}

/** `full`: the final calibration, which also measures the finale and looks for last-chance wins. */
function runs(level: LevelDef, style: BotStyle, moves: number, count: number, seed: number, full = false): SimResult[] {
  return Array.from({ length: count }, (_, k) =>
    simulate(level, hashSeed(seed, k), moves, style, full ? { finale: k < FINALE_RUNS, chancesUpTo: MAX_MOVES } : {}),
  );
}

/** One number per run, higher is better: moves are inverted for goal levels, score per move for score levels. */
function efficiency(level: LevelDef, r: SimResult): number {
  if (isScoreLevel(level)) return r.score / fixedMovesOf(level.number);
  return r.needed === null ? 0 : 1 / r.needed;
}

/** Tunes the goals so the twin's typical run lasts `length` moves. Returns the twin's efficiencies. */
function shapeGoals(level: LevelDef, style: BotStyle, length: number, seed: number): number[] {
  if (isScoreLevel(level)) return runs(level, style, fixedMovesOf(level.number), SHAPE_SIMS, seed).map((r) => efficiency(level, r));
  let results = runs(level, style, SIM_MAX_MOVES, SHAPE_SIMS, seed);
  for (let pass = 0; pass < 2 && adjustLength(level, medianNeeded(results), length); pass++) {
    results = runs(level, style, SIM_MAX_MOVES, SHAPE_SIMS, seed);
  }
  return results.map((r) => efficiency(level, r));
}

/**
 * How well a candidate suits the player. A deliberate player wants a level where skill decides:
 * a wide gap between the strong and the random bot. A random tapper wants one where luck does not swing
 * the result: a narrow spread of their twin's runs. A level the strong bot cannot finish is out.
 */
function fitness(level: LevelDef, twin: number[], craft: number, seed: number): number {
  // Past the most moves a level can get, a run tells nothing: the random bot stops there.
  const moves = isScoreLevel(level) ? fixedMovesOf(level.number) : MAX_MOVES;
  const typical = (style: BotStyle, k: number): number =>
    median(runs(level, style, moves, PROBE_SIMS, hashSeed(seed, k)).map((r) => efficiency(level, r)));
  const strong = typical(STRONG_BOT, 0);
  if (strong === 0) return -Infinity;
  const gap = Math.max(0, strong - typical(RANDOM_BOT, 1)) / strong;
  const sorted = [...twin].sort((a, b) => a - b);
  const mid = quantile(sorted, 0.5);
  const spread = mid > 0 ? (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / mid : 1;
  return craft * gap - (1 - craft) * spread;
}

function calibrate(level: LevelDef, style: BotStyle, seed: number): Calibration {
  if (isScoreLevel(level)) {
    const fixedMoves = fixedMovesOf(level.number);
    const scores = runs(level, style, fixedMoves, SIMS, seed).map((r) => r.score);
    return { runs: [], finale: 0, scores: scores.sort((a, b) => a - b), fixedMoves };
  }
  const results = runs(level, style, SIM_MAX_MOVES, SIMS, seed, true);
  const measured = results.filter((r) => r.finale > 0);
  return {
    runs: results.map(({ needed, score, chances }) => ({ needed, score, chances })),
    finale: measured.length > 0 ? measured.reduce((sum, r) => sum + r.finale, 0) / measured.length : 0,
    scores: [],
    fixedMoves: 0,
  };
}

function medianNeeded(results: SimResult[]): number {
  const sorted = results.map((r) => r.needed ?? Infinity).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Scales collect amounts, or strengthens / weakens crates and ice, towards the intended length.
 * Returns whether it changed anything.
 */
function adjustLength(level: LevelDef, median: number, length: number): boolean {
  const collects = level.objectives.filter((o) => o.kind === ObjectiveKind.Collect);
  if (collects.length > 0) {
    const factor = Number.isFinite(median) ? Math.min(3, Math.max(0.5, length / median)) : 0.6;
    if (Math.abs(factor - 1) <= 0.15) return false;
    for (const o of collects) o.target = Math.max(8, Math.round(o.target * factor));
    return true;
  }
  const kinds = level.objectives.map((o) => o.kind);
  const [layer, max] = kinds.includes(ObjectiveKind.Crate) ? [level.crate, 3] : kinds.includes(ObjectiveKind.Ice) ? [level.ice, 2] : [null, 0];
  // Too quick: thicker layers. Too slow (a random tapper's twin): thinner ones.
  const delta = median < length * 0.75 ? 1 : median > length * 1.5 ? -1 : 0;
  if (!layer || delta === 0) return false;
  let changed = false;
  for (let i = 0; i < layer.length; i++) {
    if (layer[i] > 0 && layer[i] + delta >= 1 && layer[i] + delta <= max) {
      layer[i] += delta;
      changed = true;
    }
  }
  return changed;
}

// ---------- layout ----------

/**
 * One candidate layout with goals. `craft` (0 random taps … 1 planning) sets how intricate it gets:
 * holes in the board, crate shelves, chains, thick layers, a sixth color, double goals.
 * `length`, the twin's intended moves, sizes the crate and ice goals: their amount is the layout itself.
 */
function buildLayout(n: number, plan: LevelPlan, seed: number, craft: number, length: number): LevelDef {
  const shapeRng: RngHolder = { rng: hashSeed(seed, 11) };
  const blockRng: RngHolder = { rng: hashSeed(seed, 22) };
  const goalRng: RngHolder = { rng: hashSeed(seed, 33) };

  const cols = n <= 3 ? 7 : pick(shapeRng, [7, 8, 8]);
  const rows = Math.min(9, cols + pick(shapeRng, [0, 1, 1]));
  const mask = makeShape(rows, cols, n, craft, shapeRng);
  const size = rows * cols;

  const colors = chooseColors(n, plan, craft, goalRng);
  const goals = chooseGoals(n, plan, craft, goalRng);
  const collectCount = !goals.includes(ObjectiveKind.Collect) ? 0 : n >= 15 && random(goalRng) < 0.2 + 0.4 * craft ? 2 : 1;
  const collect = pickColors(goalRng, collectCount);

  const crate = new Array<number>(size).fill(0);
  const ice = new Array<number>(size).fill(0);
  const chain = new Array<number>(size).fill(0);
  const grid: Grid = { rows, cols, mask, blocked: (i) => crate[i] > 0 || chain[i] > 0 };
  if (goals.includes(ObjectiveKind.Crate) || (plan.mechanics.has(Mechanic.Crate) && n >= 25 && random(blockRng) < 0.6 * craft)) {
    placeCrates(grid, crate, n, craft, length, blockRng);
  }
  if (goals.includes(ObjectiveKind.Ice)) placeIce(grid, ice, crate, n, craft, length, blockRng);
  if (plan.intro === Mechanic.Chain || (plan.mechanics.has(Mechanic.Chain) && random(blockRng) < 0.25 + 0.4 * craft)) {
    placeChains(grid, chain, crate, n, craft, blockRng);
  }

  const objectives: Objective[] = [];
  for (const g of goals) {
    if (g === ObjectiveKind.Collect) {
      const each = Math.round(Math.min(40, 12 + n * 0.3) * (collect.length > 1 ? 0.7 : 1) * (colors >= 6 ? 0.85 : 1));
      for (const color of collect) objectives.push({ kind: g, target: each, color });
    } else if (g === ObjectiveKind.Ice) {
      objectives.push({ kind: g, target: ice.filter((v) => v > 0).length, color: NO_COLOR });
    } else if (g === ObjectiveKind.Crate) {
      objectives.push({ kind: g, target: crate.filter((v) => v > 0).length, color: NO_COLOR });
    } else {
      objectives.push({ kind: g, target: UNREACHABLE, color: NO_COLOR });
    }
  }

  return {
    number: n,
    rows,
    cols,
    mask,
    ice,
    crate,
    chain,
    colors,
    moves: SIM_MAX_MOVES,
    objectives,
    stars: [0, 0, 0],
    kind: plan.kind,
    intro: plan.intro,
    targetWinRate: plan.baseWinRate,
  };
}

/** Random tappers get four colors more often (more cascades, more show); deliberate players meet a sixth. */
function chooseColors(n: number, plan: LevelPlan, craft: number, h: RngHolder): number {
  if (n <= 2) return MIN_COLORS;
  const four = Math.max(0, 0.5 - 2 * craft);
  const six = n > 30 ? (plan.kind === LevelKind.Hard ? 0.5 : n > 60 ? 0.25 : 0) * 2 * craft : 0;
  const roll = random(h);
  return roll < four ? 4 : roll >= 1 - six ? 6 : 5;
}

function chooseGoals(n: number, plan: LevelPlan, craft: number, h: RngHolder): ObjectiveKind[] {
  switch (plan.intro) {
    case Mechanic.Ice:
      return [ObjectiveKind.Ice];
    case Mechanic.Crate:
      return [ObjectiveKind.Crate];
    case Mechanic.Chain:
      return [ObjectiveKind.Collect];
    case Mechanic.DoubleGoal:
      return [ObjectiveKind.Collect, pick(h, [ObjectiveKind.Ice, ObjectiveKind.Crate])];
  }
  if (n === 1) return [ObjectiveKind.Collect];
  if (n === 2) return [ObjectiveKind.Score];

  const pool: [ObjectiveKind, number][] = [
    [ObjectiveKind.Score, 1],
    [ObjectiveKind.Collect, 3],
  ];
  if (plan.mechanics.has(Mechanic.Ice)) pool.push([ObjectiveKind.Ice, 3]);
  if (plan.mechanics.has(Mechanic.Crate)) pool.push([ObjectiveKind.Crate, 3]);

  const first = weighted(h, pool);
  if (first === ObjectiveKind.Score || !plan.mechanics.has(Mechanic.DoubleGoal) || random(h) >= 0.8 * craft) {
    return [first];
  }
  const rest = pool.filter(([kind]) => kind !== first && kind !== ObjectiveKind.Score);
  return rest.length > 0 ? [first, weighted(h, rest)] : [first];
}

/** Goal colors come from the first MIN_COLORS, so every level has them. */
function pickColors(h: RngHolder, count: number): number[] {
  const all = Array.from({ length: MIN_COLORS }, (_, i) => i);
  const result: number[] = [];
  while (result.length < count && all.length > 0) result.push(all.splice(randInt(h, all.length), 1)[0]);
  return result.sort((a, b) => a - b);
}

function weighted<T>(h: RngHolder, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let roll = random(h) * total;
  for (const [item, w] of items) {
    roll -= w;
    if (roll < 0) return item;
  }
  return items[items.length - 1][0];
}

export interface Grid {
  rows: number;
  cols: number;
  mask: number[];
  /** crate or chain: pieces neither fall into nor through it */
  blocked: (i: number) => boolean;
}

type ShapeRule = (r: number, c: number, rows: number, cols: number) => boolean;

/**
 * Board shapes, plainest first; every rule is mirror-symmetric because it only looks at distances from the edges.
 * The player's craft decides how far down the list a level may reach.
 */
const SHAPES: ShapeRule[] = [
  () => true,
  (r, c, rows, cols) => !(edge(r, rows) === 0 && edge(c, cols) === 0),
  (r, c, rows, cols) => edge(r, rows) + edge(c, cols) > 1,
  (r, c, rows, cols) => !(edge(c, cols) === 0 && Math.abs(r - (rows - 1) / 2) < 1),
  (r, c, rows, cols) => !(Math.abs(r - (rows - 1) / 2) < 1 && Math.abs(c - (cols - 1) / 2) < 1),
  (r, c, rows, cols) => !(edge(c, cols) === 1 && Math.abs(r - (rows - 1) / 2) < 1.5),
  (r, c, rows, cols) => !(edge(c, cols) === 0 && edge(r, rows) >= 2),
];

function makeShape(rows: number, cols: number, n: number, craft: number, h: RngHolder): number[] {
  const options = n <= 3 ? [SHAPES[0]] : SHAPES.slice(0, 1 + Math.round(craft * (SHAPES.length - 1)));
  for (let attempt = 0; attempt < 10; attempt++) {
    const rule = pick(h, options);
    const mask = Array.from({ length: rows * cols }, (_, i) => (rule(Math.floor(i / cols), i % cols, rows, cols) ? 1 : 0));
    if (mask.filter(Boolean).length >= rows * cols * 0.7 && isConnected(mask, rows, cols)) return mask;
  }
  return new Array<number>(rows * cols).fill(1);
}

function edge(x: number, size: number): number {
  return Math.min(x, size - 1 - x);
}

function isConnected(mask: number[], rows: number, cols: number): boolean {
  const start = mask.indexOf(1);
  if (start === -1) return false;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const y = r + dr;
      const x = c + dc;
      const j = y * cols + x;
      if (y >= 0 && y < rows && x >= 0 && x < cols && mask[j] === 1 && !seen.has(j)) {
        seen.add(j);
        stack.push(j);
      }
    }
  }
  return seen.size === mask.filter(Boolean).length;
}

/** Sets a blocker on a cell and its mirror twin, unless that would cut some free cell off from the refill. */
function setBlocker(grid: Grid, layer: number[], r: number, c: number, value: number): void {
  const cells = [c, grid.cols - 1 - c].map((x) => r * grid.cols + x).filter((i) => grid.mask[i] === 1);
  const before = cells.map((i) => layer[i]);
  for (const i of cells) layer[i] = value;
  if (!refillReachesAll(grid)) cells.forEach((i, k) => (layer[i] = before[k]));
}

/**
 * Follows the fall rules: a free cell is fed straight from above (holes are skipped) or diagonally
 * from a fed cell one row up. A cell nothing can feed empties for good and can leave the board without a move.
 */
export function refillReachesAll(grid: Grid): boolean {
  const { rows, cols, mask } = grid;
  const fed = new Array<boolean>(rows * cols).fill(false);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (mask[i] !== 1 || grid.blocked(i)) continue;
      let above = r - 1;
      while (above >= 0 && mask[above * cols + c] !== 1) above--;
      const straight = above < 0 || fed[above * cols + c];
      const diagonal = r > 0 && [c - 1, c + 1].some((x) => x >= 0 && x < cols && fed[(r - 1) * cols + x]);
      if (!straight && !diagonal) return false;
      fed[i] = true;
    }
  }
  return true;
}

/** Twin length the base amounts of crates and ice were set for; longer levels get proportionally more. */
const LAYER_LENGTH = 18;

function placeCrates(grid: Grid, crate: number[], n: number, craft: number, length: number, h: RngHolder): void {
  const cap = 1 + Math.round(2 * craft);
  const strength = (): number => Math.min(cap, n < 15 ? 1 : n < 40 ? 1 + randInt(h, 2) : 1 + randInt(h, 3));
  const half = Math.ceil(grid.cols / 2);
  if (random(h) < craft) {
    // A shelf: one row of crates from the walls inwards, leaving the middle open; what is under it is hard to reach.
    const r = 3 + randInt(h, Math.max(1, grid.rows - 5));
    const width = 1 + randInt(h, Math.max(1, half - 2));
    const s = strength();
    for (let c = 0; c < width; c++) setBlocker(grid, crate, r, c, s);
  }
  // Capped well below the board: the refill check refuses crates that would wall cells off anyway.
  const target = Math.min(Math.round(grid.rows * grid.cols * 0.4), Math.round((6 + Math.min(12, Math.floor(n / 5))) * (length / LAYER_LENGTH)));
  for (let guard = 0; guard < 100 && crate.filter(Boolean).length < target; guard++) {
    const r = 2 + randInt(h, Math.max(1, grid.rows - 3));
    setBlocker(grid, crate, r, randInt(h, half), strength());
  }
}

function placeIce(grid: Grid, ice: number[], crate: number[], n: number, craft: number, length: number, h: RngHolder): void {
  const { rows, cols } = grid;
  const fraction = Math.min(0.5, (0.22 + Math.min(0.25, n / 400)) * Math.sqrt(length / LAYER_LENGTH));
  const cr = (rows - 1) / 2;
  const cc = (cols - 1) / 2;
  const patterns: ((r: number, c: number) => boolean)[] = [
    (r, c) => Math.abs(r - cr) <= rows * fraction && Math.abs(c - cc) <= cols * fraction + 0.5,
    (r) => r >= rows - Math.max(2, Math.round(rows * fraction * 1.3)),
    (r, c) => edge(r, rows) === 0 || edge(c, cols) === 0,
    (r, c) => (r + c) % 2 === 0 && Math.abs(r - cr) <= rows * fraction * 1.4,
    (r, c) => edge(c, cols) <= 1 && Math.abs(r - cr) <= rows * fraction * 1.5,
  ];
  const pattern = pick(h, patterns);
  const thick = n >= 40 && random(h) < 0.7 * craft;
  for (let i = 0; i < ice.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (grid.mask[i] === 1 && crate[i] === 0 && pattern(r, c)) {
      ice[i] = thick && edge(r, rows) >= 2 && edge(c, cols) >= 2 ? 2 : 1;
    }
  }
  if (!ice.some(Boolean)) {
    for (let i = 0; i < ice.length; i++) if (grid.mask[i] === 1 && crate[i] === 0 && Math.floor(i / cols) >= rows - 2) ice[i] = 1;
  }
}

function placeChains(grid: Grid, chain: number[], crate: number[], n: number, craft: number, h: RngHolder): void {
  const target = 4 + Math.min(8, Math.floor(n / 10));
  const half = Math.ceil(grid.cols / 2);
  for (let guard = 0; guard < 100 && chain.filter(Boolean).length < target; guard++) {
    const r = 1 + randInt(h, grid.rows - 1);
    const c = randInt(h, half);
    if (crate[r * grid.cols + c] > 0) continue;
    setBlocker(grid, chain, r, c, n >= 50 && random(h) < 0.6 * craft ? 2 : 1);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
