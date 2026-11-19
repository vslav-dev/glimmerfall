import { describe, expect, it } from 'vitest';
import { type BotStyle, pickMove, STRONG_BOT } from '@/bot/bot';
import { goalsOf, moveOptions } from '@/bot/evaluate';
import { posOf } from '@/core/board';
import { createGame, playMove } from '@/core/game';
import { type LevelDef, LevelKind, ObjectiveKind } from '@/core/types';
import { Difficulty, targetWinRate, updateSkill } from '@/player/difficulty';
import { newStyle, observeMove, type StyleState, twinOf } from '@/player/style';

function level(): LevelDef {
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
    moves: 1000,
    objectives: [{ kind: ObjectiveKind.Collect, target: 10_000, color: 1 }],
    stars: [0, 1000, 2000],
    kind: LevelKind.Normal,
    intro: null,
    targetWinRate: 0.7,
  };
}

/** A player who plays like `style` for `moves` moves. */
function observed(style: BotStyle, moves: number): StyleState {
  const s = newStyle();
  const game = createGame(level(), 11);
  const rng = { rng: 5 };
  for (let k = 0; k < moves; k++) {
    const options = moveOptions(game.board, goalsOf(game));
    const m = pickMove(options, style, rng);
    observeMove(s, options, m);
    const [i, j] = options.moves[m];
    playMove(game, posOf(game.board, i), posOf(game.board, j));
  }
  return s;
}

describe('style', () => {
  it('a new player starts in the middle', () => {
    const twin = twinOf(newStyle());
    expect(twin.craft).toBeGreaterThan(0.25);
    expect(twin.craft).toBeLessThan(0.65);
  });

  it('tells a random tapper from a deliberate player', () => {
    const random = twinOf(observed({ precision: 0, bonus: 0 }, 150));
    const strong = twinOf(observed(STRONG_BOT, 150));
    expect(random.precision).toBeLessThan(0.1);
    expect(random.craft).toBeLessThan(0.2);
    expect(strong.precision).toBeGreaterThan(0.6);
    expect(strong.craft).toBeGreaterThan(0.6);
  });

  it('recovers a middle precision', () => {
    const twin = twinOf(observed({ precision: 0.32, bonus: 1 }, 300));
    expect(twin.precision).toBeGreaterThan(0.15);
    expect(twin.precision).toBeLessThan(0.7);
  });
});

describe('difficulty', () => {
  it('orders the settings and helps after failures', () => {
    const easy = targetWinRate(0.7, Difficulty.Easy, 0, 0);
    const normal = targetWinRate(0.7, Difficulty.Normal, 0, 0);
    const hard = targetWinRate(0.7, Difficulty.Hard, 0, 0);
    expect(normal).toBeCloseTo(0.7);
    expect(easy).toBeGreaterThan(0.83);
    expect(hard).toBeCloseTo(0.5, 1);
    expect(targetWinRate(0.5, Difficulty.Hard, 0, 2)).toBeGreaterThan(targetWinRate(0.5, Difficulty.Hard, 0, 0));
  });

  it('stays inside the corridor', () => {
    expect(targetWinRate(0.95, Difficulty.Easy, -1, 6)).toBeLessThanOrEqual(0.97);
    expect(targetWinRate(0.3, Difficulty.Hard, 1, 0)).toBeGreaterThanOrEqual(0.25);
  });

  it('skill rises with wins, falls with losses, and is bounded', () => {
    const win = { won: true, predicted: 0.7, movesLeftRatio: 0.3, usedExtraMoves: false };
    const loss = { ...win, won: false, movesLeftRatio: 0 };
    expect(updateSkill(0, win)).toBeGreaterThan(0);
    expect(updateSkill(0, loss)).toBeLessThan(0);
    let skill = 0;
    for (let k = 0; k < 100; k++) skill = updateSkill(skill, win);
    expect(skill).toBeLessThanOrEqual(1);
    // A stronger player gets a lower target: fewer moves.
    expect(targetWinRate(0.7, Difficulty.Normal, skill, 0)).toBeLessThan(0.7);
  });
});
