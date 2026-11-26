import { type BotStyle, EXPERT_BOT, RANDOM_BOT, type SimResult, simulate } from '@/bot/bot';
import { FINALE_CONVERSIONS } from '@/core/resolve';
import { hashSeed, pick, randInt, random, type RngHolder } from '@/core/rng';
import { type LevelDef, LevelKind, Mechanic, NO_COLOR, ObjectiveKind } from '@/core/types';
import { type LevelPlan, planLevel } from '@/gen/plan';
import { type Archetype, ARCHETYPES, archetypeOf, makeShape, orbitOf, plainShape } from '@/gen/shapes';
import type { TwinStyle } from '@/player/model';

/** Bumped whenever the same request builds a different level: a replay needs the generator that built its level. */
export const GEN_VERSION = 14;
/** Levels everyone shares: the tutorial, and the first read of the player's style. */
const COMMON_LEVELS = 5;
/** How deliberate the shared levels assume the player to be. */
const COMMON_CRAFT = 0.3;
/** Layouts tried per level; the one that suits the player's style wins. */
const CANDIDATES = 3;
/** Twin runs per candidate while its goals are tuned to the intended length. */
const SHAPE_SIMS = 12;
/** Retuning rounds at most; each stops early once the length is within 15 %. */
const SHAPE_PASSES = 4;
/** Strong and random bot runs per candidate: how much skill matters on it. */
const PROBE_SIMS = 8;
/** Twin runs of the chosen layout that set the moves and the stars: ±7 % on the win rate. */
const SIMS = 48;
/** Won runs that also measure the finale. */
const FINALE_RUNS = 8;
const SIM_MAX_MOVES = 64;
const MIN_MOVES = 14;
export const MAX_MOVES = 56;
/** Twin length a level is tuned to at most, so a slow twin still fits the move cap with room for the target win rate. */
const MAX_TWIN_LENGTH = 46;
/** A candidate whose tuned twin's slow runs (the upper quartile) still take this many times its intended length is out of the choice. */
const TOO_SLOW = 2;
const MIN_COLORS = 4;
/** Twin moves one pearl roughly takes to bring down: the first guess at a pearl goal, before the length tuner. */
const PEARL_MOVES = 11;
const MAX_PEARLS = 8;
/** Score-goal levels can never be completed early during calibration. */
const UNREACHABLE = Number.MAX_SAFE_INTEGER;
/**
 * Quantile of the twin's winning final scores for 3 stars: about once in 6–7 wins, whatever the difficulty.
 * The player model nudges it when the real rate drifts; 2 stars sit a fixed step below.
 */
export const THREE_STARS = 0.85;
const TWO_STARS_BELOW = 0.45;

export interface DraftRequest {
  /** the player's own seed: levels after the shared ones differ per player */
  seed: number;
  number: number;
  /** the twin bot the level is built and calibrated for */
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
  /** move counts up to `needed` at which a level ending there is still won, each with its final score */
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
  /** the board's archetype (plans/16); absent in drafts saved before archetypes existed */
  archetype?: string;
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
  const plain = common || plan.intro !== null;
  const count = plain ? 1 : CANDIDATES;
  // Candidates share the level's archetype: the fit picks among boards of one form, the deck keeps the forms varied.
  const archetype = plain ? null : archetypeOf(seed, n);

  let best: Layout | null = null;
  let bestFit = -Infinity;
  let variant = 0;
  for (let v = 0; v < count; v++) {
    // The twin plays slower or faster than the player: its length is the player's, scaled by their pace.
    const layout = buildLayout(n, plan, archetype, hashSeed(seed, n, v), craft, req.pace);
    const twin = shapeGoals(layout, req.style, hashSeed(seed, n, v, 1));
    if (count === 1) {
      best = layout;
      break;
    }
    // A board whose slow runs drag on far past its length is a lottery: luck decides it, the moves can only guess.
    const fit = twin.slow > layout.length * TOO_SLOW ? -Infinity : fitness(layout.level, twin.efficiencies, craft, hashSeed(seed, n, v, 2));
    if (best === null || fit > bestFit) {
      best = layout;
      bestFit = fit;
      variant = v;
    }
  }
  if (count > 1 && bestFit === -Infinity) {
    // No board of this form suits the level's goals: it gets an everyday one.
    variant = count;
    best = buildLayout(n, plan, ARCHETYPES[0], hashSeed(seed, n, variant), craft, req.pace);
    shapeGoals(best, req.style, hashSeed(seed, n, variant, 1));
  }
  const { level, archetype: form } = best!;
  return { version: GEN_VERSION, request: req, variant, archetype: form, level, calibration: calibrate(level, req.style, hashSeed(seed, n, 3)) };
}

/**
 * Picks the moves (or the score goal) so the twin wins about as often as targeted, and sets the stars.
 * The level's `targetWinRate` becomes the twin's own win rate at the chosen moves: the prediction the player is measured against.
 */
export function finalizeLevel(draft: LevelDraft, targetWinRate: number, threeStars = THREE_STARS): LevelDef {
  const level: LevelDef = structuredClone(draft.level);
  const cal = draft.calibration;
  const quantiles: [number, number] = [Math.max(0.1, threeStars - TWO_STARS_BELOW), threeStars];

  if (cal.fixedMoves > 0) {
    const { scores } = cal;
    const scoreGoal = level.objectives[0];
    scoreGoal.target = roundTo(Math.max(500, scores[scores.length - 1 - rankOf(targetWinRate, scores.length)]), 50);
    level.moves = cal.fixedMoves;
    const winners = scores.filter((s) => s >= scoreGoal.target);
    level.targetWinRate = winners.length / scores.length;
    level.stars = starsFrom(scoreGoal.target, winners, quantiles);
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
  const finals = winners(best).sort((a, b) => a - b);
  level.targetWinRate = finals.length / cal.runs.length;
  level.stars = starsFrom(0, finals, quantiles);
  return level;
}

/**
 * The run's final score with this many moves, or null when it loses. A run that wins with moves to spare
 * scores its finale on top, as the player's game does; a win on the very last move, or through the last chance,
 * holds for its exact move count only.
 */
function finalScore(run: CalibrationRun, moves: number, finale: number): number | null {
  if (run.needed !== null && run.needed < moves) return run.score + finale * Math.min(FINALE_CONVERSIONS, moves - run.needed);
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
function starsFrom(first: number, winners: number[], [twoAt, threeAt]: [number, number]): [number, number, number] {
  const two = Math.max(first + 50, 100, roundTo(quantile(winners, twoAt), 50));
  const three = Math.max(two + 50, roundTo(quantile(winners, threeAt), 50));
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
const RunKind = {
  /** play only: how many moves the goals take */
  Play: 'play',
  /** up to the first move count that wins, the last chance included: a level's real length */
  Length: 'length',
  /** everything finalizing needs: every winning move count, and the finale */
  Full: 'full',
} as const;
type RunKind = (typeof RunKind)[keyof typeof RunKind];

function runs(level: LevelDef, style: BotStyle, moves: number, count: number, seed: number, kind: RunKind = RunKind.Play): SimResult[] {
  return Array.from({ length: count }, (_, k) =>
    simulate(level, hashSeed(seed, k), moves, style, {
      // A level never has fewer moves than MIN_MOVES: wins before that need no checking.
      chancesFrom: MIN_MOVES,
      chancesUpTo: kind === RunKind.Play ? 0 : MAX_MOVES,
      untilFirstWin: kind === RunKind.Length,
      finale: kind === RunKind.Full && k < FINALE_RUNS,
    }),
  );
}

/** One number per run, higher is better: the first winning move count inverted for goal levels, score per move for score levels. */
function efficiency(level: LevelDef, r: SimResult): number {
  if (isScoreLevel(level)) return r.score / fixedMovesOf(level.number);
  const first = firstWin(r);
  return Number.isFinite(first) ? 1 / first : 0;
}

/** The fewest moves a level could have and still be won in this run, by play or through the last chance. */
function firstWin(r: SimResult): number {
  return Math.min(r.needed ?? Infinity, r.chances[0]?.[0] ?? Infinity);
}

/**
 * Tunes the goals so the twin's typical run lasts the layout's length. Returns the twin's efficiencies and
 * how long its slow runs take, the upper quartile of the first winning move counts (a score level: 0).
 */
function shapeGoals(layout: Layout, style: BotStyle, seed: number): { efficiencies: number[]; slow: number } {
  const { level } = layout;
  if (isScoreLevel(level)) {
    return { efficiencies: runs(level, style, fixedMovesOf(level.number), SHAPE_SIMS, seed).map((r) => efficiency(level, r)), slow: 0 };
  }
  // The last chance can finish a level well before play would: the length is the first move count that wins.
  let results = runs(level, style, SIM_MAX_MOVES, SHAPE_SIMS, seed, RunKind.Length);
  for (let pass = 0; pass < SHAPE_PASSES && adjustLength(layout, medianFirstWin(results)); pass++) {
    results = runs(level, style, SIM_MAX_MOVES, SHAPE_SIMS, seed, RunKind.Length);
  }
  const sorted = results.map(firstWin).sort((a, b) => a - b);
  return { efficiencies: results.map((r) => efficiency(level, r)), slow: sorted[Math.floor(sorted.length * 0.75)] };
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
  const strong = typical(EXPERT_BOT, 0);
  if (strong === 0) return -Infinity;
  const gap = Math.max(0, strong - typical(RANDOM_BOT, 1)) / strong;
  const sorted = [...twin].sort((a, b) => a - b);
  const mid = quantile(sorted, 0.5);
  // A level the twin mostly cannot finish leaves no move count that wins as targeted.
  if (mid === 0) return -Infinity;
  const spread = (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / mid;
  return craft * gap - (1 - craft) * spread;
}

/** Whether any twin run wins the drafted level: one none does gets the fewest moves at any target and stars from nothing. */
export function isWinnable(draft: LevelDraft): boolean {
  const cal = draft.calibration;
  return cal.fixedMoves > 0 || cal.runs.some((r) => r.needed !== null || r.chances.length > 0);
}

function calibrate(level: LevelDef, style: BotStyle, seed: number): Calibration {
  if (isScoreLevel(level)) {
    const fixedMoves = fixedMovesOf(level.number);
    const scores = runs(level, style, fixedMoves, SIMS, seed).map((r) => r.score);
    return { runs: [], finale: 0, scores: scores.sort((a, b) => a - b), fixedMoves };
  }
  const results = runs(level, style, SIM_MAX_MOVES, SIMS, seed, RunKind.Full);
  const measured = results.filter((r) => r.finale > 0);
  return {
    runs: results.map(({ needed, score, chances }) => ({ needed, score, chances })),
    finale: measured.length > 0 ? measured.reduce((sum, r) => sum + r.finale, 0) / measured.length : 0,
    scores: [],
    fixedMoves: 0,
  };
}

/** Median over runs of the fewest moves a level could have and still be won, by play or through the last chance. */
function medianFirstWin(results: SimResult[]): number {
  const sorted = results.map(firstWin).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Moves every goal towards the intended length: scales collect and pearl amounts and the ice's layers,
 * and strengthens or weakens crates. A twin that never wins gets every goal halved. Returns whether it changed anything.
 */
function adjustLength(layout: Layout, median: number): boolean {
  const { level, iceOrder, length } = layout;
  const factor = Number.isFinite(median) ? Math.min(3, Math.max(0.5, length / median)) : 0.5;
  let changed = false;
  for (const o of level.objectives) {
    if (o.kind === ObjectiveKind.Collect || o.kind === ObjectiveKind.Pearl) {
      const [min, max] = o.kind === ObjectiveKind.Collect ? [8, Infinity] : [1, MAX_PEARLS];
      const target = Math.min(max, Math.max(min, Math.round(o.target * factor)));
      if (Math.abs(factor - 1) <= 0.15 || target === o.target) continue;
      o.target = target;
      changed = true;
    } else if (o.kind === ObjectiveKind.Ice) {
      const layers = level.ice.reduce((sum, v) => sum + v, 0);
      const next = Math.min(layersIn(iceOrder), Math.max(1, Math.round(layers * factor)));
      if (Math.abs(factor - 1) <= 0.15 || next === layers) continue;
      o.target = layIce(level, iceOrder, next);
      changed = true;
    } else if (o.kind === ObjectiveKind.Crate) {
      // Crate layers are coarse: they change only when the length is well off. Too quick: thicker. Too slow: thinner, then fewer.
      if (median < length * 0.75) changed = thicken(level.crate, 3) || changed;
      else if (median > length * 1.5) changed = (thin(level.crate) || drop(level.crate, factor, layout.orbit)) || changed;
      o.target = level.crate.filter((v) => v > 0).length;
    }
  }
  return changed;
}

function thicken(layer: number[], max: number): boolean {
  let changed = false;
  for (let i = 0; i < layer.length; i++) {
    if (layer[i] > 0 && layer[i] < max) {
      layer[i]++;
      changed = true;
    }
  }
  return changed;
}

function thin(layer: number[]): boolean {
  let changed = false;
  for (let i = 0; i < layer.length; i++) {
    if (layer[i] > 1) {
      layer[i]--;
      changed = true;
    }
  }
  return changed;
}

/**
 * Keeps about `share` of the layer's cells, at least one: the lowest rows go first, a cell with its orbit.
 * Fewer crates never cut the refill off.
 */
function drop(layer: number[], share: number, orbit: (i: number) => number[]): boolean {
  let count = layer.filter((v) => v > 0).length;
  const before = count;
  const keep = Math.max(1, Math.round(count * share));
  for (let i = layer.length - 1; i >= 0 && count > keep; i--) {
    if (layer[i] === 0) continue;
    for (const j of orbit(i)) {
      if (layer[j] === 0) continue;
      layer[j] = 0;
      count--;
    }
  }
  return count < before;
}

// ---------- layout ----------

/** A candidate level with what its goals are tuned along. */
interface Layout {
  level: LevelDef;
  archetype: string;
  /** see `iceOrderOf`; empty without an ice goal */
  iceOrder: number[][];
  /** the cells the layout treats as one with a cell: its images under the board's symmetry */
  orbit: (i: number) => number[];
  /** the twin's intended moves */
  length: number;
}

/** Free cells of an everyday board, where a level lasts its plain length; bigger boards last longer, smaller ones less. */
const BOARD_CELLS = 62;

/** The twin's intended moves: the player's length scaled by their pace and, past the plain boards, by the board's size. */
function twinLength(n: number, pace: number, cells: number | null): number {
  const size = cells === null ? 1 : Math.min(1.25, Math.max(0.8, Math.sqrt(cells / BOARD_CELLS)));
  return Math.min(MAX_TWIN_LENGTH, Math.round(playerLength(n) * pace * size));
}

/**
 * One candidate layout with goals. The archetype (null: the plain board) gives the board its form;
 * `craft` (0 random taps … 1 planning) sets how intricate it gets: how deep the cuts go, crate shelves,
 * chains, thick crates, a sixth color, double goals. The intended length sizes the crate and ice goals:
 * their amount is the layout itself.
 */
function buildLayout(n: number, plan: LevelPlan, archetype: Archetype | null, seed: number, craft: number, pace: number): Layout {
  const shapeRng: RngHolder = { rng: hashSeed(seed, 11) };
  const blockRng: RngHolder = { rng: hashSeed(seed, 22) };
  const goalRng: RngHolder = { rng: hashSeed(seed, 33) };

  const goals = chooseGoals(n, plan, craft, goalRng);
  const shape = archetype ? makeShape(archetype, craft, goals.includes(ObjectiveKind.Pearl), shapeRng) : plainShape(n, shapeRng);
  const { rows, cols, mask } = shape;
  const size = rows * cols;
  const cells = mask.filter(Boolean).length;
  const length = twinLength(n, pace, archetype ? cells : null);
  const colors = chooseColors(n, plan, craft, cells, goalRng);
  const collectCount = !goals.includes(ObjectiveKind.Collect) ? 0 : n >= 15 && random(goalRng) < 0.2 + 0.4 * craft ? 2 : 1;
  const collect = pickColors(goalRng, collectCount);

  const crate = new Array<number>(size).fill(0);
  const ice = new Array<number>(size).fill(0);
  const chain = new Array<number>(size).fill(0);
  const orbit = (i: number): number[] => orbitOf(i, rows, cols, shape.symmetry);
  const plot: Plot = { rows, cols, mask, blocked: (i) => crate[i] > 0 || chain[i] > 0, orbit };
  const focus = focusOf(plot, plan.kind, blockRng);
  if (goals.includes(ObjectiveKind.Crate) || (plan.mechanics.has(Mechanic.Crate) && n >= 25 && random(blockRng) < 0.6 * craft)) {
    placeCrates(plot, crate, n, craft, length, focus, blockRng);
  }
  const iceOrder = goals.includes(ObjectiveKind.Ice) ? iceOrderOf(plot, crate, plan.intro === Mechanic.Ice, focus, blockRng) : [];
  if (plan.intro === Mechanic.Chain || (plan.mechanics.has(Mechanic.Chain) && random(blockRng) < 0.25 + 0.4 * craft)) {
    placeChains(plot, chain, crate, n, craft, blockRng);
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
    objectives: [],
    stars: [0, 0, 0],
    kind: plan.kind,
    intro: plan.intro,
    targetWinRate: plan.baseWinRate,
  };
  for (const g of goals) {
    if (g === ObjectiveKind.Collect) {
      const each = Math.round(Math.min(40, 12 + n * 0.3) * (collect.length > 1 ? 0.7 : 1) * (colors >= 6 ? 0.85 : 1));
      for (const color of collect) level.objectives.push({ kind: g, target: each, color });
    } else if (g === ObjectiveKind.Ice) {
      level.objectives.push({ kind: g, target: layIce(level, iceOrder, iceLayers(iceOrder, n, length)), color: NO_COLOR });
    } else if (g === ObjectiveKind.Crate) {
      level.objectives.push({ kind: g, target: crate.filter((v) => v > 0).length, color: NO_COLOR });
    } else if (g === ObjectiveKind.Pearl) {
      level.objectives.push({ kind: g, target: Math.min(MAX_PEARLS, Math.max(1, Math.round(length / PEARL_MOVES))), color: NO_COLOR });
    } else {
      level.objectives.push({ kind: g, target: UNREACHABLE, color: NO_COLOR });
    }
  }
  return { level, archetype: shape.archetype, iceOrder, orbit, length };
}

/**
 * Random tappers get four colors more often (more cascades, more show); deliberate players meet a sixth.
 * A small board holds fewer: six colors on forty cells leave hardly a move.
 */
function chooseColors(n: number, plan: LevelPlan, craft: number, cells: number, h: RngHolder): number {
  if (n <= 2) return MIN_COLORS;
  const four = Math.max(0, 0.5 - 2 * craft);
  const six = n > 30 ? (plan.kind === LevelKind.Hard ? 0.5 : n > 60 ? 0.25 : 0) * 2 * craft : 0;
  const roll = random(h);
  const most = cells <= 42 ? 4 : cells <= 56 ? 5 : 6;
  return Math.min(most, roll < four ? 4 : roll >= 1 - six ? 6 : 5);
}

function chooseGoals(n: number, plan: LevelPlan, craft: number, h: RngHolder): ObjectiveKind[] {
  switch (plan.intro) {
    case Mechanic.Ice:
      return [ObjectiveKind.Ice];
    case Mechanic.Crate:
      return [ObjectiveKind.Crate];
    case Mechanic.Chain:
      return [ObjectiveKind.Collect];
    case Mechanic.Pearl:
      return [ObjectiveKind.Pearl];
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
  if (plan.mechanics.has(Mechanic.Pearl)) pool.push([ObjectiveKind.Pearl, 2]);

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

/** A grid being laid out: blockers go on whole orbits, so a symmetric board keeps its symmetry. */
interface Plot extends Grid {
  orbit: (i: number) => number[];
}

/** Sets a blocker on a cell and its orbit, where they are free, unless that would cut some free cell off from the refill. */
function setBlocker(plot: Plot, layer: number[], i: number, value: number): void {
  const cells = plot.orbit(i).filter((j) => plot.mask[j] === 1 && !plot.blocked(j));
  const before = cells.map((j) => layer[j]);
  for (const j of cells) layer[j] = value;
  if (!refillReachesAll(plot)) cells.forEach((j, k) => (layer[j] = before[k]));
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

/** How many cells of the board are above each cell in its column: the refill comes in at depth 0. */
function depthsOf(grid: Grid): number[] {
  const { cols, mask } = grid;
  const depth = new Array<number>(mask.length).fill(0);
  for (let i = cols; i < mask.length; i++) depth[i] = depth[i - cols] + mask[i - cols];
  return depth;
}

/** Where the goals' blockers gather, by the level's place in the curve (plans/16). */
const Focus = {
  /** around the board's middle: in plain sight, many lines through every cell */
  Center: 'center',
  /** the cells hardest to reach: few lines of three through them, far from the middle */
  Pocket: 'pocket',
  /** a cluster around a random cell */
  Anchor: 'anchor',
  /** anywhere */
  Scatter: 'scatter',
} as const;
type Focus = (typeof Focus)[keyof typeof Focus];

/**
 * A rank per cell, lower first: the order the goals' crates and the ice's first pass take the board in.
 * An easy level keeps them in the middle, a hard one tucks them away in its corners and pockets.
 */
function focusOf(grid: Grid, kind: LevelKind, h: RngHolder): number[] {
  const { rows, cols, mask } = grid;
  const mode: Focus =
    kind === LevelKind.Hard
      ? Focus.Pocket
      : kind === LevelKind.Relief || kind === LevelKind.Intro
        ? Focus.Center
        : pick(h, [Focus.Anchor, Focus.Anchor, Focus.Scatter, Focus.Center, Focus.Pocket]);
  const cells = mask.flatMap((m, i) => (m === 1 ? [i] : []));
  const rowOf = (i: number): number => Math.floor(i / cols);
  const colOf = (i: number): number => i % cols;
  const cy = cells.reduce((s, i) => s + rowOf(i), 0) / cells.length;
  const cx = cells.reduce((s, i) => s + colOf(i), 0) / cells.length;
  const dist = (i: number): number => Math.hypot(rowOf(i) - cy, colOf(i) - cx);
  const far = Math.max(1, ...cells.map(dist));
  const anchor = pick(h, cells);
  const rank = new Array<number>(mask.length).fill(Infinity);
  for (const i of cells) {
    const noise = random(h);
    switch (mode) {
      case Focus.Center:
        rank[i] = dist(i) / far + 0.25 * noise;
        break;
      case Focus.Pocket:
        rank[i] = (0.6 * linesThrough(grid, i)) / 6 + 0.4 * (1 - dist(i) / far) + 0.2 * noise;
        break;
      case Focus.Anchor:
        rank[i] = (Math.abs(rowOf(i) - rowOf(anchor)) + Math.abs(colOf(i) - colOf(anchor))) / (rows + cols) + 0.15 * noise;
        break;
      case Focus.Scatter:
        rank[i] = noise;
    }
  }
  return rank;
}

/** Lines of three across the board's cells that take in cell `i`: 0 … 6. */
function linesThrough(grid: Grid, i: number): number {
  const { rows, cols, mask } = grid;
  const r = Math.floor(i / cols);
  const c = i % cols;
  const at = (y: number, x: number): boolean => y >= 0 && y < rows && x >= 0 && x < cols && mask[y * cols + x] === 1;
  let lines = 0;
  for (let k = -2; k <= 0; k++) {
    if ([0, 1, 2].every((d) => at(r, c + k + d))) lines++;
    if ([0, 1, 2].every((d) => at(r + k + d, c))) lines++;
  }
  return lines;
}

/** Twin length the base amounts of crates and ice were set for; longer levels get proportionally more. */
const LAYER_LENGTH = 18;

function placeCrates(plot: Plot, crate: number[], n: number, craft: number, length: number, focus: number[], h: RngHolder): void {
  const { rows, cols, mask } = plot;
  const cap = 1 + Math.round(2 * craft);
  const strength = (): number => Math.min(cap, n < 15 ? 1 : n < 40 ? 1 + randInt(h, 2) : 1 + randInt(h, 3));
  if (random(h) < craft) {
    // A shelf: one row of crates from a wall inwards, leaving the middle open; what is under it is hard to reach.
    const r = 3 + randInt(h, Math.max(1, rows - 5));
    const width = 1 + randInt(h, Math.max(1, Math.ceil(cols / 2) - 2));
    const right = random(h) < 0.5;
    const s = strength();
    for (let c = 0; c < width; c++) setBlocker(plot, crate, r * cols + (right ? cols - 1 - c : c), s);
  }
  // Capped well below the board: the refill check refuses crates that would wall cells off anyway.
  const target = Math.min(Math.round(rows * cols * 0.4), Math.round((6 + Math.min(12, Math.floor(n / 5))) * (length / LAYER_LENGTH)));
  // The top two cells of a column stay free: the refill comes in there.
  const depth = depthsOf(plot);
  const order = mask.flatMap((m, i) => (m === 1 && depth[i] >= 2 ? [i] : [])).sort((a, b) => focus[a] - focus[b]);
  for (const i of order) {
    if (crate.filter(Boolean).length >= target) break;
    setBlocker(plot, crate, i, strength());
  }
}

/** Share of the free cells under ice on an early level at the base length: the start the length tuner works from. */
const ICE_SHARE = 0.4;

/** A rank per cell for one way ice spreads over a board: lower ranks freeze first, and every spread ends with the whole board. */
type IceSpread = (r: number, c: number, rows: number, cols: number) => number;

const ICE_SPREADS: IceSpread[] = [
  // A rectangle growing from the middle; each ring of it from the middles of its sides to its corners.
  (r, c, rows, cols) => Math.max(fromMiddle(r, rows) / rows, fromMiddle(c, cols) / cols) + (fromMiddle(r, rows) + fromMiddle(c, cols)) / 1000,
  // Row by row from the bottom up, each row from its middle out.
  (r, c, rows, cols) => rows - 1 - r + fromMiddle(c, cols) / cols,
  // Ring by ring from the walls inwards, each ring from its corners.
  (r, c, rows, cols) => Math.min(edge(r, rows), edge(c, cols)) - (fromMiddle(r, rows) / rows + fromMiddle(c, cols) / cols) / 4,
  // A checkerboard from the middle rows out, then the cells between.
  (r, c, rows) => ((r + c) % 2) * rows + fromMiddle(r, rows),
  // Column by column from the walls inwards, each column from its middle out.
  (r, c, rows, cols) => edge(c, cols) * rows + fromMiddle(r, rows),
];

/** Share of ice levels whose first layer grows from the level's focus rather than by a pattern. */
const ICE_FOCUSED = 0.6;

/**
 * The order ice is laid in, one orbit of cells per entry: every free cell once, from the level's focus or by a
 * pattern, then every one again by a pattern. However much ice a level gets, a cell has a second layer only once
 * the first covers the whole board. The intro teaches a single layer, so its order stops after the first pass.
 */
function iceOrderOf(plot: Plot, crate: number[], intro: boolean, focus: number[], h: RngHolder): number[][] {
  const { rows, cols, mask } = plot;
  const free = (i: number): boolean => mask[i] === 1 && crate[i] === 0;
  const orbits = new Map<number, number[]>();
  for (let i = 0; i < mask.length; i++) {
    if (!free(i)) continue;
    const members = plot.orbit(i).filter(free);
    orbits.set(Math.min(...members), members);
  }
  const spread = (rank: (i: number) => number): number[][] => {
    const key = (members: number[]): number => Math.min(...members.map(rank));
    return [...orbits.entries()].sort(([a, x], [b, y]) => key(x) - key(y) || a - b).map(([, members]) => members);
  };
  const pattern = (): number[][] => {
    const rank = pick(h, ICE_SPREADS);
    return spread((i) => rank(Math.floor(i / cols), i % cols, rows, cols));
  };
  const first = random(h) < ICE_FOCUSED ? spread((i) => focus[i]) : pattern();
  return intro ? first : [...first, ...pattern()];
}

/** Layers a layout's ice starts with: a share of the free cells that grows with the intended length and, slowly, with the level. */
function iceLayers(order: number[][], n: number, length: number): number {
  const share = ICE_SHARE * (length / LAYER_LENGTH) * (1 + Math.min(0.5, n / 400));
  return Math.min(layersIn(order), Math.max(1, Math.round(new Set(order.flat()).size * share)));
}

function layersIn(order: number[][]): number {
  return order.reduce((sum, members) => sum + members.length, 0);
}

/** Lays the order's orbits until `layers` layers lie, a whole orbit at a time, and returns how many cells are iced: the goal. */
function layIce(level: LevelDef, order: number[][], layers: number): number {
  const { ice } = level;
  ice.fill(0);
  let laid = 0;
  for (const members of order) {
    if (laid >= layers) break;
    for (const i of members) ice[i]++;
    laid += members.length;
  }
  return ice.filter((v) => v > 0).length;
}

function fromMiddle(x: number, size: number): number {
  return Math.abs(x - (size - 1) / 2);
}

function edge(x: number, size: number): number {
  return Math.min(x, size - 1 - x);
}

function placeChains(plot: Plot, chain: number[], crate: number[], n: number, craft: number, h: RngHolder): void {
  const target = 4 + Math.min(8, Math.floor(n / 10));
  // Never the top cell of a column, where the refill comes in.
  const depth = depthsOf(plot);
  const cells = plot.mask.flatMap((m, i) => (m === 1 && depth[i] >= 1 ? [i] : []));
  for (let guard = 0; guard < 100 && chain.filter(Boolean).length < target; guard++) {
    const i = pick(h, cells);
    if (crate[i] > 0) continue;
    setBlocker(plot, chain, i, n >= 50 && random(h) < 0.6 * craft ? 2 : 1);
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
