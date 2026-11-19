import { describe, expect, it } from 'vitest';
import { posOf } from '@/core/board';
import { advance, canAct, createGame, makeMove, startFinale } from '@/core/game';
import { findMoves } from '@/core/moves';
import { type GameState, type LevelDef, LevelKind, ObjectiveKind } from '@/core/types';
import { decodeMoves, encodeMoves, newRecord, recordMove, recordStep, replayAttempt } from '@/telemetry/attempt';

function level(target: number): LevelDef {
  const size = 72;
  const lv: LevelDef = {
    number: 9,
    rows: 9,
    cols: 8,
    mask: new Array<number>(size).fill(1),
    ice: new Array<number>(size).fill(0),
    crate: new Array<number>(size).fill(0),
    chain: new Array<number>(size).fill(0),
    colors: 5,
    moves: 25,
    objectives: [{ kind: ObjectiveKind.Collect, target, color: 2 }],
    stars: [0, 1000, 2000],
    kind: LevelKind.Normal,
    intro: null,
    targetWinRate: 0.7,
  };
  lv.mask[0] = 0;
  lv.chain[30] = 1;
  lv.crate[45] = 2;
  return lv;
}

/** Plays like the app: board steps one by one, a swap now at rest, now in the middle of a cascade. */
function play(lv: LevelDef, seed: number) {
  const game = createGame(lv, seed);
  const record = newRecord(seed);
  for (let turn = 0; game.status === 'playing' && turn < 200; turn++) {
    const midCascade = turn % 3 === 1;
    let events = advance(game);
    while (events) {
      recordStep(record);
      if (midCascade && canAct(game)) break;
      events = advance(game);
    }
    if (!canAct(game)) continue;
    const moves = findMoves(game.board);
    if (moves.length === 0) continue;
    const [i, j] = moves[(turn * 7 + seed) % moves.length];
    const [a, b] = turn % 2 ? [posOf(game.board, i), posOf(game.board, j)] : [posOf(game.board, j), posOf(game.board, i)];
    expect(makeMove(game, a, b)?.valid).toBe(true);
    recordMove(record, game.board, a, b, turn % 5 === 0, turn * 450);
  }
  while (advance(game)) recordStep(record);
  if (game.status === 'won') {
    startFinale(game);
    while (advance(game)) continue;
  }
  return { game, record };
}

const summary = (g: GameState) => ({ status: g.status, score: g.score, made: g.movesMade, left: g.movesLeft, progress: g.progress });

describe('attempt record', () => {
  for (const [name, target] of [
    ['a won attempt', 12],
    ['a lost attempt', 500],
  ] as const) {
    it(`replays ${name} exactly from the board seed and the packed moves`, () => {
      const lv = level(target);
      const { game, record } = play(lv, 4242);
      expect(game.status).toBe(target === 12 ? 'won' : 'lost');
      const replayed = replayAttempt(lv, { board: record.board, moves: decodeMoves(encodeMoves(record.moves)) });
      expect(summary(replayed)).toEqual(summary(game));
    });
  }

  it('packs a move into four bytes', () => {
    const moves = [0, 2 ** 26 - 1, 123456];
    const text = encodeMoves(moves);
    expect(text.length).toBe(16);
    expect(decodeMoves(text)).toEqual(moves);
  });
});
