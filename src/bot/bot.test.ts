import { describe, expect, it } from 'vitest';
import { EXPERT_BOT, pickMove, RANDOM_BOT, simulate } from '@/bot/bot';
import { Feature, FEATURE_COUNT, goalsOf, moveOptions, score } from '@/bot/features';
import { posOf, swapPieces } from '@/core/board';
import { createGame, playMove } from '@/core/game';
import { findGroups, newGroupScan, scanGroup } from '@/core/matches';
import { findMoves, isComboPair } from '@/core/moves';
import { type LevelDef, LevelKind, ObjectiveKind } from '@/core/types';

function level(overrides: Partial<LevelDef> = {}): LevelDef {
  const size = 64;
  return {
    number: 1,
    rows: 8,
    cols: 8,
    mask: new Array<number>(size).fill(1),
    ice: new Array<number>(size).fill(0),
    crate: new Array<number>(size).fill(0),
    chain: new Array<number>(size).fill(0),
    colors: 5,
    moves: 60,
    objectives: [{ kind: ObjectiveKind.Collect, target: 30, color: 0 }],
    stars: [0, 1000, 2000],
    kind: LevelKind.Normal,
    intro: null,
    targetWinRate: 0.7,
    ...overrides,
  };
}

describe('scanGroup', () => {
  it('finds exactly the group findGroups finds for every move, over many boards', () => {
    const scan = newGroupScan();
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const lv = level({ colors: 4 + (seed % 3) });
      lv.chain[27] = 1;
      lv.crate[36] = 1;
      const game = createGame(lv, seed);
      // A few moves in, the board carries specials and chains too.
      for (let step = 0; step < 8; step++) {
        const b = game.board;
        for (const [i, j] of findMoves(b)) {
          if (isComboPair(b.cells[i].piece!, b.cells[j].piece!)) continue;
          swapPieces(b, i, j);
          const groups = findGroups(b, [j, i]);
          for (const x of [i, j]) {
            const group = groups.find((g) => g.cells.includes(x));
            expect(scanGroup(b, x, scan)).toBe(group !== undefined);
            if (!group) continue;
            expect([...scan.cells.subarray(0, scan.count)].sort((a, c) => a - c)).toEqual([...group.cells].sort((a, c) => a - c));
            expect(scan.special).toBe(group.special);
            checked++;
          }
          swapPieces(b, i, j);
        }
        const moves = findMoves(b);
        const [i, j] = moves[(seed * 5 + step) % moves.length];
        playMove(game, posOf(b, i), posOf(b, j));
        if (game.status !== 'playing') break;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('moveOptions', () => {
  const at = (o: ReturnType<typeof moveOptions>, m: number, f: Feature): number => o.features[m * FEATURE_COUNT + f];

  it('describes every valid move and leaves the board as it was', () => {
    const game = createGame(level(), 3);
    const before = JSON.stringify(game.board);
    const options = moveOptions(game.board, goalsOf(game), -1);
    expect(options.moves).toEqual(findMoves(game.board));
    options.moves.forEach((_, m) => {
      expect(at(options, m, Feature.Cells) >= 3 || at(options, m, Feature.Combo) === 1).toBe(true);
      expect(at(options, m, Feature.Far)).toBe(4);
      expect(at(options, m, Feature.Low)).toBeGreaterThanOrEqual(0);
      expect(at(options, m, Feature.Low)).toBeLessThanOrEqual(1);
    });
    expect(JSON.stringify(game.board)).toBe(before);
  });

  it('counts the wanted color only while it is a goal, and the distance from the last move', () => {
    const game = createGame(level(), 5);
    const options = moveOptions(game.board, goalsOf(game), 0);
    const none = moveOptions(game.board, { wanted: 0, ice: false, crate: false }, 0);
    expect(options.moves.some((_, m) => at(options, m, Feature.Wanted) > 0)).toBe(true);
    expect(none.moves.every((_, m) => at(none, m, Feature.Wanted) === 0)).toBe(true);
    options.moves.forEach(([i, j], m) => {
      const d = Math.min(...[i, j].map((x) => Math.floor(x / 8) + (x % 8)));
      expect(at(options, m, Feature.Far)).toBe(Math.min(8, d));
    });
  });
});

describe('bots', () => {
  it('the expert needs fewer moves than a random tapper', () => {
    const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const needed = (style: typeof EXPERT_BOT): number =>
      median(Array.from({ length: 12 }, (_, k) => simulate(level(), 100 + k, 60, style).needed ?? 99));
    expect(needed(EXPERT_BOT)).toBeLessThan(needed(RANDOM_BOT));
  });

  it('greedy takes the best move, zero weights pick evenly, strength mixes in the expert or random taps', () => {
    const game = createGame(level(), 9);
    const options = moveOptions(game.board, goalsOf(game), -1);
    const rng = { rng: 1 };
    const best = pickMove(options, EXPERT_BOT, rng);
    for (let m = 0; m < options.moves.length; m++) expect(score(options, m, EXPERT_BOT.weights)).toBeLessThanOrEqual(score(options, best, EXPERT_BOT.weights));
    const counts = (style: Parameters<typeof pickMove>[1]): number[] => {
      const c = new Array<number>(options.moves.length).fill(0);
      for (let k = 0; k < 4000; k++) c[pickMove(options, style, rng)]++;
      return c;
    };
    expect(Math.min(...counts(RANDOM_BOT))).toBeGreaterThan(0);
    // A taste that dislikes the expert's best move still takes it at full strength.
    const contrary = { weights: EXPERT_BOT.weights.map((w) => -w) };
    expect(counts({ ...contrary, strength: 1 })[best]).toBe(4000);
    expect(counts(contrary)[best]).toBeLessThan(400);
    expect(Math.min(...counts({ ...contrary, strength: -1 }))).toBeGreaterThan(0);
  });

  it('measures the finale on a won run', () => {
    const won = Array.from({ length: 6 }, (_, k) => simulate(level(), 200 + k, 60, EXPERT_BOT, { finale: true })).find((r) => r.needed !== null);
    expect(won?.finale).toBeGreaterThan(0);
  });
});
