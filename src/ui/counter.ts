const ROLL_MS = 450;

/**
 * A HUD number that rolls to each new value and pops as it changes.
 * The first value shows at once.
 */
export class Counter {
  private shown: number | null = null;
  private target = 0;
  private frame = 0;

  public constructor(private readonly el: HTMLElement) {
    el.addEventListener('animationend', (e) => {
      if (e.animationName === 'num-bump') el.classList.remove('bump');
    });
  }

  public set(value: number): void {
    if (this.shown !== null && value === this.target) return;
    const from = this.shown ?? value;
    this.target = value;
    cancelAnimationFrame(this.frame);
    if (this.shown === null) {
      this.render(value);
      return;
    }
    this.bump();
    const start = performance.now();
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / ROLL_MS);
      // ease-out cubic: big jumps race first, then settle on the exact value
      this.render(Math.round(from + (value - from) * (1 - (1 - k) ** 3)));
      if (k < 1) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private render(value: number): void {
    this.shown = value;
    this.el.textContent = value.toLocaleString('ru-RU');
  }

  /** Restarts the pop, also mid-way: a fast cascade keeps the number bouncing. */
  private bump(): void {
    this.el.classList.remove('bump');
    void this.el.offsetWidth;
    this.el.classList.add('bump');
  }
}
