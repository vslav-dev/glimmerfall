/**
 * Board gallery (plans/16): every archetype's boards for a few crafts, drawn in text, and the spread of what the
 * generator gives out: sizes, holes, free cells. Shapes only, no bots: it runs in a moment.
 * Runs only with GF_SHAPES=1; GF_LEVELS=1 also drafts whole levels from 6 on and draws them with their blockers.
 */
import { describe, it } from 'vitest';
import { hashSeed } from '@/core/rng';
import type { LevelDef } from '@/core/types';
import { draftLevel } from '@/gen/generator';
import { ARCHETYPES, makeShape } from '@/gen/shapes';
import { newModel, twinOf } from '@/player/model';

const draw = (rows: number, cols: number, cell: (i: number) => string): string =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r * cols + c)).join('')).join('\n');

/** `#` hole, `.` free, `~` ice, `▣` crate, `⛓` chain */
const drawLevel = (l: LevelDef): string =>
  draw(l.rows, l.cols, (i) => (l.mask[i] === 0 ? '  ' : l.crate[i] ? '▣ ' : l.chain[i] ? '⛓ ' : l.ice[i] > 1 ? '≈ ' : l.ice[i] ? '~ ' : '. '));

describe.runIf(process.env.GF_SHAPES)('shapes', () => {
  it('draws every archetype and the spread of the boards', () => {
    const cells: number[] = [];
    let fallbacks = 0;
    for (const a of ARCHETYPES) {
      const boards: string[] = [];
      for (let k = 0; k < 40; k++) {
        const craft = [0, 0.5, 1][k % 3];
        const s = makeShape(a, craft, k % 5 === 0, { rng: hashSeed(k, 77) });
        const free = s.mask.filter(Boolean).length;
        cells.push(free);
        if (free === s.rows * s.cols && a.name !== 'open' && a.name !== 'classic' && a.name !== 'tiny') fallbacks++;
        if (k < 3) boards.push(`${s.cols}x${s.rows} ${s.symmetry} craft ${craft}\n${draw(s.rows, s.cols, (i) => (s.mask[i] ? '██' : '  '))}`);
      }
      console.log(`🧩 ${a.name}\n${boards.join('\n\n')}\n`);
    }
    const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
    console.log(`📐 free cells mean ${mean.toFixed(1)}, min ${Math.min(...cells)}, max ${Math.max(...cells)}; full boards where a cut was meant ${fallbacks}/${cells.length}`);
  });

  it.runIf(process.env.GF_LEVELS)('draws drafted levels', () => {
    const style = { ...twinOf(newModel()), strength: 0.3 };
    for (let n = 6; n < 6 + Number(process.env.GF_LEVELS); n++) {
      const d = draftLevel({ seed: Number(process.env.GF_SEED ?? 777), number: n, style, pace: 1 });
      const goals = d.level.objectives.map((o) => `${o.kind}:${o.target}`).join(' ');
      console.log(`🗺️ L${n} ${d.level.kind} ${d.archetype} ${d.level.cols}x${d.level.rows} colors ${d.level.colors} ${goals}\n${drawLevel(d.level)}\n`);
    }
  }, 600_000);
});
