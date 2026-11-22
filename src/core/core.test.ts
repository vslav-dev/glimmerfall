import { describe, expect, it } from 'vitest';
import { indexOf, posOf, swapPieces } from '@/core/board';
import { settle } from '@/core/fall';
import { advance, canStrike, canSwap, createGame, makeMove, playMove, startFinale, strike } from '@/core/game';
import { findGroups } from '@/core/matches';
import { findMoves, hasAnyMatch, hasMove, isValidSwap } from '@/core/moves';
import { resolveStep } from '@/core/resolve';
import { BlastKind, type Board, Booster, type GameEvent, type LevelDef, LevelKind, ObjectiveKind, type PendingSwap, Special } from '@/core/types';

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
    { name: 'square with a tail', rows: ['000', '001', '123'], special: Special.Bomb },
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

  it('a square on its own is no match', () => {
    expect(findGroups(boardFrom(['001', '002', '121']), [])).toHaveLength(0);
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
    const step = resolveStep(b, swap, level, fuse);
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

  it('a combo goes off at the cell the player touched, not where the moved piece landed', () => {
    const centers = (a: Special, b2: Special) => {
      const b = boardFrom(['01234', '12340', '23401', '34012', '40123']);
      b.cells[indexOf(b, 2, 1)].piece!.special = a;
      b.cells[indexOf(b, 2, 2)].piece!.special = b2;
      const clear = resolveMove(b, indexOf(b, 2, 1), indexOf(b, 2, 2))?.events.find((e) => e.type === 'clear');
      if (clear?.type !== 'clear') throw new Error('no clear');
      return { combo: clear.combo, origins: clear.blasts.filter((x) => x.order === 0).map((x) => x.origin) };
    };
    const lines = centers(Special.LineH, Special.LineV);
    expect(lines.combo).toEqual({ r: 2, c: 1 });
    expect(lines.origins).toEqual([{ r: 2, c: 1 }, { r: 2, c: 1 }]);
    const bombLine = centers(Special.Bomb, Special.LineH);
    expect(bombLine.combo).toEqual({ r: 2, c: 1 });
    // rows 1–3 and columns 0–2, each pair taken around (2,1)
    expect(bombLine.origins).toEqual([
      { r: 1, c: 1 }, { r: 2, c: 0 }, { r: 2, c: 1 }, { r: 2, c: 1 }, { r: 3, c: 1 }, { r: 2, c: 2 },
    ]);
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

    const first = resolveStep(b, null, 0, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.kind)).toEqual([BlastKind.Row]);
    const clear = first.events.find((e) => e.type === 'clear');
    expect(clear?.type === 'clear' && clear.lit.map((x) => x.id)).toEqual([col.id]);
    expect(fuse).toEqual([col.id]);
    expect(b.cells.some((cell) => cell.piece?.id === col.id)).toBe(true);

    const second = resolveStep(b, null, 1, fuse)!;
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

    const first = resolveStep(b, null, 0, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.origin)).toEqual([{ r: 1, c: 4 }]);
    expect(fuse).toEqual([low.id]);
  });

  it('of specials matched in one step only the topmost goes off; the rest are lit and wait', () => {
    const b = boardFrom(['00012', '23401', '34111', '40234', '12340']);
    const high = b.cells[indexOf(b, 0, 0)].piece!;
    const low = b.cells[indexOf(b, 2, 4)].piece!;
    high.special = Special.LineH;
    low.special = Special.LineH;
    const fuse: number[] = [];

    const first = resolveStep(b, null, 0, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.origin)).toEqual([{ r: 0, c: 0 }]);
    expect(fuse).toEqual([low.id]);
    expect(b.cells.some((cell) => cell.piece?.id === low.id)).toBe(true);

    const second = resolveStep(b, null, 1, fuse)!;
    expect(lineBlasts(second.events)).toHaveLength(1);
    expect(b.cells.some((cell) => cell.piece?.id === low.id)).toBe(false);
  });

  it('a matched special waits while a lit one goes off', () => {
    const b = boardFrom(['01234', '23401', '34111', '40234', '12340']);
    const litPiece = b.cells[indexOf(b, 0, 0)].piece!;
    const matched = b.cells[indexOf(b, 2, 4)].piece!;
    litPiece.special = Special.LineH;
    matched.special = Special.LineH;
    const fuse = [litPiece.id];

    const first = resolveStep(b, null, 0, fuse)!;
    expect(lineBlasts(first.events).map((x) => x.origin)).toEqual([{ r: 0, c: 0 }]);
    expect(fuse).toEqual([matched.id]);
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

describe('boosters', () => {
  const strikeBlasts = (events: GameEvent[]) =>
    events.flatMap((e) => (e.type === 'clear' ? e.blasts.filter((x) => x.kind === BlastKind.Star || x.kind === BlastKind.Meteor) : []));
  const calm = (): ReturnType<typeof createGame> => {
    const game = createGame(level({ rows: 7, cols: 7 }), 7);
    game.board = boardFrom(['0123401', '1234012', '2340123', '3401234', '4012340', '0123401', '1234012'], 5);
    return game;
  };

  it('aims only on a calm board, costs no move and plays in the next step', () => {
    const game = calm();
    expect(canStrike(game)).toBe(true);
    expect(strike(game, Booster.Star, { r: 3, c: 3 })).toBe(true);
    expect(game.movesLeft).toBe(20);
    expect(game.strikes).toBe(1);
    expect(canStrike(game)).toBe(false);
    expect(strikeBlasts(advance(game)!)).toHaveLength(1);
    while (advance(game)) continue;
    expect(canStrike(game)).toBe(true);
  });

  it('the star takes its cell and the four around it, every layer at once', () => {
    const game = calm();
    game.board.cells.forEach((cell) => (cell.ice = 2));
    game.board.cells[indexOf(game.board, 3, 3)].chain = 3;
    strike(game, Booster.Star, { r: 3, c: 3 });
    advance(game);
    expect(game.board.cells[indexOf(game.board, 3, 3)].chain).toBe(0);
    const cracked = game.board.cells.flatMap((cell, i) => (cell.ice === 0 ? [i] : []));
    expect(cracked.sort((a, b) => a - b)).toEqual([indexOf(game.board, 2, 3), indexOf(game.board, 3, 2), indexOf(game.board, 3, 3), indexOf(game.board, 3, 4), indexOf(game.board, 4, 3)]);
  });

  it('the meteor breaks every layer in its crater at once, and only there', () => {
    const game = calm();
    const b = game.board;
    const chained = indexOf(b, 3, 3);
    const iced = indexOf(b, 2, 4);
    const crate = indexOf(b, 5, 3);
    const corner = indexOf(b, 1, 1);
    b.cells[chained].chain = 2;
    b.cells[iced].ice = 2;
    b.cells[corner].ice = 2;
    b.cells[crate] = { ...b.cells[crate], piece: null, crate: 3 };
    strike(game, Booster.Meteor, { r: 3, c: 3 });
    const events = advance(game)!;
    expect(strikeBlasts(events)[0].cells).toHaveLength(21);
    expect(b.cells[chained].chain).toBe(0);
    expect(b.cells[iced].ice).toBe(0);
    expect(b.cells[crate].crate).toBe(0);
    // A corner of the 5×5 square is outside the crater.
    expect(b.cells[corner].ice).toBe(2);
  });

  it('a special in the crater is lit and goes off in a later step', () => {
    const game = calm();
    const special = game.board.cells[indexOf(game.board, 4, 4)].piece!;
    special.special = Special.LineH;
    strike(game, Booster.Meteor, { r: 3, c: 3 });
    const first = advance(game)!;
    const clear = first.find((e) => e.type === 'clear');
    expect(clear?.type === 'clear' && clear.lit.map((l) => l.id)).toEqual([special.id]);
    const later: GameEvent[] = [];
    for (let step = advance(game); step; step = advance(game)) later.push(...step);
    expect(later.some((e) => e.type === 'clear' && e.blasts.some((x) => x.kind === BlastKind.Row))).toBe(true);
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

  it('the last chance fires only the specials left on the board and creates none', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const game = createGame(level({ moves: 1, objectives: [{ kind: ObjectiveKind.Collect, target: 500, color: 1 }] }), seed);
      const kinds = [Special.LineH, Special.LineV, Special.Bomb, Special.Prism];
      game.board.cells.forEach((cell, i) => {
        if (cell.piece && i % 7 === 0) cell.piece.special = kinds[i % kinds.length];
      });
      game.movesLeft = 0;
      const before = new Set(game.board.cells.flatMap((c) => (c.piece && c.piece.special !== Special.None ? [c.piece.id] : [])));
      const events: GameEvent[] = [];
      for (let step = advance(game); step; step = advance(game)) events.push(...step);
      expect(events.filter((e) => e.type === 'lastChance')).toHaveLength(1);
      const lights = events.filter((e) => e.type === 'light');
      expect(lights).toHaveLength(1);
      for (const p of lights[0].type === 'light' ? lights[0].pieces : []) expect(before.has(p.id)).toBe(true);
      expect(events.flatMap((e) => (e.type === 'clear' ? e.created : []))).toEqual([]);
      expect(events.filter((e) => e.type === 'transform')).toEqual([]);
      expect(game.board.cells.some((c) => c.piece && c.piece.special !== Special.None)).toBe(false);
      expect(game.status).toBe('lost');
    }
  });

  it('after the last move only the swap itself makes a special; its cascades make none', () => {
    const game = createGame(level({ moves: 1 }), 7);
    // Swapping (1,3) up completes 0000 in row 0 (a special from the swap); row 3 is a ready 1111 for the cascade.
    game.board = boardFrom(['00020', '12301', '23412', '41111', '34123']);
    expect(makeMove(game, { r: 1, c: 3 }, { r: 0, c: 3 })?.valid).toBe(true);
    expect(game.movesLeft).toBe(0);
    const first = advance(game)!;
    const created = first.flatMap((e) => (e.type === 'clear' ? e.created : []));
    expect(created.map((c) => c.pos)).toEqual([{ r: 0, c: 3 }]);
    const later: GameEvent[] = [];
    for (let step = advance(game); step; step = advance(game)) later.push(...step);
    expect(later.flatMap((e) => (e.type === 'clear' ? e.created : []))).toEqual([]);
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
