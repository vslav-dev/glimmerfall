import { perfFlag } from '@/telemetry/perf';

const ROLL_MS = 450;
const POP_MS = 420;
const POP_EASE = 'cubic-bezier(0.2, 1.8, 0.4, 1)';

/** counters rolling right now, for the perf flag */
let rolling = 0;

/**
 * A HUD number that rolls to each new value and pops as it changes. The first value shows at once.
 * The text is written only when the shown number changes, and the pop is a Web Animation restarted
 * without a forced reflow: a cascade changes the score every step.
 */
export class Counter {
  private shown: number | null = null;
  private target = 0;
  private frame = 0;
  private pop: Animation | null = null;
  private popFrames: Keyframe[] | null = null;

  /** `pops` tells whether the pop is on (the effects menu can switch it off). */
  public constructor(
    private readonly el: HTMLElement,
    private readonly pops: () => boolean,
  ) {}

  public set(value: number): void {
    if (this.shown !== null && value === this.target) return;
    const from = this.shown ?? value;
    this.target = value;
    if (this.frame) this.stopRolling();
    if (this.shown === null) {
      this.render(value);
      return;
    }
    this.bump();
    const start = performance.now();
    rolling++;
    perfFlag('hudRoll', true);
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / ROLL_MS);
      // ease-out cubic: big jumps race first, then settle on the exact value
      this.render(Math.round(from + (value - from) * (1 - (1 - k) ** 3)));
      if (k < 1) this.frame = requestAnimationFrame(tick);
      else this.stopRolling();
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopRolling(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    rolling--;
    perfFlag('hudRoll', rolling > 0);
  }

  private render(value: number): void {
    if (value === this.shown) return;
    this.shown = value;
    this.el.textContent = value.toLocaleString('ru-RU');
  }

  /** Restarts the pop, also mid-way: a fast cascade keeps the number bouncing. */
  private bump(): void {
    if (!this.pops()) return;
    this.pop?.cancel();
    this.pop = this.el.animate((this.popFrames ??= popFrames(this.el)), { duration: POP_MS });
  }
}

/** The pop's size and glow come from the element's CSS (`--bump`, `--bump-glow`), read once. */
function popFrames(el: HTMLElement): Keyframe[] {
  const style = getComputedStyle(el);
  const scale = style.getPropertyValue('--bump').trim() || '1.3';
  const glow = style.getPropertyValue('--bump-glow').trim() || style.getPropertyValue('--accent').trim() || '#fff';
  return [
    { offset: 0, transform: 'scale(1)', easing: POP_EASE },
    { offset: 0.35, transform: `scale(${scale})`, textShadow: `0 0 14px ${glow}, 0 0 4px #fff`, easing: POP_EASE },
    { offset: 1, transform: 'scale(1)' },
  ];
}
