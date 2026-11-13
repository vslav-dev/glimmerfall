import { describe, expect, it } from 'vitest';
import { PRAISE_WORDS, PraisePicker, targetRating } from '@/ui/praise';

/** Small deterministic PRNG (mulberry32), so the statistics below are stable. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ratingOf = new Map(PRAISE_WORDS.map((w) => [w.word, w.rating]));

function meanRating(step: number): number {
  const picker = new PraisePicker(seeded(step + 1));
  let sum = 0;
  for (let k = 0; k < 400; k++) sum += ratingOf.get(picker.next(step))!;
  return sum / 400;
}

describe('praise', () => {
  it('has a large list of unique words on every rating', () => {
    expect(new Set(PRAISE_WORDS.map((w) => w.word)).size).toBe(PRAISE_WORDS.length);
    for (let r = 1; r <= 10; r++) expect(PRAISE_WORDS.filter((w) => w.rating === r).length).toBeGreaterThanOrEqual(15);
  });

  it('aims higher the longer the cascade runs, nearing but never passing the peak', () => {
    expect(targetRating(0)).toBe(1);
    for (let k = 1; k < 60; k++) expect(targetRating(k)).toBeGreaterThan(targetRating(k - 1));
    expect(targetRating(1000)).toBeLessThanOrEqual(10);
  });

  it('draws more excited words later in a cascade', () => {
    const early = meanRating(0);
    const middle = meanRating(4);
    const late = meanRating(20);
    expect(early).toBeLessThan(2);
    expect(middle).toBeGreaterThan(early + 2);
    expect(late).toBeGreaterThan(middle + 2);
  });

  it('never repeats a word within a long run', () => {
    const picker = new PraisePicker(seeded(7));
    const words = Array.from({ length: 200 }, (_, k) => picker.next(k % 12));
    for (let k = 1; k < words.length; k++) expect(words.slice(Math.max(0, k - 5), k)).not.toContain(words[k]);
  });
});
