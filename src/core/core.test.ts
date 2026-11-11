import { describe, expect, it } from 'vitest';
import { indexOf, posOf, swapPieces } from '@/core/board';
import { settle } from '@/core/fall';
import { advance, canSwap, createGame, makeMove, playMove } from '@/core/game';
import { findGroups } from '@/core/matches';
import { findMoves, hasAnyMatch, hasMove, isValidSwap } from '@/core/moves';
import { resolveStep } from '@/core/resolve';
import { type Board, type GameEvent, type LevelDef, LevelKind, ObjectiveKind, type PendingSwap, Special } from '@/core/types';

/** Digits are colors, '.' is a hole, '#' a crate, '_' an empty cell. */
function boardFrom(rows: string[], colors = 6): Board {
  const b: Board = { rows: rows.length, cols: rows[0].length, colors, cells: [], nextId: 1, rng: 42, bias: null };
  for (const row of rows) {
    for (const ch of row) {
      b.cells.push({
        exists: ch !== '.',
        piece: /\d/.test(ch) ? { id: b.nextId++, color: Number(ch), special: Special.None } : null,
        ice: 0,
        crate: ch === '#' ? 1 : 0,
        chain: 0,
      });
    }
  }
  return b;
}

const noTarget = (): number => 0;

function level(overrides: Partial<LevelDef> = {}): LevelDef {
  const rows = 8;
  const cols = 8;
  const n = rows * cols;
  return {
    number: 1,
    seed: 7,
    rows,
    cols,
    mask: new Array<number>(n).fill(1),
    ice: new Array<number>(n).fill(0),
    crate: new Array<number>(n).fill(0),
    chain: new Array<number>(n).fill(0),
    colors: 5,
    moves: 20,
    objectives: [{ kind: ObjectiveKind.Score, target: 1_000_000, color: -1 }],
    stars: [0, 1000, 2000],
    kind: LevelKind.Normal,
    intro: null,
    targetWinRate: 0.7,
    assistBias: null,
    ...overrides,
  };
}

describe('findGroups', () => {
  const cases: { name: string; rows: string[]; special: Special }[] = [
    { name: 'line of 3', rows: ['000', '121', '212'], special: Special.None },
    { name: 'line of 4 in a row', rows: ['0000', '1212', '2121'], special: Special.LineV },
    { name: 'line of 4 in a column', rows: ['01', '02', '01', '02'], special: Special.LineH },
    { name: 'line of 5', rows: ['00000', '12121'], special: Special.Prism },
    { name: 'L shape', rows: ['012', '012', '000'], special: Special.Bomb },
    { name: 'square', rows: ['001', '002', '121'], special: Special.Spark },
  ];
  for (const t of cases) {
    it(t.name, () => {
      const groups = findGroups(boardFrom(t.rows), []);
      expect(groups).toHaveLength(1);
      expect(groups[0].special).toBe(t.special);
    });
  }

  it('finds nothing on a calm board', () => {
    expect(findGroups(boardFrom(['012', '120', '201']), [])).toHaveLength(0);
  });
});

/** Swaps and resolves to rest like a whole move; null for an invalid swap. */
function resolveMove(b: Board, from: number, to: number): { events: GameEvent[]; score: number } | null {
  if (!isValidSwap(b, from, to)) return null;
  swapPieces(b, from, to);
  const events: GameEvent[] = [];
  let score = 0;
  let swap: PendingSwap | null = { from, to };
  for (let level = 0; ; level++) {
    const step = resolveStep(b, swap, level, noTarget);
    if (!step) break;
    events.push(...step.events);
    score += step.tally.score;
    swap = null;
  }
  return { events, score };
}

describe('resolveStep', () => {
  it('rejects a swap without a match', () => {
    expect(resolveMove(boardFrom(['012', '120', '201']), 0, 1)).toBeNull();
  });

  it('clears a match and refills the board', () => {
    const b = boardFrom(['0120', '1201', '0012', '2340']);
    const res = resolveMove(b, indexOf(b, 1, 2), indexOf(b, 2, 2));
    expect(res?.score).toBeGreaterThan(0);
    expect(b.cells.every((c) => c.piece !== null)).toBe(true);
    expect(hasAnyMatch(b)).toBe(false);
  });

  it('line + line clears a cross', () => {
    const b = boardFrom(['01234', '12340', '23401', '34012', '40123']);
    b.cells[indexOf(b, 2, 1)].piece!.special = Special.LineH;
    b.cells[indexOf(b, 2, 2)].piece!.special = Special.LineV;
    const clear = resolveMove(b, indexOf(b, 2, 1), indexOf(b, 2, 2))?.events.find((e) => e.type === 'clear');
    expect(clear?.type === 'clear' && clear.removed.length).toBe(9);
  });

  it('prism + plain wipes that color', () => {
    const b = boardFrom(['0123', '1230', '2301', '3012']);
    b.cells[0].piece = { id: 99, color: -1, special: Special.Prism };
    const clear = resolveMove(b, 0, 1)?.events.find((e) => e.type === 'clear');
    // prism + four pieces of color 1
    expect(clear?.type === 'clear' && clear.removed.length).toBe(5);
  });
});

describe('settle', () => {
  it('pieces fall through holes and spawn at the top', () => {
    const b = boardFrom(['1', '.', '_', '_']);
    const moves = settle(b);
    expect(b.cells[3].piece?.color).toBe(1);
    expect(b.cells[2].piece).not.toBeNull();
    expect(b.cells[0].piece).not.toBeNull();
    expect(moves.some((m) => m.spawned)).toBe(true);
  });

  it('cells under a crate fill diagonally', () => {
    const b = boardFrom(['010', '2#2', '0_1']);
    settle(b);
    expect(b.cells[indexOf(b, 2, 1)].piece).not.toBeNull();
    expect(b.cells.filter((c) => c.exists && c.crate === 0).every((c) => c.piece !== null)).toBe(true);
  });
});

describe('game', () => {
  it('creates the same calm, playable board for the same seed', () => {
    const a = createGame(level());
    const b = createGame(level());
    expect(a.board.cells.map((c) => c.piece?.color)).toEqual(b.board.cells.map((c) => c.piece?.color));
    expect(hasAnyMatch(a.board)).toBe(false);
    expect(hasMove(a.board)).toBe(true);
  });

  it('keeps invariants over many random moves', () => {
    const lv = level({ moves: 400 });
    lv.ice[20] = 2;
    lv.chain[30] = 1;
    lv.crate[44] = 2;
    const game = createGame(lv);
    for (let step = 0; step < 300 && game.status === 'playing'; step++) {
      const moves = findMoves(game.board);
      expect(moves.length).toBeGreaterThan(0);
      const [i, j] = moves[(step * 7) % moves.length];
      const b = game.board;
      expect(playMove(game, posOf(b, i), posOf(b, j))).toBe(true);
      expect(hasAnyMatch(b)).toBe(false);
      const ids = b.cells.flatMap((c) => (c.piece ? [c.piece.id] : []));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('a swap made during a cascade joins its next step, and goals count per step', () => {
    const game = createGame(level({ moves: 1 }));
    // Row 0 is a ready cascade match; swapping (2,2) down completes 333 at the bottom.
    game.board = boardFrom(['00012', '12340', '12312', '33401']);
    const swap = makeMove(game, { r: 2, c: 2 }, { r: 3, c: 2 });
    expect(swap).toEqual({ type: 'swap', a: { r: 2, c: 2 }, b: { r: 3, c: 2 }, valid: true });
    expect(game.movesLeft).toBe(0);
    expect(canSwap(game, { r: 0, c: 3 }, { r: 0, c: 4 })).toBe(false);

    const step = advance(game);
    const clear = step?.find((e) => e.type === 'clear');
    expect(clear?.type === 'clear' && clear.removed.length).toBe(6);
    expect(game.score).toBeGreaterThan(0);
    expect(game.progress[0]).toBe(game.score);
    expect(game.status).toBe('playing');

    while (advance(game)) continue;
    expect(game.status).toBe('lost');
    expect(hasAnyMatch(game.board)).toBe(false);
  });
});
