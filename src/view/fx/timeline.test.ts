import { describe, expect, it } from 'vitest';
import { type Blast, BlastKind, type GameEvent, NO_COLOR, type Pos } from '@/core/types';
import { blastPower, bombRadius, feel } from '@/view/fx/impact';
import { planClear, Timing } from '@/view/fx/timeline';

type ClearEvent = Extract<GameEvent, { type: 'clear' }>;

function blast(kind: BlastKind, origin: Pos, cells: Pos[], order = 0): Blast {
  return { kind, origin, cells, order, color: NO_COLOR };
}

function clear(blasts: Blast[], combo: Pos | null = null): ClearEvent {
  return { type: 'clear', cascade: 0, removed: [], created: [], blasts, layers: [], popups: [], lit: [], combo };
}

const ON = { wave: true, charge: true };
const row = (r: number, cols: number): Pos[] => Array.from({ length: cols }, (_, c) => ({ r, c }));

describe('planClear', () => {
  it('runs a line out from its origin, cell by cell', () => {
    const plan = planClear(clear([blast(BlastKind.Row, { r: 2, c: 3 }, row(2, 8))]), ON);
    expect(plan.at({ r: 2, c: 3 }, 0)).toBe(0);
    expect(plan.at({ r: 2, c: 0 }, 0)).toBe(3 * Timing.line);
    expect(plan.at({ r: 2, c: 7 }, 0)).toBe(4 * Timing.line);
  });

  it('lands a whole blast at once without the wave', () => {
    const plan = planClear(clear([blast(BlastKind.Row, { r: 2, c: 3 }, row(2, 8))]), { wave: false, charge: true });
    expect(plan.at({ r: 2, c: 7 }, 0)).toBe(0);
  });

  it('fires a chained special once the wave reached it', () => {
    const line = blast(BlastKind.Row, { r: 0, c: 0 }, row(0, 6));
    const bomb = blast(BlastKind.Bomb, { r: 0, c: 5 }, [{ r: 0, c: 4 }, { r: 1, c: 5 }], 1);
    const plan = planClear(clear([bomb, line]), ON);
    expect(plan.blasts[0]).toBe(5 * Timing.line + Timing.fuse);
    expect(plan.at({ r: 1, c: 5 }, 1)).toBe(plan.blasts[0] + Timing.bomb);
  });

  it('holds everything back while a booster falls, the meteor longest', () => {
    const star = planClear(clear([blast(BlastKind.Star, { r: 2, c: 2 }, [{ r: 2, c: 2 }])]), ON);
    const meteor = planClear(clear([blast(BlastKind.Meteor, { r: 2, c: 2 }, [{ r: 2, c: 2 }, { r: 2, c: 4 }])]), ON);
    expect(star.at({ r: 2, c: 2 }, 0)).toBe(Timing.starFall);
    expect(meteor.at({ r: 2, c: 2 }, 0)).toBe(Timing.meteorFall);
    expect(meteor.at({ r: 2, c: 4 }, 0)).toBe(Timing.meteorFall + 2 * Timing.crater);
    expect(Timing.meteorFall).toBeGreaterThan(Timing.starFall);
  });

  it('holds everything back for a combo charge', () => {
    const plan = planClear(clear([blast(BlastKind.Bomb, { r: 3, c: 3 }, [{ r: 3, c: 3 }])], { r: 3, c: 3 }), ON);
    expect(plan.lead).toBe(Timing.comboCharge);
    expect(plan.blasts[0]).toBe(Timing.comboCharge);
    expect(plan.at({ r: 9, c: 9 }, 0)).toBe(Timing.comboCharge);
  });

  it('cracks a crate as the wave passes next door', () => {
    const plan = planClear(clear([blast(BlastKind.Row, { r: 0, c: 0 }, row(0, 4))]), ON);
    expect(plan.layer({ pos: { r: 1, c: 3 }, ice: 0, crate: 1, chain: 0, order: 0 })).toBe(3 * Timing.line + Timing.layerLag);
  });

  it('caps a prism wave on a big board', () => {
    const plan = planClear(clear([blast(BlastKind.Prism, { r: 0, c: 0 }, [{ r: 20, c: 20 }])]), ON);
    expect(plan.at({ r: 20, c: 20 }, 0)).toBe(Timing.prismMax);
  });
});

describe('impact', () => {
  it('ranks hits: star < line < bomb < big bomb < meteor', () => {
    const p = (b: Blast): number => blastPower(b);
    const small = blast(BlastKind.Bomb, { r: 2, c: 2 }, [{ r: 1, c: 1 }, { r: 3, c: 3 }]);
    const big = blast(BlastKind.Bomb, { r: 2, c: 2 }, [{ r: 0, c: 0 }, { r: 4, c: 4 }]);
    expect(bombRadius(small)).toBe(1);
    expect(bombRadius(big)).toBe(2);
    expect(p(blast(BlastKind.Star, { r: 0, c: 0 }, []))).toBeLessThan(p(blast(BlastKind.Row, { r: 0, c: 0 }, [])));
    expect(p(blast(BlastKind.Row, { r: 0, c: 0 }, []))).toBeLessThan(p(small));
    expect(p(small)).toBeLessThan(p(big));
    expect(p(big)).toBeLessThan(p(blast(BlastKind.Meteor, { r: 0, c: 0 }, [])));
  });

  it('builds up along the move: trembles first, freezes only deep into a chain', () => {
    expect(feel(1).shake).toBeGreaterThan(feel(0).shake);
    expect(feel(3).punch).toBeGreaterThan(feel(0).punch);
    expect(feel(0).stopMs).toBe(0);
    expect(feel(4).stopMs).toBe(0);
    expect(feel(8).stopMs).toBeGreaterThan(feel(5).stopMs);
  });
});
