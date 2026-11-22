import { type Charges, EARN, progress, stock } from '@/app/boosters';
import { Booster } from '@/core/types';
import { perfFlag } from '@/telemetry/perf';
import { Glide } from '@/ui/glide';
import { Action } from '@/ui/ui';
import { S } from '@/ui/strings';
import type { BoardRect } from '@/view/boardView';

/** The bar's height and its gap to the board: the board keeps this much free under itself. */
export const BOOSTER_FOOTER = 74;
/** a fill rises this long; a finished booster bursts this long */
const FILL_MS = 900;
const BURST_MS = 520;

const ACTIONS: Record<Booster, Action> = { [Booster.Star]: Action.Star, [Booster.Meteor]: Action.Meteor };

/** A golden star falling down left, three tapered streaks of its tail up right. */
const STAR_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs>
    <linearGradient id="bt-star-tail" gradientUnits="userSpaceOnUse" x1="20" y1="28" x2="44" y2="6">
      <stop offset="0" stop-color="#fff6d0"/><stop offset="0.45" stop-color="#ffd25e" stop-opacity="0.7"/><stop offset="1" stop-color="#ffb030" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bt-star-body" cx="0.5" cy="0.55" r="0.55">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.4" stop-color="#fff0b0"/><stop offset="0.8" stop-color="#ffc940"/><stop offset="1" stop-color="#f09a1c"/>
    </radialGradient>
  </defs>
  <path d="M22.4 30.6 17.6 25.4 44 6Z" fill="url(#bt-star-tail)"/>
  <path d="M26.1 34.2 23.9 31.8 42 20Z" fill="url(#bt-star-tail)" opacity="0.75"/>
  <path d="M15.1 25.2 12.9 22.8 27 8Z" fill="url(#bt-star-tail)" opacity="0.75"/>
  <path transform="rotate(-14 17 31)" d="M17 19 20.2 26.6 28.4 27.3 22.1 32.7 24.1 40.7 17 36.4 10 40.7 11.9 32.7 5.6 27.3 13.8 26.6Z" fill="url(#bt-star-body)" stroke="#fff4cf" stroke-width="1" stroke-linejoin="round"/>
</svg>`;

/** A hot rock falling down left, its glowing face leading, flames streaming up right. */
const METEOR_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs>
    <linearGradient id="bt-flame-out" gradientUnits="userSpaceOnUse" x1="16" y1="30" x2="46" y2="3">
      <stop offset="0" stop-color="#ff5a1f"/><stop offset="0.55" stop-color="#ff3d2e" stop-opacity="0.55"/><stop offset="1" stop-color="#c2185b" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bt-flame-in" gradientUnits="userSpaceOnUse" x1="18" y1="30" x2="40" y2="8">
      <stop offset="0" stop-color="#fff1a8"/><stop offset="0.5" stop-color="#ffb347" stop-opacity="0.8"/><stop offset="1" stop-color="#ff7a2a" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bt-rock" cx="0.3" cy="0.72" r="0.8">
      <stop offset="0" stop-color="#ffc061"/><stop offset="0.3" stop-color="#d4501e"/><stop offset="0.7" stop-color="#57261a"/><stop offset="1" stop-color="#2a130e"/>
    </radialGradient>
  </defs>
  <path d="M8 25C17 13 31 6 46 2 40 14 32 28 23 40Z" fill="url(#bt-flame-out)"/>
  <path d="M12 26C20 16 29 11 40 7 35 16 29 26 22 35Z" fill="url(#bt-flame-in)"/>
  <path d="M28.5 30 25.2 36.1 19.9 40.8 13.4 38 8.3 33.5 8.9 26.7 12.7 20.7 19.6 21.1 25.8 23.5Z" fill="url(#bt-rock)" stroke="#ff9a4a" stroke-width="1" stroke-linejoin="round"/>
  <path class="line" d="M12 27 17 30 15 35M17 30 23 28 24 33" fill="none" stroke="#ffd27a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICONS: Record<Booster, string> = { [Booster.Star]: STAR_ICON, [Booster.Meteor]: METEOR_ICON };

/**
 * The two booster buttons under the board, at its right edge. Each icon fills with color from below as its
 * charge grows, with no numbers: the player reads how far it is. A ready booster glows; the star shows its
 * stock as pips. Gains play out: the fill rises, a finished booster bursts and the next one starts filling.
 */
export class BoosterBar {
  private readonly glide: Glide;
  private readonly buttons: Record<Booster, BoosterButton>;

  public constructor(
    private readonly el: HTMLElement,
    onCharged: () => void,
  ) {
    this.glide = new Glide(el);
    el.innerHTML = Object.values(Booster)
      .map((b) => {
        const pips = EARN[b].max > 1 ? `<span class="pips">${'<i></i>'.repeat(EARN[b].max)}</span>` : '';
        return `<button class="booster ${b}" data-action="${ACTIONS[b]}" aria-label="${S.boosterNames[b]}">
          <span class="orb">
            <span class="layer empty">${ICONS[b]}</span>
            <span class="layer fill"><span class="liquid"></span>${ICONS[b]}</span>
            <span class="surface"></span>
          </span>
          ${pips}
        </button>`;
      })
      .join('');
    const button = (b: Booster): BoosterButton => new BoosterButton(el.querySelector<HTMLElement>(`.booster.${b}`)!, onCharged);
    this.buttons = { [Booster.Star]: button(Booster.Star), [Booster.Meteor]: button(Booster.Meteor) };
  }

  /** Shows the bar with these charges as they are: a new level opens without replaying old gains. */
  public show(charges: Charges): void {
    this.el.classList.remove('off');
    for (const b of Object.values(Booster)) this.buttons[b].reset(stock(charges, b), progress(charges, b));
  }

  public hide(): void {
    this.el.classList.add('off');
    perfFlag('boosterReady', false);
    perfFlag('boosterGlow', false);
  }

  /** Follows the charges (gains animate), whether a booster can be aimed now, and which one is being aimed. */
  public update(charges: Charges, usable: boolean, aiming: Booster | null): void {
    const ready = Object.values(Booster).some((b) => stock(charges, b) > 0);
    // A ready button breathes while the board is calm: frames drawn meanwhile tell what that costs.
    perfFlag('boosterReady', ready);
    perfFlag('boosterGlow', ready && usable);
    for (const b of Object.values(Booster)) {
      const button = this.buttons[b];
      button.set(stock(charges, b), progress(charges, b));
      button.el.classList.toggle('usable', usable);
      button.el.classList.toggle('aiming', aiming === b);
    }
  }

  /** Resolves once every gain has played out. */
  public settled(): Promise<void> {
    return Promise.all(Object.values(this.buttons).map((b) => b.settled)).then(() => undefined);
  }

  /** Sits right under the board, its buttons at the board's right edge; drifts there like the board does. */
  public place(rect: BoardRect): void {
    this.el.style.left = `${rect.x}px`;
    this.el.style.top = `${rect.y + rect.height}px`;
    this.el.style.width = `${rect.width}px`;
    this.glide.follow();
  }
}

class BoosterButton {
  /** the stock and fill the button is heading to; `settled` resolves once it got there */
  private stock = 0;
  private fill = 0;
  public settled: Promise<void> = Promise.resolve();
  private readonly fillEl: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly pips: HTMLElement[];

  public constructor(
    public readonly el: HTMLElement,
    private readonly onCharged: () => void,
  ) {
    this.fillEl = el.querySelector('.fill')!;
    this.surfaceEl = el.querySelector('.surface')!;
    this.pips = [...el.querySelectorAll<HTMLElement>('.pips i')];
  }

  public reset(stock: number, fill: number): void {
    this.stock = stock;
    this.fill = fill;
    this.settled = Promise.resolve();
    this.render(stock, fill, false);
  }

  public set(stock: number, fill: number): void {
    if (stock === this.stock && fill === this.fill) return;
    const from = this.stock;
    this.stock = stock;
    this.fill = fill;
    this.settled = this.settled.then(async () => {
      // Each booster finished on the way fills up to the top and bursts; then the rest fills.
      for (let k = from + 1; k <= stock; k++) {
        this.render(k - 1, 1, true);
        await wait(FILL_MS);
        this.burst();
        const last = k === stock;
        this.render(k, last && fill === 1 ? 1 : 0, false);
        if (!last || fill < 1) await wait(BURST_MS / 2);
      }
      this.render(stock, fill, true);
      await wait(FILL_MS);
    });
  }

  private burst(): void {
    this.onCharged();
    this.el.classList.remove('burst');
    void this.el.offsetWidth;
    this.el.classList.add('burst');
    setTimeout(() => this.el.classList.remove('burst'), BURST_MS);
  }

  /** `animate` off jumps there at once: a fill starting over drops back without draining visibly. */
  private render(stock: number, fill: number, animate: boolean): void {
    this.el.classList.toggle('instant', !animate);
    // clip-path and transform only: no layout during play.
    this.fillEl.style.clipPath = `inset(${(1 - fill) * 100}% 0 0 0)`;
    this.surfaceEl.style.transform = `translateY(${(1 - fill) * 100}%)`;
    this.surfaceEl.classList.toggle('hidden', fill <= 0 || fill >= 1);
    this.el.classList.toggle('ready', stock > 0);
    this.el.classList.toggle('full', fill >= 1);
    this.pips.forEach((pip, k) => pip.classList.toggle('on', k < stock));
    if (!animate) void this.el.offsetWidth;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
