import { describe, expect, it } from 'vitest';
import { createGame } from '@/core/game';
import { hasAnyMatch, hasMove } from '@/core/moves';
import { LevelKind, ObjectiveKind } from '@/core/types';
import { newDirector, recordAttempt, targetWinRate } from '@/difficulty/director';
import { draftLevel, finalizeLevel } from '@/gen/generator';
import { planLevel } from '@/gen/plan';

describe('generator', () => {
  it('is deterministic per level number', () => {
    const a = draftLevel({ number: 17, assist: 0 });
    const b = draftLevel({ number: 17, assist: 0 });
    expect(a).toEqual(b);
  });

  it('keeps the layout when assisting', () => {
    const a = draftLevel({ number: 26, assist: 0 }).level;
    const b = draftLevel({ number: 26, assist: 3 }).level;
    expect(b.mask).toEqual(a.mask);
    expect(b.crate).toEqual(a.crate);
    expect(b.ice).toEqual(a.ice);
    expect(b.colors).toBeLessThanOrEqual(a.colors);
  });

  it('produces valid, playable levels across the curve', () => {
    for (let n = 1; n <= 60; n += 3) {
      const level = finalizeLevel(draftLevel({ number: n, assist: 0 }), planLevel(n).baseWinRate);
      expect(level.moves).toBeGreaterThanOrEqual(10);
      expect(level.moves).toBeLessThanOrEqual(45);
      expect(level.objectives.length).toBeGreaterThan(0);
      for (const o of level.objectives) expect(o.target).toBeGreaterThan(0);
      if (level.objectives.some((o) => o.kind === ObjectiveKind.Score)) expect(level.objectives).toHaveLength(1);
      const game = createGame(level);
      expect(hasAnyMatch(game.board)).toBe(false);
      expect(hasMove(game.board)).toBe(true);
    }
  });

  it('gives more moves for a higher target win rate', () => {
    const draft = draftLevel({ number: 13, assist: 0 });
    expect(finalizeLevel(draft, 0.9).moves).toBeGreaterThanOrEqual(finalizeLevel(draft, 0.4).moves);
  });

  it('drafts a level fast enough for a worker between screens', () => {
    const start = performance.now();
    draftLevel({ number: 45, assist: 0 });
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe('plan', () => {
  it('introduces mechanics on intro levels', () => {
    expect(planLevel(4).kind).toBe(LevelKind.Intro);
    expect(planLevel(11).kind).toBe(LevelKind.Hard);
    expect(planLevel(12).kind).toBe(LevelKind.Relief);
  });
});

describe('director', () => {
  it('raises the target after failures and lowers it for a strong player', () => {
    const d = newDirector();
    const base = targetWinRate(d, 0.7, 0);
    expect(targetWinRate(d, 0.7, 2)).toBeGreaterThan(base);
    for (let i = 0; i < 10; i++) recordAttempt(d, { level: i, won: true, predicted: 0.7, movesLeftRatio: 0.5, usedExtraMoves: false });
    expect(targetWinRate(d, 0.7, 0)).toBeLessThan(base);
  });

  it('stays inside the corridor', () => {
    const d = newDirector();
    for (let i = 0; i < 50; i++) recordAttempt(d, { level: i, won: false, predicted: 0.9, movesLeftRatio: 0, usedExtraMoves: false });
    expect(targetWinRate(d, 0.5, 5)).toBeLessThanOrEqual(0.97);
    expect(targetWinRate(newDirector(), 0.1, 0)).toBeGreaterThanOrEqual(0.35);
  });
});
