import { describe, expect, it } from 'vitest';
import { SECTIONS } from '@/ui/help';

const demos = SECTIONS.flatMap((s) => s.demos);

describe('help', () => {
  it('builds every demo with its script inside its loop', () => {
    for (const demo of demos) {
      const scene = demo.scene();
      for (const actor of scene.actors) for (const key of actor.keys) expect(key.t, demo.caption).toBeLessThanOrEqual(scene.ms);
    }
  });

  it('starts every board with no line of three ready', () => {
    for (const demo of demos) {
      const grid = demo.scene().layout.map((line) => line.split(' ').map((t) => (/^\d$/.test(t) ? t : `${t}?`)));
      const color = (r: number, c: number): string | undefined => grid[r]?.[c]?.[0];
      grid.forEach((row, r) =>
        row.forEach((_, c) => {
          const k = color(r, c);
          if (k === undefined || !/\d/.test(k)) return;
          expect(k === color(r, c + 1) && k === color(r, c + 2), `${demo.caption} row ${r}:${c}`).toBe(false);
          expect(k === color(r + 1, c) && k === color(r + 2, c), `${demo.caption} col ${r}:${c}`).toBe(false);
        }),
      );
    }
  });
});
