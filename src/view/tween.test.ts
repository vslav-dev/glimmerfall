import { describe, expect, it } from 'vitest';
import { Tweens } from '@/view/tween';

describe('Tweens', () => {
  it('wakes the loop for a tween started after the previous one finished', async () => {
    let wakes = 0;
    const tweens = new Tweens(() => wakes++);
    // Invalid swap: there and back, the second half starts from an await.
    const swap = tweens.run(100, () => undefined).then(() => tweens.run(100, () => undefined));

    tweens.update(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(wakes).toBe(2);
    expect(tweens.active).toBe(true);

    tweens.update(100);
    await swap;
    expect(tweens.active).toBe(false);
  });

  it('tells pauses and tweens still in their delay from what moves on screen, and counts what finished', () => {
    const tweens = new Tweens(() => undefined);
    void tweens.wait(100);
    void tweens.run(100, () => undefined, { delay: 50 });
    expect(tweens.visual).toBe(false);
    expect(tweens.update(40)).toBe(0);
    expect(tweens.visual).toBe(false);
    expect(tweens.update(20)).toBe(0);
    expect(tweens.visual).toBe(true);
    expect(tweens.update(50)).toBe(1);
    expect(tweens.active).toBe(true);
    expect(tweens.update(100)).toBe(1);
    expect(tweens.active).toBe(false);
  });
});
