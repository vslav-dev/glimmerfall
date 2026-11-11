/**
 * Adaptive difficulty. Keeps one number: how much stronger (positive) or weaker (negative) than the
 * calibration bot the player is, in logit units. Each attempt nudges it by the surprise of the outcome.
 */
export interface DirectorState {
  skill: number;
  /** recent attempts, newest last, for the debug panel */
  history: { level: number; won: boolean; predicted: number }[];
}

export interface AttemptReport {
  level: number;
  won: boolean;
  /** win rate the level was calibrated for */
  predicted: number;
  /** share of moves left at the win, 0..1 */
  movesLeftRatio: number;
  usedExtraMoves: boolean;
}

const LEARNING_RATE = 0.35;
const SKILL_LIMIT = 1.5;
/** Each failure on the same level raises the target win rate by this much (logit). */
const FAIL_ASSIST = 0.45;
const MIN_WIN_RATE = 0.35;
const MAX_WIN_RATE = 0.97;
const HISTORY = 30;

export function newDirector(): DirectorState {
  return { skill: 0, history: [] };
}

/**
 * Win rate to calibrate the next attempt for. A stronger player gets a lower bot win rate,
 * which means fewer moves: the level feels the same for them as the curve intends.
 */
export function targetWinRate(d: DirectorState, baseWinRate: number, failsOnLevel: number): number {
  const p = sigmoid(logit(baseWinRate) - d.skill + FAIL_ASSIST * failsOnLevel);
  return Math.min(MAX_WIN_RATE, Math.max(MIN_WIN_RATE, p));
}

export function recordAttempt(d: DirectorState, a: AttemptReport): void {
  // An easy win counts as more than a win; a win bought with extra moves counts as half.
  const outcome = a.won ? (a.usedExtraMoves ? 0.5 : Math.min(1.25, 1 + a.movesLeftRatio * 0.5)) : 0;
  d.skill = clamp(d.skill + LEARNING_RATE * (outcome - a.predicted), -SKILL_LIMIT, SKILL_LIMIT);
  d.history.push({ level: a.level, won: a.won, predicted: a.predicted });
  if (d.history.length > HISTORY) d.history.shift();
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
