import { describe, expect, it } from 'vitest';
import { indexOf, posOf, swapPieces } from '@/core/board';
import { settle } from '@/core/fall';
import { advance, canSwap, createGame, makeMove, playMove, scorerFor, startFinale } from '@/core/game';
import { findGroups } from '@/core/matches';
import { findMoves, hasAnyMatch, hasMove, isValidSwap } from '@/core/moves';
import { resolveStep } from '@/core/resolve';
import { BlastKind, type Board, type GameEvent, type LevelDef, LevelKind, ObjectiveKind, type PendingSwap, Special } from '@/core/types';

/** Digits are colors, '.' is a hole, '#' a crate, '_' an empty cell. */
function boardFrom(rows: string[], colors = 6): Board {
  const b: Board = { rows: rows.length, cols: rows[0].length, colors, cells: [], nextId: 1, rng: 42 };
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
  const fuse: number[] = [];
  for (let level = 0; ; level++) {
    const step = resolveStep(b, swap, level, noTarget, fuse);
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

describe('fuse', () => {
  const lineBlasts = (events: GameEvent[]) =>
    events.flatMap((e) => (e.type === 'clear' ? e.blasts.filter((x) => x.kind === BlastKind.Row || x.kind === BlastKind.Col) : []));

  it('a special hit by a blast is lit, stays on the board and goes off in the next step', () => {
    const b = boardFrom(['01234', '12340', '23401', '34012', '40123']);
    const row = b.cells[indexOf(b, 2, 0)].piece!;
    const col = b.cells[indexOf(b, 2, 3)].piece!;
    row.special = Special.LineH;
    col.special = Special.LineV;
    const fuse = [row.id];

    const first = resolveStep(b, null, 0, noTarget, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.kind)).toEqual([BlastKind.Row]);
    const clear = first.events.find((e) => e.type === 'clear');
    expect(clear?.type === 'clear' && clear.lit.map((x) => x.id)).toEqual([col.id]);
    expect(fuse).toEqual([col.id]);
    expect(b.cells.some((cell) => cell.piece?.id === col.id)).toBe(true);

    const second = resolveStep(b, null, 1, noTarget, fuse)!;
    expect(lineBlasts(second.events).map((x) => x.kind)).toEqual([BlastKind.Col]);
    expect(b.cells.some((cell) => cell.piece?.id === col.id)).toBe(false);
  });

  it('lit specials go off from the top down, whatever order they were lit in', () => {
    const b = boardFrom(['01234', '12340', '23401', '34012', '40123']);
    const low = b.cells[indexOf(b, 4, 0)].piece!;
    const high = b.cells[indexOf(b, 1, 4)].piece!;
    low.special = Special.LineH;
    high.special = Special.LineH;
    const fuse = [low.id, high.id];

    const first = resolveStep(b, null, 0, noTarget, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.origin)).toEqual([{ r: 1, c: 4 }]);
    expect(fuse).toEqual([low.id]);
  });

  it('prism + line lights the whole color; the lines go off one per step', () => {
    const game = createGame(level({ rows: 5, cols: 5 }), 7);
    game.board = boardFrom(['01234', '12340', '23401', '34012', '40123']);
    game.board.cells[0].piece = { id: 99, color: -1, special: Special.Prism };
    game.board.cells[1].piece!.special = Special.LineH;
    expect(makeMove(game, { r: 0, c: 0 }, { r: 0, c: 1 })?.valid).toBe(true);

    const first = advance(game)!;
    expect(first.map((e) => e.type)).toContain('transform');
    expect(lineBlasts(first)).toHaveLength(0);
    const lit = game.fuse!.length;
    expect(lit).toBe(5);

    let steps = 0;
    while (advance(game)) steps++;
    expect(steps).toBeGreaterThanOrEqual(lit);
    expect(game.fuse).toEqual([]);
  });
});

describe('prism wipe', () => {
  it('damages crates next to the wiped pieces, each crate once', () => {
    // Prism at (0,0) swaps with the 1 at (0,1); the 1s at (1,1) and (1,3) both touch the crate at (1,2).
    const b = boardFrom(['0123', '21#1', '3012']);
    b.cells[0].piece = { id: 99, color: -1, special: Special.Prism };
    const crate = indexOf(b, 1, 2);
    b.cells[crate].crate = 2;
    resolveMove(b, 0, 1);
    expect(b.cells[crate].crate).toBe(1);
  });
});

describe('spark', () => {
  const collectRed = level({ rows: 5, cols: 5, objectives: [{ kind: ObjectiveKind.Collect, target: 10, color: 1 }] });
  const sparkBlasts = (events: GameEvent[]) =>
    events.flatMap((e) => (e.type === 'clear' ? e.blasts.filter((x) => x.kind === BlastKind.Spark) : []));

  it('flies to a wanted piece before ice that is no goal', () => {
    const game = createGame(collectRed, 7);
    game.board = boardFrom(['02020', '20202', '02010', '20202', '02020']);
    game.board.cells.forEach((cell, i) => (cell.ice = i === 13 ? 0 : 2));
    game.board.cells[0].piece!.special = Special.Spark;
    const step = resolveStep(game.board, null, 0, scorerFor(game), [game.board.cells[0].piece!.id])!;
    expect(sparkBlasts(step.events)[0].target).toEqual({ r: 2, c: 3 });
    expect(step.tally.collected[1]).toBe(1);
  });

  it('a pair of sparks sends out four, splashing around the swap only once', () => {
    const game = createGame(collectRed, 7);
    game.board = boardFrom(['02020', '20202', '02020', '20202', '02020']);
    game.board.cells[11].piece!.special = Special.Spark;
    game.board.cells[12].piece!.special = Special.Spark;
    game.board.cells[7] = { ...game.board.cells[7], piece: null, crate: 3 };
    expect(makeMove(game, { r: 2, c: 1 }, { r: 2, c: 2 })?.valid).toBe(true);
    const step = advance(game)!;
    expect(sparkBlasts(step)).toHaveLength(4);
    expect(game.board.cells[7].crate).toBe(2);
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
    const a = createGame(level(), 7);
    const b = createGame(level(), 7);
    expect(a.board.cells.map((c) => c.piece?.color)).toEqual(b.board.cells.map((c) => c.piece?.color));
    expect(hasAnyMatch(a.board)).toBe(false);
    expect(hasMove(a.board)).toBe(true);
  });

  it('keeps invariants over many random moves', () => {
    const lv = level({ moves: 400 });
    lv.ice[20] = 2;
    lv.chain[30] = 1;
    lv.crate[44] = 2;
    const game = createGame(lv, 7);
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
    const game = createGame(level({ moves: 1 }), 7);
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

  it('out of moves, the last chance fires every special once and can still win', () => {
    const run = (target: number) => {
      const game = createGame(level({ moves: 1, objectives: [{ kind: ObjectiveKind.Collect, target, color: 1 }] }), 7);
      game.board = boardFrom(['01201', '12012', '20120']);
      game.board.cells[7].piece!.special = Special.LineH;
      game.movesLeft = 0;
      const first = advance(game);
      expect(first?.[0]).toEqual({ type: 'lastChance' });
      expect(game.lastChance).toBe(true);
      const types: string[] = [];
      for (let step = advance(game); step; step = advance(game)) types.push(...step.map((e) => e.type));
      expect(types).not.toContain('lastChance');
      return game.status;
    };
    // The line clears row 1: two pieces of color 1.
    expect(run(2)).toBe('won');
    expect(run(50)).toBe('lost');
  });

  it('the last chance keeps firing until no special is left, also those its cascades create', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const game = createGame(level({ moves: 1, objectives: [{ kind: ObjectiveKind.Collect, target: 500, color: 1 }] }), seed);
      const kinds = [Special.LineH, Special.LineV, Special.Bomb, Special.Spark];
      game.board.cells.forEach((cell, i) => {
        if (cell.piece && i % 7 === 0) cell.piece.special = kinds[i % kinds.length];
      });
      game.movesLeft = 0;
      const types: string[] = [];
      for (let step = advance(game); step; step = advance(game)) types.push(...step.map((e) => e.type));
      expect(types.filter((t) => t === 'lastChance')).toHaveLength(1);
      expect(game.board.cells.some((c) => c.piece && c.piece.special !== Special.None)).toBe(false);
      expect(game.status).toBe('lost');
    }
  });

  it('without specials on the board, running out of moves is a plain loss', () => {
    const game = createGame(level({ moves: 1, objectives: [{ kind: ObjectiveKind.Collect, target: 50, color: 1 }] }), 7);
    game.board = boardFrom(['01201', '12012', '20120']);
    game.movesLeft = 0;
    expect(advance(game)).toBeNull();
    expect(game.status).toBe('lost');
  });

  it('a board no shuffle can unlock is lost, not shuffled forever', () => {
    const game = createGame(level({ moves: 10 }), 7);
    game.board = boardFrom(['#0#1#', '#####']);
    expect(advance(game)?.map((e) => e.type)).toEqual(['shuffle']);
    expect(game.status).toBe('lost');
    expect(advance(game)).toBeNull();
  });

  it('the finale picks up the winning chain at its depth instead of starting over', () => {
    const game = createGame(level({ moves: 6 }), 7);
    game.status = 'won';
    game.cascade = 5;
    expect(advance(game)).toBeNull();
    expect(game.cascade).toBe(5);
    startFinale(game);
    expect(advance(game)).not.toBeNull();
    expect(game.cascade).toBe(6);
  });

  it('the finale fires step by step, scoring as it goes, until no special is left', () => {
    const game = createGame(level({ moves: 6 }), 7);
    game.status = 'won';
    const opening = startFinale(game);
    expect(opening[0]?.type).toBe('transform');
    expect(game.movesLeft).toBe(0);

    let steps = 0;
    let score = game.score;
    while (advance(game)) {
      steps++;
      expect(game.score).toBeGreaterThanOrEqual(score);
      score = game.score;
    }
    expect(steps).toBeGreaterThan(1);
    expect(game.score).toBeGreaterThan(0);
    expect(game.finale).toBe(0);
    expect(game.board.cells.some((c) => c.piece !== null && c.piece.special !== Special.None)).toBe(false);
  });
});
