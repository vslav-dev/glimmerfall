import { describe, expect, it } from 'vitest';
import { type Blast, BlastKind, type GameEvent, NO_COLOR, type Pos } from '@/core/types';
import { blastPower, bombRadius, hitstopMs, shakeOf } from '@/view/fx/impact';
import { planClear, Timing } from '@/view/fx/timeline';

type ClearEvent = Extract<GameEvent, { type: 'clear' }>;

function blast(kind: BlastKind, origin: Pos, cells: Pos[], order = 0, target: Pos | null = null): Blast {
  return { kind, origin, cells, order, target, color: NO_COLOR };
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

  it('takes the spark target when the star lands', () => {
    const spark = blast(BlastKind.Spark, { r: 0, c: 0 }, [], 0, { r: 5, c: 5 });
    const plan = planClear(clear([spark]), ON);
    expect(plan.at({ r: 5, c: 5 }, 1)).toBe(Timing.sparkFlight);
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
  it('ranks hits: spark < line < bomb < big bomb', () => {
    const p = (b: Blast): number => blastPower(b);
    const small = blast(BlastKind.Bomb, { r: 2, c: 2 }, [{ r: 1, c: 1 }, { r: 3, c: 3 }]);
    const big = blast(BlastKind.Bomb, { r: 2, c: 2 }, [{ r: 0, c: 0 }, { r: 4, c: 4 }]);
    expect(bombRadius(small)).toBe(1);
    expect(bombRadius(big)).toBe(2);
    expect(p(blast(BlastKind.Spark, { r: 0, c: 0 }, []))).toBeLessThan(p(blast(BlastKind.Row, { r: 0, c: 0 }, [])));
    expect(p(blast(BlastKind.Row, { r: 0, c: 0 }, []))).toBeLessThan(p(small));
    expect(p(small)).toBeLessThan(p(big));
  });

  it('freezes only big hits, longer for bigger', () => {
    expect(hitstopMs(0.42)).toBe(0);
    expect(hitstopMs(0.75)).toBeGreaterThan(0);
    expect(hitstopMs(1.5)).toBeGreaterThan(hitstopMs(0.75));
  });

  it('shakes every hit alike, harder along the move', () => {
    expect(shakeOf(1)).toBeGreaterThan(shakeOf(0));
    expect(shakeOf(5)).toBeGreaterThan(shakeOf(4));
  });
});
