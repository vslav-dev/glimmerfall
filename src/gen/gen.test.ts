import { describe, expect, it } from 'vitest';
import { EXPERT_BOT, pickMove, simulate } from '@/bot/bot';
import { FEATURE_COUNT, goalsOf, moveOptions } from '@/bot/features';
import { posOf } from '@/core/board';
import { advance, createGame, playMove, startFinale, starsFor } from '@/core/game';
import { hasAnyMatch, hasMove } from '@/core/moves';
import { LevelKind, Mechanic, ObjectiveKind } from '@/core/types';
import { type DraftRequest, draftLevel, finalizeLevel, MAX_MOVES, refillReachesAll } from '@/gen/generator';
import { planLevel } from '@/gen/plan';
import { newModel, type TwinStyle, twinOf } from '@/player/model';

const AVERAGE: TwinStyle = { ...twinOf(newModel()), strength: 0.3 };
const TAPPER: TwinStyle = { weights: new Array<number>(FEATURE_COUNT).fill(0), strength: 0, craft: 0 };
const PLANNER: TwinStyle = { weights: [...EXPERT_BOT.weights], strength: 0.8, craft: 1 };
const req = (number: number, seed = 12345, style = AVERAGE, pace = 1): DraftRequest => ({ seed, number, style, pace });

describe('generator', () => {
  it('is deterministic per request', () => {
    expect(draftLevel(req(17))).toEqual(draftLevel(req(17)));
  });

  it('shares the first levels and builds the rest per player', () => {
    expect(draftLevel(req(3, 1)).level).toEqual(draftLevel(req(3, 2)).level);
    expect(draftLevel(req(20, 1)).level).not.toEqual(draftLevel(req(20, 2)).level);
  });

  it('produces valid, playable levels across the curve', () => {
    for (const n of [1, 2, 4, 9, 14, 22, 31, 47, 66]) {
      const level = finalizeLevel(draftLevel(req(n)), planLevel(n).baseWinRate);
      expect(level.moves).toBeGreaterThanOrEqual(10);
      expect(level.moves).toBeLessThanOrEqual(MAX_MOVES);
      expect(level.objectives.length).toBeGreaterThan(0);
      for (const o of level.objectives) expect(o.target).toBeGreaterThan(0);
      if (level.objectives.some((o) => o.kind === ObjectiveKind.Score)) expect(level.objectives).toHaveLength(1);
      const [one, two, three] = level.stars;
      expect(two).toBeGreaterThan(one);
      expect(three).toBeGreaterThan(two);
      const game = createGame(level, 7);
      expect(hasAnyMatch(game.board)).toBe(false);
      expect(hasMove(game.board)).toBe(true);
    }
    // Full calibrations: seconds on a laptop, several times slower on CI runners.
  }, 120_000);

  it('gives a random tapper the same forms, opened up, and a planner deeper cuts', () => {
    const levels = [8, 9, 13, 14, 15, 19, 21, 22, 27, 33];
    const holes = (style: TwinStyle): number =>
      levels.reduce((sum, n) => sum + draftLevel(req(n, 7, style)).level.mask.filter((m) => m === 0).length, 0);
    expect(holes(TAPPER)).toBeGreaterThan(0);
    expect(holes(PLANNER)).toBeGreaterThan(holes(TAPPER));
  }, 120_000);

  it('gives the levels of a player boards of many forms and sizes', () => {
    const drafts = Array.from({ length: 12 }, (_, k) => draftLevel(req(30 + k, 99)));
    expect(new Set(drafts.map((d) => d.archetype)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(drafts.map((d) => `${d.level.cols}x${d.level.rows}`)).size).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('never walls a free cell off from the refill with crates and chains', () => {
    for (const n of [10, 16, 25, 48, 77, 139]) {
      const { level } = draftLevel(req(n, n * 31, PLANNER));
      const blocked = (i: number): boolean => level.crate[i] > 0 || level.chain[i] > 0;
      expect(refillReachesAll({ rows: level.rows, cols: level.cols, mask: level.mask, blocked }), `level ${n}`).toBe(true);
    }
  }, 120_000);

  it('lays a second layer of ice only once the first covers the whole board', () => {
    let iced = 0;
    let doubled = 0;
    for (const [n, style, pace] of [[4, AVERAGE, 1], [9, AVERAGE, 1], [21, TAPPER, 2], [41, PLANNER, 3], [77, PLANNER, 3]] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const { level } = draftLevel(req(n, seed, style, pace));
        if (!level.objectives.some((o) => o.kind === ObjectiveKind.Ice)) continue;
        const free = level.ice.filter((_, i) => level.mask[i] === 1 && level.crate[i] === 0);
        if (n === 4) expect(Math.max(...free)).toBe(1);
        if (free.some((v) => v > 1)) {
          expect(free.every((v) => v > 0), `level ${n}, seed ${seed}`).toBe(true);
          doubled++;
        }
        iced++;
        break;
      }
    }
    expect(iced).toBe(5);
    // A fast planner's long levels need more ice than one layer over the board.
    expect(doubled).toBeGreaterThan(0);
  }, 120_000);

  it('predicts each twin run at the finalized moves, wins about as targeted, and keeps 3 stars rare', () => {
    const level = finalizeLevel(draftLevel(req(26)), 0.7);
    const runs = 80;
    let wins = 0;
    let three = 0;
    let mispredicted = 0;
    for (let k = 0; k < runs; k++) {
      const seed = 9000 + k;
      // The same seeds as a calibration run: the played game follows the simulated one move for move.
      const sim = simulate(level, seed, 60, AVERAGE, { chancesUpTo: level.moves });
      const predicted = (sim.needed !== null && sim.needed <= level.moves) || sim.chances.some(([m]) => m === level.moves);
      const game = createGame(level, seed);
      const rng = { rng: seed ^ 0x5bd1e995 };
      let last = -1;
      while (game.status === 'playing') {
        const options = moveOptions(game.board, goalsOf(game), last);
        const [i, j] = options.moves[pickMove(options, AVERAGE, rng)];
        playMove(game, posOf(game.board, i), posOf(game.board, j));
        last = j;
      }
      if (predicted !== (game.status === 'won')) mispredicted++;
      if (game.status !== 'won') continue;
      startFinale(game);
      while (advance(game)) continue;
      wins++;
      if (starsFor(game) === 3) three++;
    }
    // Only the skipped last-chance checks far from the goals can disagree.
    expect(mispredicted).toBeLessThanOrEqual(runs * 0.03);
    expect(wins / runs).toBeGreaterThan(0.55);
    expect(wins / runs).toBeLessThan(0.9);
    expect(three / wins).toBeLessThan(0.35);
  }, 60_000);

  it('grows the goals and the moves for a player faster than their twin', () => {
    // A shared level: one layout, so only the goals can differ.
    const own = finalizeLevel(draftLevel(req(1, 5, AVERAGE, 1)), 0.7);
    const fast = finalizeLevel(draftLevel(req(1, 5, AVERAGE, 2)), 0.7);
    const amount = (l: typeof own): number => l.objectives.reduce((sum, o) => sum + o.target, 0);
    expect(fast.moves).toBeGreaterThan(own.moves);
    expect(amount(fast)).toBeGreaterThan(amount(own));
  }, 60_000);

  it('eases a layout its twin cannot finish until it can', () => {
    // Level 203 of a strong deliberate player (telemetry, 22.11): a crate or ice goal beside a collect one.
    // Only the collect was ever tuned, so the twin never won: 14 moves at any target, stars at 100 and 150.
    const style: TwinStyle = {
      // As learned then, with the pearl's prior added the way a stored model of that time is carried over.
      weights: [0.058, -0.169, 0.041, 0.311, -0.261, 0.862, 0.911, 0.129, 3.001, -0.342, 0.007, 0.801, -0.377, 0.6],
      strength: 0.95,
      craft: 0.97,
    };
    const draft = draftLevel(req(203, 3250437337, style, 1.03));
    const kinds = draft.level.objectives.map((o) => `${o.kind}:${o.target}`).join(' ');
    const easy = finalizeLevel(draft, 0.97);
    const hard = finalizeLevel(draft, 0.4);
    expect(easy.targetWinRate, kinds).toBeGreaterThan(0.6);
    expect(easy.moves).toBeGreaterThan(hard.moves);
    expect(hard.stars[2]).toBeGreaterThan(1000);
  }, 120_000);

  it('introduces pearls on their own level, with a goal the twin wins as targeted', () => {
    const level = finalizeLevel(draftLevel(req(20)), 0.85);
    expect(level.intro).toBe(Mechanic.Pearl);
    expect(level.objectives.map((o) => o.kind)).toEqual([ObjectiveKind.Pearl]);
    expect(level.objectives[0].target).toBeGreaterThanOrEqual(1);
    expect(level.targetWinRate).toBeGreaterThan(0.7);
    expect(level.moves).toBeLessThanOrEqual(MAX_MOVES);
  }, 60_000);

  it('gives more moves for a higher target win rate', () => {
    const draft = draftLevel(req(13));
    expect(finalizeLevel(draft, 0.9).moves).toBeGreaterThanOrEqual(finalizeLevel(draft, 0.4).moves);
  });

  it('drafts a level fast enough for a worker during the previous level', () => {
    draftLevel(req(44));
    const start = performance.now();
    draftLevel(req(45));
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('plan', () => {
  it('introduces mechanics on intro levels', () => {
    expect(planLevel(4).kind).toBe(LevelKind.Intro);
    expect(planLevel(11).kind).toBe(LevelKind.Hard);
    expect(planLevel(12).kind).toBe(LevelKind.Relief);
  });
});
