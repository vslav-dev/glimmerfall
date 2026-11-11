import { pick, randInt, random, type RngHolder, hashSeed } from '@/core/rng';
import { type LevelDef, LevelKind, Mechanic, NO_COLOR, type Objective, ObjectiveKind } from '@/core/types';
import { type LevelPlan, planLevel } from '@/gen/plan';
import { simulate } from '@/gen/simulate';

const SIMS = 24;
const SIM_MAX_MOVES = 60;
const MIN_MOVES = 10;
const MAX_MOVES = 45;
const MIN_COLORS = 4;
/** Score-goal levels can never be completed early during calibration. */
const UNREACHABLE = Number.MAX_SAFE_INTEGER;

/** Bot results that let a level be finalized for any target win rate without simulating again. */
export interface Calibration {
  /** moves the bot needed per run, ascending; failed runs are Infinity (null in JSON) */
  needed: (number | null)[];
  /** score at completion of successful runs, ascending */
  scores: number[];
  /** score-goal levels: fixed move count and final scores per run, ascending */
  fixedMoves: number;
  fixedScores: number[];
}

export interface LevelDraft {
  level: LevelDef;
  calibration: Calibration;
}

export interface DraftRequest {
  number: number;
  /** number of failed attempts on this level; 3+ removes a color and leans the refill */
  assist: number;
}

/** Layout, goals and bot calibration. Deterministic per (number, assist); layout depends on number only. */
export function draftLevel(req: DraftRequest): LevelDraft {
  const n = req.number;
  const plan = planLevel(n);
  const shapeRng: RngHolder = { rng: hashSeed(n, 11) };
  const blockRng: RngHolder = { rng: hashSeed(n, 22) };
  const goalRng: RngHolder = { rng: hashSeed(n, 33) };

  const cols = n <= 3 ? 7 : pick(shapeRng, [7, 8, 8]);
  const rows = Math.min(9, cols + pick(shapeRng, [0, 1, 1]));
  const mask = makeShape(rows, cols, n, shapeRng);
  const size = rows * cols;

  let colors = chooseColors(n, plan, goalRng);
  const goals = chooseGoals(n, plan, goalRng);
  const collectCount = !goals.includes(ObjectiveKind.Collect) ? 0 : n >= 15 && random(goalRng) < 0.4 ? 2 : 1;
  const collect = pickColors(goalRng, collectCount);

  const crate = new Array<number>(size).fill(0);
  const ice = new Array<number>(size).fill(0);
  const chain = new Array<number>(size).fill(0);
  const grid = { rows, cols, mask };
  if (goals.includes(ObjectiveKind.Crate) || (plan.mechanics.has(Mechanic.Crate) && n >= 25 && random(blockRng) < 0.3)) {
    placeCrates(grid, crate, n, blockRng);
  }
  if (goals.includes(ObjectiveKind.Ice)) placeIce(grid, ice, crate, n, blockRng);
  if (plan.intro === Mechanic.Chain || (plan.mechanics.has(Mechanic.Chain) && random(blockRng) < 0.45)) {
    placeChains(grid, chain, crate, n, blockRng);
  }

  // Help on repeated failure changes only colors and refill luck, so the level stays recognizable.
  if (req.assist >= 3) colors = Math.max(MIN_COLORS, colors - 1);

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

  const level: LevelDef = {
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
    assistBias: req.assist >= 3 && collect.length > 0 ? { color: collect[0], chance: 0.12 } : null,
  };
  return { level, calibration: calibrate(level) };
}

/** Picks moves (or the score goal) so the bot wins with the requested probability, and sets star thresholds. */
export function finalizeLevel(draft: LevelDraft, targetWinRate: number): LevelDef {
  const level: LevelDef = structuredClone(draft.level);
  const cal = draft.calibration;
  level.targetWinRate = targetWinRate;
  const k = Math.min(SIMS - 1, Math.max(0, Math.ceil(targetWinRate * SIMS) - 1));

  const scoreGoal = level.objectives.find((o) => o.kind === ObjectiveKind.Score);
  if (scoreGoal) {
    const descending = [...cal.fixedScores].sort((a, b) => b - a);
    scoreGoal.target = roundTo(Math.max(500, descending[k]), 50);
    level.moves = cal.fixedMoves;
    level.stars = [scoreGoal.target, roundTo(scoreGoal.target * 1.3, 50), roundTo(scoreGoal.target * 1.7, 50)];
    return level;
  }

  const needed = cal.needed.map((v) => v ?? Infinity);
  const finite = needed.filter((v) => Number.isFinite(v));
  const value = Number.isFinite(needed[k]) ? needed[k] : (finite.at(-1) ?? MAX_MOVES) + 3;
  level.moves = Math.min(MAX_MOVES, Math.max(MIN_MOVES, value));
  const two = Math.max(500, roundTo(quantile(cal.scores, 0.5) * 1.25, 50));
  const three = Math.max(two + 500, roundTo(quantile(cal.scores, 0.85) * 1.6, 50));
  level.stars = [0, two, three];
  return level;
}

export function generateLevel(req: DraftRequest & { targetWinRate: number }): LevelDef {
  return finalizeLevel(draftLevel(req), req.targetWinRate);
}

function calibrate(level: LevelDef): Calibration {
  const isScore = level.objectives.some((o) => o.kind === ObjectiveKind.Score);
  const fixedMoves = 16 + Math.min(10, Math.floor(level.number / 8));
  const runs = (lv: LevelDef, moves: number) =>
    Array.from({ length: SIMS }, (_, k) => simulate(lv, hashSeed(level.number, 1000 + k), moves));

  if (isScore) {
    const results = runs(level, fixedMoves);
    return { needed: [], scores: [], fixedMoves, fixedScores: results.map((r) => r.score).sort((a, b) => a - b) };
  }

  // Goals are tuned so a typical bot run lasts about the intended level length.
  let results = runs(level, SIM_MAX_MOVES);
  const length = 15 + Math.min(10, Math.floor(level.number / 5));
  for (let pass = 0; pass < 2; pass++) {
    const sorted = results.map((r) => r.movesNeeded ?? Infinity).sort((a, b) => a - b);
    if (!adjustLength(level, sorted[Math.floor(sorted.length / 2)], length)) break;
    results = runs(level, SIM_MAX_MOVES);
  }
  const needed = results.map((r) => r.movesNeeded ?? Infinity).sort((a, b) => a - b);
  return {
    needed: needed.map((v) => (Number.isFinite(v) ? v : null)),
    scores: results.flatMap((r) => (r.movesNeeded !== null ? [r.score] : [])).sort((a, b) => a - b),
    fixedMoves: 0,
    fixedScores: [],
  };
}

/** Scales collect amounts, or strengthens crates / ice, towards the intended length. Returns whether it changed. */
function adjustLength(level: LevelDef, median: number, length: number): boolean {
  const collects = level.objectives.filter((o) => o.kind === ObjectiveKind.Collect);
  if (collects.length > 0) {
    const factor = Number.isFinite(median) ? Math.min(3, Math.max(0.5, length / median)) : 0.6;
    if (Math.abs(factor - 1) <= 0.15) return false;
    for (const o of collects) o.target = Math.max(8, Math.round(o.target * factor));
    return true;
  }
  if (median >= length * 0.75) return false;
  const kinds = level.objectives.map((o) => o.kind);
  const [layer, max] = kinds.includes(ObjectiveKind.Crate) ? [level.crate, 3] : kinds.includes(ObjectiveKind.Ice) ? [level.ice, 2] : [null, 0];
  if (!layer || !layer.some((v) => v > 0 && v < max)) return false;
  for (let i = 0; i < layer.length; i++) if (layer[i] > 0 && layer[i] < max) layer[i]++;
  return true;
}

function chooseColors(n: number, plan: LevelPlan, h: RngHolder): number {
  if (n <= 2) return MIN_COLORS;
  if (n <= 30) return 5;
  const sixChance = plan.kind === LevelKind.Hard ? 0.5 : n > 60 ? 0.25 : 0;
  return random(h) < sixChance ? 6 : 5;
}

function chooseGoals(n: number, plan: LevelPlan, h: RngHolder): ObjectiveKind[] {
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
  if (first === ObjectiveKind.Score || !plan.mechanics.has(Mechanic.DoubleGoal) || random(h) >= 0.4) {
    return [first];
  }
  const rest = pool.filter(([kind]) => kind !== first && kind !== ObjectiveKind.Score);
  return rest.length > 0 ? [first, weighted(h, rest)] : [first];
}

/** Goal colors come from the first MIN_COLORS, so removing a color for assist never removes a goal. */
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

// ---------- layout ----------

interface Grid {
  rows: number;
  cols: number;
  mask: number[];
}

type ShapeRule = (r: number, c: number, rows: number, cols: number) => boolean;

/** Board shapes; every rule is mirror-symmetric because it only looks at distances from the edges. */
const SHAPES: ShapeRule[] = [
  () => true,
  (r, c, rows, cols) => !(edge(r, rows) === 0 && edge(c, cols) === 0),
  (r, c, rows, cols) => edge(r, rows) + edge(c, cols) > 1,
  (r, c, rows, cols) => !(edge(c, cols) === 0 && Math.abs(r - (rows - 1) / 2) < 1),
  (r, c, rows, cols) => !(Math.abs(r - (rows - 1) / 2) < 1 && Math.abs(c - (cols - 1) / 2) < 1),
  (r, c, rows, cols) => !(edge(c, cols) === 1 && Math.abs(r - (rows - 1) / 2) < 1.5),
  (r, c, rows, cols) => !(edge(c, cols) === 0 && edge(r, rows) >= 2),
];

function makeShape(rows: number, cols: number, n: number, h: RngHolder): number[] {
  const options = n <= 3 ? [SHAPES[0]] : SHAPES;
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

/** Sets a cell and its mirror twin. */
function setMirrored(grid: Grid, layer: number[], r: number, c: number, value: number): void {
  for (const x of [c, grid.cols - 1 - c]) {
    const i = r * grid.cols + x;
    if (grid.mask[i] === 1) layer[i] = value;
  }
}

function placeCrates(grid: Grid, crate: number[], n: number, h: RngHolder): void {
  const strength = (): number => (n < 15 ? 1 : n < 40 ? 1 + randInt(h, 2) : 1 + randInt(h, 3));
  const half = Math.ceil(grid.cols / 2);
  if (random(h) < 0.5) {
    // A shelf: one row of crates from the walls inwards, leaving the middle open.
    const r = 3 + randInt(h, Math.max(1, grid.rows - 5));
    const width = 1 + randInt(h, Math.max(1, half - 2));
    const s = strength();
    for (let c = 0; c < width; c++) setMirrored(grid, crate, r, c, s);
  }
  const target = 6 + Math.min(12, Math.floor(n / 5));
  for (let guard = 0; guard < 100 && crate.filter(Boolean).length < target; guard++) {
    const r = 2 + randInt(h, Math.max(1, grid.rows - 3));
    setMirrored(grid, crate, r, randInt(h, half), strength());
  }
}

function placeIce(grid: Grid, ice: number[], crate: number[], n: number, h: RngHolder): void {
  const { rows, cols } = grid;
  const fraction = 0.22 + Math.min(0.25, n / 400);
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
  const thick = n >= 40 && random(h) < 0.35;
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

function placeChains(grid: Grid, chain: number[], crate: number[], n: number, h: RngHolder): void {
  const target = 4 + Math.min(8, Math.floor(n / 10));
  const half = Math.ceil(grid.cols / 2);
  for (let guard = 0; guard < 100 && chain.filter(Boolean).length < target; guard++) {
    const r = 1 + randInt(h, grid.rows - 1);
    const c = randInt(h, half);
    if (crate[r * grid.cols + c] > 0) continue;
    setMirrored(grid, chain, r, c, n >= 50 && random(h) < 0.3 ? 2 : 1);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
