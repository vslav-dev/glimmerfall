/**
 * Every visual effect that can be switched off on its own, in the order of the debug menu.
 * A new effect is one entry here, its name in the strings and a check where it plays.
 */
export const Fx = {
  Shake: 'shake',
  Punch: 'punch',
  Hitstop: 'hitstop',
  Wave: 'wave',
  Flash: 'flash',
  Shards: 'shards',
  Sparks: 'sparks',
  Glitter: 'glitter',
  Line: 'line',
  Bomb: 'bomb',
  Prism: 'prism',
  Spark: 'spark',
  Combo: 'combo',
  Create: 'create',
  Recoil: 'recoil',
  Debris: 'debris',
  Bounce: 'bounce',
  SwapDepth: 'swap-depth',
  Popups: 'popups',
} as const;
export type Fx = (typeof Fx)[keyof typeof Fx];

/** Effects switched off in the debug menu; every other one plays. */
export type FxChoice = Partial<Record<Fx, boolean>>;

export class FxSwitches {
  private choice: FxChoice = {};

  public set(choice: FxChoice): void {
    this.choice = choice;
  }

  public on(fx: Fx): boolean {
    return this.choice[fx] !== false;
  }
}
