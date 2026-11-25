import { describe, expect, it } from 'vitest';
import { EARN, newCharges, progress, sparkCount, spend, stock, winGain, withGain } from '@/app/boosters';
import { Booster } from '@/core/types';

describe('booster charges', () => {
  it('a win charges the star from the moves left and the meteor from two or three stars', () => {
    const c = withGain(newCharges(), winGain(EARN.star.unit + 5, 3));
    expect(stock(c, Booster.Star)).toBe(1);
    expect(progress(c, Booster.Star)).toBeCloseTo(5 / EARN.star.unit);
    expect(progress(c, Booster.Meteor)).toBeCloseTo(0.2);
    expect(progress(withGain(c, winGain(0, 2)), Booster.Meteor)).toBeCloseTo(0.25);
    expect(progress(withGain(c, winGain(0, 1)), Booster.Meteor)).toBeCloseTo(0.2);
  });

  it('stops at the cap and shows a full stock as full', () => {
    const c = withGain(newCharges(), winGain(1000, 3));
    expect(stock(c, Booster.Star)).toBe(EARN.star.max);
    expect(progress(c, Booster.Star)).toBe(1);
    const meteor = [3, 3, 3, 3, 3].reduce((m, stars) => withGain(m, winGain(0, stars)), c);
    expect(stock(meteor, Booster.Meteor)).toBe(1);
    expect(progress(meteor, Booster.Meteor)).toBe(1);
  });

  it('spends one at a time and keeps the charge toward the next', () => {
    const c = withGain(newCharges(), winGain(2 * EARN.star.unit + 3, 0));
    expect(spend(c, Booster.Star)).toBe(true);
    expect(stock(c, Booster.Star)).toBe(1);
    expect(progress(c, Booster.Star)).toBeCloseTo(3 / EARN.star.unit);
    expect(spend(c, Booster.Meteor)).toBe(false);
  });

  it('sends a spark per move to the star and two per twentieth to the meteor, none past the cap', () => {
    const c = newCharges();
    const won = (moves: number, stars: number) => withGain(c, winGain(moves, stars));
    expect(sparkCount(Booster.Star, c, won(10, 1))).toBe(10);
    expect(sparkCount(Booster.Meteor, won(10, 1), won(10, 2))).toBe(2);
    expect(sparkCount(Booster.Meteor, won(10, 2), won(10, 3))).toBe(6);
    const full = withGain(c, winGain(1000, 1));
    expect(sparkCount(Booster.Star, full, withGain(full, winGain(10, 1)))).toBe(0);
  });
});
