import { Booster } from '@/core/types';

/**
 * How each booster is earned, in its own units of charge: the charge one booster takes, and how many can be kept.
 * The star charges from the moves left at each win, the meteor from 3-star wins. Charge past the cap is lost.
 * The twin wins with ~6 moves to spare and takes 3 stars in ~1 win of 6 (plans/09, balance): a star every ~7 wins,
 * a meteor every ~18.
 */
export const EARN: Record<Booster, { unit: number; max: number }> = {
  [Booster.Star]: { unit: 40, max: 3 },
  [Booster.Meteor]: { unit: 3, max: 1 },
};

/** Charge saved up per booster. */
export type Charges = Record<Booster, number>;

export function newCharges(): Charges {
  return { [Booster.Star]: 0, [Booster.Meteor]: 0 };
}

/** Boosters ready to use. */
export function stock(charges: Charges, b: Booster): number {
  return Math.floor(charges[b] / EARN[b].unit);
}

/** Way to the next booster, 0…1; 1 once the stock is full. */
export function progress(charges: Charges, b: Booster): number {
  const { unit, max } = EARN[b];
  return charges[b] >= unit * max ? 1 : (charges[b] % unit) / unit;
}

/** What a win earns: the moves left over feed the star, three stars the meteor. */
export function winGain(movesLeft: number, stars: number): Charges {
  return { [Booster.Star]: movesLeft, [Booster.Meteor]: stars === 3 ? 1 : 0 };
}

/** The charges with a gain added, each up to its cap. */
export function withGain(charges: Charges, gain: Charges): Charges {
  const capped = (b: Booster): number => Math.min(EARN[b].unit * EARN[b].max, charges[b] + gain[b]);
  return { [Booster.Star]: capped(Booster.Star), [Booster.Meteor]: capped(Booster.Meteor) };
}

/** Takes one booster from the stock; false when there is none. */
export function spend(charges: Charges, b: Booster): boolean {
  if (stock(charges, b) < 1) return false;
  charges[b] -= EARN[b].unit;
  return true;
}
