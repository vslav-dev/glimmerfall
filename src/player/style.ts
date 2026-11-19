import type { BotStyle } from '@/bot/bot';
import type { MoveOptions } from '@/bot/evaluate';

/**
 * Reads how the player plays from the moves they pick among all valid ones. Every grid style (a bot
 * precision and a bonus weight) scores how likely it would have made the same choice; the scores decay,
 * so the estimate follows a player whose style changes. The estimate is the bot the levels are calibrated on.
 */
const PRECISION = [0, 0.08, 0.16, 0.32, 0.64, 1.28];
const BONUS = [0, 0.5, 1, 2];
/** Each move keeps this much of the evidence so far: about the last 200 moves count. */
const DECAY = 0.995;
/** A new player is assumed mildly greedy; the prior fades after a level or two of moves. */
const PRIOR_PRECISION = 3;
const PRIOR_BONUS = 1;
const PRIOR_WIDTH = 1.5;

export interface StyleState {
  /** decayed log-likelihood of the player's choices per grid style, precision-major */
  ll: number[];
  /** moves observed */
  moves: number;
}

/** The player's style as a bot, plus `craft`: how deliberate the play is, from 0 (random taps) to 1 (planning). */
export interface TwinStyle extends BotStyle {
  craft: number;
}

export function newStyle(): StyleState {
  return { ll: new Array<number>(PRECISION.length * BONUS.length).fill(0), moves: 0 };
}

/** Learns from one move made on a calm board; `chosen` indexes `o.moves`. */
export function observeMove(s: StyleState, o: MoveOptions, chosen: number): void {
  const n = o.moves.length;
  // A forced move says nothing about style.
  if (n < 2) return;
  for (let b = 0; b < BONUS.length; b++) {
    let max = -Infinity;
    for (let m = 0; m < n; m++) max = Math.max(max, o.plain[m] + BONUS[b] * o.bonus[m]);
    const picked = o.plain[chosen] + BONUS[b] * o.bonus[chosen] - max;
    for (let a = 0; a < PRECISION.length; a++) {
      const beta = PRECISION[a];
      let sum = 0;
      for (let m = 0; m < n; m++) sum += Math.exp(beta * (o.plain[m] + BONUS[b] * o.bonus[m] - max));
      const k = a * BONUS.length + b;
      s.ll[k] = s.ll[k] * DECAY + beta * picked - Math.log(sum);
    }
  }
  s.moves++;
}

/** The posterior mean style, rounded: the rounded numbers are what levels get built from and what telemetry reports. */
export function twinOf(s: StyleState): TwinStyle {
  const log = s.ll.map((ll, k) => {
    const da = Math.floor(k / BONUS.length) - PRIOR_PRECISION;
    const db = (k % BONUS.length) - PRIOR_BONUS;
    return ll - (da * da + db * db) / (2 * PRIOR_WIDTH * PRIOR_WIDTH);
  });
  const top = Math.max(...log);
  const w = log.map((v) => Math.exp(v - top));
  const total = w.reduce((sum, v) => sum + v, 0);
  let precision = 0;
  let bonus = 0;
  let a = 0;
  let b = 0;
  w.forEach((v, k) => {
    const p = v / total;
    const ia = Math.floor(k / BONUS.length);
    const ib = k % BONUS.length;
    precision += p * PRECISION[ia];
    bonus += p * BONUS[ib];
    a += p * ia;
    b += p * ib;
  });
  // Bonus taste only shows in a player who aims: a random tapper has no craft whatever the bonus estimate says.
  const craft = (a / (PRECISION.length - 1)) * (0.6 + (0.4 * b) / (BONUS.length - 1));
  return { precision: round2(precision), bonus: round2(bonus), craft: round2(craft) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
