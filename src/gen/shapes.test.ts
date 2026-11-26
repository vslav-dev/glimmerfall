import { describe, expect, it } from 'vitest';
import { hashSeed } from '@/core/rng';
import { ARCHETYPES, archetypeOf, DECK_FROM, isPlayable, makeShape, orbitOf } from '@/gen/shapes';

describe('shapes', () => {
  it('deals every archetype once per deck and never the same twice in a row', () => {
    const k = ARCHETYPES.length;
    for (const seed of [1, 2, 3, 12345]) {
      const names = Array.from({ length: 4 * k }, (_, m) => archetypeOf(seed, DECK_FROM + m).name);
      for (let d = 0; d < 4; d++) expect(new Set(names.slice(d * k, (d + 1) * k)).size).toBe(k);
      for (let m = 1; m < names.length; m++) expect(names[m], `seed ${seed}, level ${DECK_FROM + m}`).not.toBe(names[m - 1]);
    }
  });

  it('cuts playable, symmetric boards that fit the screen and the telemetry', () => {
    for (const a of ARCHETYPES) {
      for (let k = 0; k < 30; k++) {
        const pearls = k % 2 === 0;
        const s = makeShape(a, k % 3 === 0 ? 0 : 1, pearls, { rng: hashSeed(k, 5) });
        const label = `${a.name} #${k}`;
        expect(s.cols, label).toBeLessThanOrEqual(9);
        expect(s.rows * s.cols, label).toBeLessThanOrEqual(99);
        expect(isPlayable(s.mask, s.rows, s.cols), label).toBe(true);
        s.mask.forEach((m, i) => {
          for (const j of orbitOf(i, s.rows, s.cols, s.symmetry)) expect(s.mask[j], label).toBe(m);
        });
        if (!pearls) continue;
        // Every pearl exit, the lowest cell of a column, has a line of three across it.
        const at = (r: number, c: number): boolean => c >= 0 && c < s.cols && s.mask[r * s.cols + c] === 1;
        for (let c = 0; c < s.cols; c++) {
          let r = s.rows - 1;
          while (r >= 0 && !at(r, c)) r--;
          if (r < 0) continue;
          const across = (at(r, c - 1) && (at(r, c - 2) || at(r, c + 1))) || (at(r, c + 1) && at(r, c + 2));
          expect(across, `${label}, column ${c}`).toBe(true);
        }
      }
    }
  });

  it('cuts the boards most archetypes are named for', () => {
    const whole = ARCHETYPES.filter((a) => !['classic', 'open', 'tiny', 'tower', 'wide'].includes(a.name)).flatMap((a) =>
      Array.from({ length: 10 }, (_, k) => makeShape(a, 0.5, false, { rng: hashSeed(k, 9) })).filter((s) => s.mask.every(Boolean)),
    );
    expect(whole.length).toBeLessThanOrEqual(3);
  });
});
