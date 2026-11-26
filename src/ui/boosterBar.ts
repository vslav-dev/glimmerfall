import { type Charges, EARN, progress, stock } from '@/app/boosters';
import { Booster } from '@/core/types';
import { Glide } from '@/ui/glide';
import { Action } from '@/ui/ui';
import { S } from '@/ui/strings';
import type { BoardRect } from '@/view/boardView';

/** The bar's height and its gap to the board: the board keeps this much free under itself. */
export const BOOSTER_FOOTER = 74;
/** a fill rises this long; a finished booster bursts this long */
const FILL_MS = 900;
const BURST_MS = 520;
const BURST_EASE = 'cubic-bezier(0.2, 1.6, 0.4, 1)';
/** a button gulps each spark that lands in it */
const GULP_MS = 260;
const GULP_FRAMES: Keyframe[] = [
  { transform: 'scale(1)', easing: BURST_EASE },
  { offset: 0.35, transform: 'scale(1.12)', easing: 'ease-out' },
  { transform: 'scale(1)' },
];

/** a press on a booster that moves this far is a drag, not a tap */
const DRAG_PX = 10;

/** A booster dragged out of its button onto the board. */
export interface BoosterDrag {
  /** the drag begins: false when the booster cannot be aimed now, and the press stays a tap */
  start(b: Booster): boolean;
  move(x: number, y: number): void;
  /** let go at this point of the screen, or null when the gesture was cancelled */
  drop(at: { x: number; y: number } | null): void;
}

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

/** An arrow rising out of a ring, a spark beside it: something new is waiting. */
const UPDATE_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="70 25" stroke-linecap="round" transform="rotate(-60 24 24)"/>
  <path d="M24 32V16M17 22.5 24 15.5 31 22.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M38 6l1.4 3.6L43 11l-3.6 1.4L38 16l-1.4-3.6L33 11l3.6-1.4z" fill="#fff"/>
</svg>`;

/**
 * The two booster buttons under the board, at its right edge. Each icon fills with color from below as its
 * charge grows, with no numbers: the player reads how far it is. A ready booster glows; the star shows its
 * stock as pips. Gains play out: the fill rises, a finished booster bursts and the next one starts filling.
 * A booster is aimed by a tap (then the board takes the strike) or dragged straight onto the board.
 */
export class BoosterBar {
  private readonly glide: Glide;
  private readonly buttons: Record<Booster, BoosterButton>;
  private readonly updateEl: HTMLElement;
  private readonly giveUpEl: HTMLElement;

  public constructor(
    private readonly el: HTMLElement,
    onCharged: () => void,
    drag: BoosterDrag,
  ) {
    this.glide = new Glide(el);
    el.innerHTML =
      `<button class="update-btn" data-action="${Action.Update}" aria-label="${S.update.button}" hidden>${UPDATE_ICON}</button>` +
      `<button class="give-up" data-action="${Action.GiveUp}" hidden>${S.giveUp}</button>` +
      Object.values(Booster)
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
    this.updateEl = el.querySelector<HTMLElement>('.update-btn')!;
    this.giveUpEl = el.querySelector<HTMLElement>('.give-up')!;
    const button = (b: Booster): BoosterButton => new BoosterButton(el.querySelector<HTMLElement>(`.booster.${b}`)!, onCharged);
    this.buttons = { [Booster.Star]: button(Booster.Star), [Booster.Meteor]: button(Booster.Meteor) };
    for (const b of Object.values(Booster)) draggable(b, this.buttons[b].el, drag);
  }

  /** Shows the bar with these charges as they are: a new level opens without replaying old gains. */
  public show(charges: Charges): void {
    this.el.classList.remove('off');
    for (const b of Object.values(Booster)) this.buttons[b].reset(stock(charges, b), progress(charges, b));
  }

  public hide(): void {
    this.el.classList.add('off');
    this.beckon(false);
  }

  /**
   * Out of moves, a saved booster may still finish the level: rings keep running out of the ready ones, as when
   * one is earned, and «Give up» sits beside them for a player who would rather keep it.
   */
  public beckon(on: boolean): void {
    this.el.classList.toggle('beckon', on);
    this.giveUpEl.hidden = !on;
  }

  /** Follows the charges (gains animate), whether a booster can be aimed now, and which one is being aimed. */
  public update(charges: Charges, usable: boolean, aiming: Booster | null): void {
    for (const b of Object.values(Booster)) {
      const button = this.buttons[b];
      button.set(stock(charges, b), progress(charges, b));
      button.el.classList.toggle('usable', usable);
      button.el.classList.toggle('aiming', aiming === b);
    }
  }

  /** A new version is out: its button appears at the bar's left end, with one pop to catch the eye. */
  public showUpdate(): void {
    if (!this.updateEl.hidden) return;
    this.updateEl.hidden = false;
    this.updateEl.animate([{ transform: 'scale(0)', opacity: 0, easing: BURST_EASE }, { transform: 'scale(1)', opacity: 1 }], BURST_MS);
  }

  /** The effects menu can stop a ready button's breathing halo. */
  public setGlow(on: boolean): void {
    this.el.classList.toggle('calm', !on);
  }

  /** Where a booster's sparks fly into: its orb. */
  public orb(b: Booster): HTMLElement {
    return this.buttons[b].orbEl;
  }

  /** A spark landed in the booster: the button gulps it. */
  public gulp(b: Booster): void {
    this.buttons[b].gulp();
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
  /** the stock and fill the button is heading to, and the stock it shows; `settled` resolves once it got there */
  private stock = 0;
  private fill = 0;
  private shown = 0;
  /** a finished booster is filling up and bursting: the fill catches up with the target after it */
  private crossing = false;
  public settled: Promise<void> = Promise.resolve();
  public readonly orbEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly pips: HTMLElement[];
  private gulping: Animation | null = null;

  public constructor(
    public readonly el: HTMLElement,
    private readonly onCharged: () => void,
  ) {
    this.orbEl = el.querySelector('.orb')!;
    this.fillEl = el.querySelector('.fill')!;
    this.surfaceEl = el.querySelector('.surface')!;
    this.pips = [...el.querySelectorAll<HTMLElement>('.pips i')];
  }

  public reset(stock: number, fill: number): void {
    this.stock = this.shown = stock;
    this.fill = fill;
    this.settled = Promise.resolve();
    this.render(stock, fill, false);
  }

  /** A fill that moves within the same stock heads there at once: a stream of small gains rises with each one. */
  public set(stock: number, fill: number): void {
    if (stock === this.stock && fill === this.fill) return;
    this.stock = stock;
    this.fill = fill;
    if (!this.crossing) this.settled = this.follow();
  }

  /** Each booster finished on the way fills up to the top and bursts; then the fill rises to wherever the target is by then. */
  private async follow(): Promise<void> {
    this.crossing = true;
    while (this.shown < this.stock) {
      this.render(this.shown, 1, true);
      await wait(FILL_MS);
      this.burst();
      this.shown++;
      const last = this.shown === this.stock;
      this.render(this.shown, last && this.fill === 1 ? 1 : 0, false);
      if (!last || this.fill < 1) await wait(BURST_MS / 2);
    }
    this.crossing = false;
    this.shown = this.stock;
    this.render(this.stock, this.fill, true);
    await wait(FILL_MS);
  }

  /** A ring of light bursts out and the button pops: Web Animations, transform and opacity only. */
  private burst(): void {
    this.onCharged();
    this.el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.9)' }], {
      duration: BURST_MS,
      easing: 'ease-out',
      pseudoElement: '::after',
    });
    this.orbEl.animate([{ transform: 'scale(1)', easing: BURST_EASE }, { offset: 0.4, transform: 'scale(1.22)', easing: BURST_EASE }, { transform: 'scale(1)' }], BURST_MS);
  }

  /** Restarted by every spark that lands, also mid-way: a stream of them keeps the button swallowing. */
  public gulp(): void {
    this.gulping?.cancel();
    this.gulping = this.el.animate(GULP_FRAMES, GULP_MS);
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

/**
 * A press that moves past DRAG_PX drags the booster: the button holds the pointer, so the finger is followed
 * over the board, and letting go drops it there. The click that may follow a drag does not reach the bar.
 */
function draggable(b: Booster, el: HTMLElement, drag: BoosterDrag): void {
  let from: { x: number; y: number } | null = null;
  let dragging = false;
  let dragged = false;
  const end = (at: { x: number; y: number } | null): void => {
    if (dragging) drag.drop(at);
    from = null;
    dragging = false;
  };
  el.addEventListener('pointerdown', (e) => {
    from = { x: e.clientX, y: e.clientY };
    dragging = dragged = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!from) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < DRAG_PX) return;
      dragging = dragged = drag.start(b);
      if (!dragging) {
        from = null;
        return;
      }
    }
    drag.move(e.clientX, e.clientY);
  });
  el.addEventListener('pointerup', (e) => end({ x: e.clientX, y: e.clientY }));
  el.addEventListener('pointercancel', () => end(null));
  el.addEventListener('click', (e) => {
    if (dragged) e.stopPropagation();
    dragged = false;
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
