/**
 * Target win rate of an attempt. The level curve gives the base; the chosen difficulty, the player's
 * residual skill and failures on the level shift it in logit units, so the curve keeps its shape
 * and never sticks to 0 or 100 %.
 */
export const Difficulty = {
  Easy: 'easy',
  Normal: 'normal',
  Hard: 'hard',
} as const;
export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

/** Easiest first: the settings stepper walks this list. */
export const DIFFICULTIES: readonly Difficulty[] = [Difficulty.Easy, Difficulty.Normal, Difficulty.Hard];

const SHIFT: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0.85,
  [Difficulty.Normal]: 0,
  [Difficulty.Hard]: -0.85,
};
/** Each failure on the same level raises the target by this much. */
const FAIL_ASSIST = 0.45;
const MIN_WIN_RATE = 0.25;
const MAX_WIN_RATE = 0.97;
const LEARNING_RATE = 0.25;
/** The twin bot already plays like the player: skill only corrects what it gets wrong. */
const SKILL_LIMIT = 1;

export interface AttemptOutcome {
  won: boolean;
  /** win rate the attempt was calibrated for */
  predicted: number;
  /** share of moves left at the win, 0..1 */
  movesLeftRatio: number;
  usedExtraMoves: boolean;
}

/** A stronger player (positive skill) gets a lower rate for the twin bot, which means fewer moves. */
export function targetWinRate(base: number, difficulty: Difficulty, skill: number, fails: number): number {
  const p = sigmoid(logit(base) + SHIFT[difficulty] - skill + FAIL_ASSIST * fails);
  return Math.min(MAX_WIN_RATE, Math.max(MIN_WIN_RATE, p));
}

/**
 * Skill moves by the surprise of the outcome against the prediction, which already holds the difficulty:
 * an easy setting does not read as mastery. An easy win counts as more than a win, one bought with extra moves as half.
 */
export function updateSkill(skill: number, a: AttemptOutcome): number {
  const outcome = a.won ? (a.usedExtraMoves ? 0.5 : Math.min(1.25, 1 + a.movesLeftRatio * 0.5)) : 0;
  return Math.min(SKILL_LIMIT, Math.max(-SKILL_LIMIT, skill + LEARNING_RATE * (outcome - a.predicted)));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
