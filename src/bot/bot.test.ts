import { describe, expect, it } from 'vitest';
import { pickMove, RANDOM_BOT, simulate, STRONG_BOT } from '@/bot/bot';
import { goalsOf, moveOptions } from '@/bot/evaluate';
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
  it('values every valid move and leaves the board as it was', () => {
    const game = createGame(level(), 3);
    const before = JSON.stringify(game.board);
    const options = moveOptions(game.board, goalsOf(game));
    expect(options.moves).toEqual(findMoves(game.board));
    expect(options.plain.every((v) => v >= 3)).toBe(true);
    expect(JSON.stringify(game.board)).toBe(before);
  });

  it('prefers the wanted color', () => {
    const game = createGame(level(), 5);
    const options = moveOptions(game.board, goalsOf(game));
    const none = moveOptions(game.board, { wanted: 0, ice: false, crate: false });
    const wantedMove = options.moves.findIndex((_, m) => options.plain[m] > none.plain[m]);
    expect(wantedMove).toBeGreaterThanOrEqual(0);
  });
});

describe('bots', () => {
  it('the strong bot needs fewer moves than the random one', () => {
    const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const needed = (style: typeof STRONG_BOT): number =>
      median(Array.from({ length: 12 }, (_, k) => simulate(level(), 100 + k, 60, style).needed ?? 99));
    expect(needed(STRONG_BOT)).toBeLessThan(needed(RANDOM_BOT));
  });

  it('precision 0 picks evenly, Infinity always the best', () => {
    const game = createGame(level(), 9);
    const options = moveOptions(game.board, goalsOf(game));
    const rng = { rng: 1 };
    const best = pickMove(options, STRONG_BOT, rng);
    for (let m = 0; m < options.moves.length; m++) expect(options.plain[m] + 1.5 * options.bonus[m]).toBeLessThanOrEqual(options.plain[best] + 1.5 * options.bonus[best]);
    const counts = new Array<number>(options.moves.length).fill(0);
    for (let k = 0; k < 4000; k++) counts[pickMove(options, { precision: 0, bonus: 0 }, rng)]++;
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });

  it('measures the finale on a won run', () => {
    const won = Array.from({ length: 6 }, (_, k) => simulate(level(), 200 + k, 60, STRONG_BOT, { finale: true })).find((r) => r.needed !== null);
    expect(won?.finale).toBeGreaterThan(0);
  });
});
