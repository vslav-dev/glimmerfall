/**
 * Offline step 2 of the move analysis (see tools/analyze.sh): reads the dumps of replay-dump.test.ts and checks
 * the player model on the current code:
 *  - fits population weights and feature scales (to refresh PRIOR and SCALE in player/model.ts);
 *  - prequential log-likelihood of the online learner: each move predicted before it is learned from;
 *  - twin calibration: the win rate the twin bot, as learned up to each attempt, gets on that attempt's level,
 *    against what the player actually did.
 * Runs only with GF_DUMPS (directory of dump*.json) set. GF_ZERO=1 starts the taste from zero instead of the prior:
 * a fair check of learning speed, since the prior was fitted on the same moves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { simulate } from '@/bot/bot';
import { FEATURE_COUNT, FEATURE_NAMES, goalsOf, type MoveOptions, moveOptions } from '@/bot/features';
import type { Board, GameState, LevelDef } from '@/core/types';
import { likelihood, newModel, observeMove, observeOutcome, twinOf } from '@/player/model';

interface DumpMove {
  board: Board;
  progress: number[];
  from: number;
  to: number;
  last: number;
  hint: number;
}
interface DumpAttempt {
  event: { n: number; end: string };
  level: LevelDef;
  reproduced: boolean;
  moves: DumpMove[];
}
interface Decision {
  options: MoveOptions;
  chosen: number;
}
interface Attempt {
  level: LevelDef;
  won: boolean | null;
  decisions: Decision[];
}

const TWIN_RUNS = 32;
/** Attempts before strength has settled, left out of the calibration score. */
const WARMUP = 30;

function load(dir: string): Attempt[] {
  const files = fs.readdirSync(dir).filter((f) => /^dump\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
  return files.flatMap((f) => (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DumpAttempt[]).filter((a) => a.reproduced)).map((a) => ({
    level: a.level,
    won: a.event.end === 'restart' ? null : a.event.end === 'won',
    decisions: a.moves.flatMap((m) => {
      if (m.hint) return [];
      const state = { level: a.level, progress: m.progress } as GameState;
      const options = moveOptions(m.board, goalsOf(state), m.last);
      const chosen = options.moves.findIndex(([i, j]) => (i === m.from && j === m.to) || (i === m.to && j === m.from));
      return chosen >= 0 && options.moves.length >= 2 ? [{ options, chosen }] : [];
    }),
  }));
}

/** Batch conditional-logit fit in standardized units (Adam), returned in raw units with the scales. */
function fit(decisions: Decision[]): { weights: number[]; scale: number[]; ll: number } {
  const mean = new Array<number>(FEATURE_COUNT).fill(0);
  const sq = new Array<number>(FEATURE_COUNT).fill(0);
  let rows = 0;
  for (const d of decisions) {
    for (let m = 0; m < d.options.moves.length; m++, rows++) {
      for (let k = 0; k < FEATURE_COUNT; k++) mean[k] += d.options.features[m * FEATURE_COUNT + k];
    }
  }
  mean.forEach((_, k) => (mean[k] /= rows));
  for (const d of decisions) {
    for (let m = 0; m < d.options.moves.length; m++) {
      for (let k = 0; k < FEATURE_COUNT; k++) sq[k] += (d.options.features[m * FEATURE_COUNT + k] - mean[k]) ** 2;
    }
  }
  const scale = sq.map((s) => Math.sqrt(s / rows) || 1);
  const u = new Array<number>(FEATURE_COUNT).fill(0);
  const m1 = [...u];
  const m2 = [...u];
  let ll = 0;
  for (let it = 1; it <= 800; it++) {
    const grad = new Array<number>(FEATURE_COUNT).fill(0);
    ll = 0;
    for (const d of decisions) {
      const n = d.options.moves.length;
      const s = Array.from({ length: n }, (_, m) => u.reduce((a, w, k) => a + (w * d.options.features[m * FEATURE_COUNT + k]) / scale[k], 0));
      const top = Math.max(...s);
      const e = s.map((x) => Math.exp(x - top));
      const z = e.reduce((a, b) => a + b, 0);
      ll += s[d.chosen] - top - Math.log(z);
      for (let k = 0; k < FEATURE_COUNT; k++) {
        let expected = 0;
        for (let m = 0; m < n; m++) expected += (e[m] / z) * d.options.features[m * FEATURE_COUNT + k];
        grad[k] += (d.options.features[d.chosen * FEATURE_COUNT + k] - expected) / scale[k];
      }
    }
    for (let k = 0; k < FEATURE_COUNT; k++) {
      const g = grad[k] / decisions.length - 0.001 * u[k];
      m1[k] = 0.9 * m1[k] + 0.1 * g;
      m2[k] = 0.999 * m2[k] + 0.001 * g * g;
      u[k] += (0.05 * (m1[k] / (1 - 0.9 ** it))) / (Math.sqrt(m2[k] / (1 - 0.999 ** it)) + 1e-8);
    }
  }
  return { weights: u.map((w, k) => w / scale[k]), scale, ll: ll / decisions.length };
}

const round = (v: number, digits = 3): number => Math.round(v * 10 ** digits) / 10 ** digits;

describe.skipIf(!process.env.GF_DUMPS)('model check', () => {
  it('fits, learns and calibrates', () => {
    const attempts = load(process.env.GF_DUMPS!);
    const decisions = attempts.flatMap((a) => a.decisions);
    const uniform = decisions.reduce((s, d) => s - Math.log(d.options.moves.length), 0) / decisions.length;
    console.log(`📊 attempts ${attempts.length}, decisions ${decisions.length}, uniform log-lik ${uniform.toFixed(3)}`);

    const f = fit(decisions);
    console.log(`📐 batch fit log-lik ${f.ll.toFixed(3)} (pseudo-R² ${(1 - f.ll / uniform).toFixed(3)})`);
    console.log(`📐 PRIOR = [${f.weights.map((w) => round(w)).join(', ')}]`);
    console.log(`📐 SCALE = [${f.scale.map((s) => round(s)).join(', ')}]`);
    console.log(`📐 ${FEATURE_NAMES.map((name, k) => `${name} ${round(f.weights[k] * f.scale[k], 2)}`).join(' | ')}`);

    // Prequential: every move is predicted by the taste as learned so far, then learned from.
    for (const rate of [0, 0.001, 0.003, 0.01, 0.03]) {
      const model = newModel();
      if (process.env.GF_ZERO) model.weights.fill(0);
      let ll = 0;
      for (const d of decisions) {
        ll += Math.log(likelihood(model, d.options, d.chosen));
        observeMove(model, d.options, d.chosen, rate);
      }
      console.log(`🔁 taste rate ${rate}: prequential log-lik ${(ll / decisions.length).toFixed(3)}`);
    }

    // Twin calibration: the twin as learned before each attempt plays that attempt's level; strength learns
    // from each outcome as the app does. A taste-only twin (strength 0) shows what strength adds.
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    for (const learnStrength of [false, true]) {
      const model = newModel();
      const rows: { predicted: number; won: boolean }[] = [];
      let simMs = 0;
      for (const [k, a] of attempts.entries()) {
        if (a.won !== null) {
          const twin = twinOf(model);
          const start = performance.now();
          const predicted = Array.from({ length: TWIN_RUNS }, (_, s) => simulate(a.level, 7919 * k + s, a.level.moves, twin).needed !== null).filter(Boolean).length / TWIN_RUNS;
          simMs += performance.now() - start;
          rows.push({ predicted, won: a.won });
          if (learnStrength) observeOutcome(model, a.won, predicted);
        }
        for (const d of a.decisions) observeMove(model, d.options, d.chosen);
      }
      const late = rows.slice(WARMUP);
      const actual = mean(late.map((r) => (r.won ? 1 : 0)));
      console.log(`🎯 ${learnStrength ? 'with strength' : 'taste only  '}: after ${WARMUP} attempts twin ${mean(late.map((r) => r.predicted)).toFixed(2)} vs player ${actual.toFixed(2)}, Brier ${mean(late.map((r) => (r.predicted - (r.won ? 1 : 0)) ** 2)).toFixed(3)} (constant ${(actual * (1 - actual)).toFixed(3)}), ${(simMs / rows.length / TWIN_RUNS).toFixed(1)} ms per run`);
      const twin = twinOf(model);
      console.log(`🧠   strength ${twin.strength} craft ${twin.craft} | ${FEATURE_NAMES.map((name, j) => `${name} ${round(twin.weights[j], 2)}`).join(' ')}`);
    }
  }, 1_800_000);
});
