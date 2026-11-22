import { describe, expect, it } from 'vitest';
import { EARN, newCharges, progress, spend, stock, winGain, withGain } from '@/app/boosters';
import { Booster } from '@/core/types';

describe('booster charges', () => {
  it('a win charges the star from the moves left and the meteor from three stars', () => {
    const c = withGain(newCharges(), winGain(EARN.star.unit + 5, 3));
    expect(stock(c, Booster.Star)).toBe(1);
    expect(progress(c, Booster.Star)).toBeCloseTo(5 / EARN.star.unit);
    expect(progress(c, Booster.Meteor)).toBeCloseTo(1 / EARN.meteor.unit);
    expect(stock(withGain(c, winGain(0, 2)), Booster.Meteor)).toBe(0);
  });

  it('stops at the cap and shows a full stock as full', () => {
    const c = withGain(newCharges(), winGain(1000, 3));
    expect(stock(c, Booster.Star)).toBe(EARN.star.max);
    expect(progress(c, Booster.Star)).toBe(1);
    const meteor = withGain(withGain(withGain(c, winGain(0, 3)), winGain(0, 3)), winGain(0, 3));
    expect(stock(meteor, Booster.Meteor)).toBe(1);
  });

  it('spends one at a time and keeps the charge toward the next', () => {
    const c = withGain(newCharges(), winGain(2 * EARN.star.unit + 3, 0));
    expect(spend(c, Booster.Star)).toBe(true);
    expect(stock(c, Booster.Star)).toBe(1);
    expect(progress(c, Booster.Star)).toBeCloseTo(3 / EARN.star.unit);
    expect(spend(c, Booster.Meteor)).toBe(false);
  });
});
