/** Time constant of the drift: ~95% of the way is covered in three of these. */
const GLIDE_TAU = 90;

/**
 * Lets an element drift from its old layout spot to the new one instead of jumping,
 * e.g. when the system bars slide in and the viewport shrinks.
 * The drift decays exponentially, so a second change mid-way just adds to what is left.
 */
export class Glide {
  private left: number;
  private top: number;
  private x = 0;
  private y = 0;
  private frame = 0;
  private last = 0;

  public constructor(private readonly el: HTMLElement) {
    this.left = el.offsetLeft;
    this.top = el.offsetTop;
  }

  /** Call once layout has changed; the element starts where it was seen last. */
  public follow(): void {
    const { offsetLeft, offsetTop } = this.el;
    this.x += this.left - offsetLeft;
    this.y += this.top - offsetTop;
    this.left = offsetLeft;
    this.top = offsetTop;
    this.render();
    if (!this.frame && (this.x || this.y)) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (now: number): void => {
    const k = Math.exp(-(now - this.last) / GLIDE_TAU);
    this.last = now;
    this.x *= k;
    this.y *= k;
    if (Math.abs(this.x) < 0.5 && Math.abs(this.y) < 0.5) this.x = this.y = 0;
    this.render();
    this.frame = this.x || this.y ? requestAnimationFrame(this.tick) : 0;
  };

  private render(): void {
    this.el.style.translate = this.x || this.y ? `${this.x}px ${this.y}px` : '';
  }
}
