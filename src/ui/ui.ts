import { type GameState, type LevelDef, type Objective, ObjectiveKind, Special } from '@/core/types';
import { BoardSize, type Settings } from '@/app/save';
import { FrameName, frameDataUrl } from '@/view/art';
import { Counter } from '@/ui/counter';
import { PraisePicker } from '@/ui/praise';
import { S } from '@/ui/strings';

export const Action = {
  Play: 'play',
  Goals: 'goals',
  Pause: 'pause',
  Resume: 'resume',
  Restart: 'restart',
  Menu: 'menu',
  Next: 'next',
  ExtraMoves: 'extra-moves',
  Retry: 'retry',
  Settings: 'settings',
  Back: 'back',
  ToggleSound: 'toggle-sound',
  ToggleHaptics: 'toggle-haptics',
  ToggleMotion: 'toggle-motion',
  BoardSmaller: 'board-smaller',
  BoardBigger: 'board-bigger',
  Reset: 'reset',
  Skip: 'skip',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

const THEMES = 5;
/** One star shape for the HUD and the result card: an SVG centers exactly, a text glyph does not. */
const STAR_PATH = 'M12 2.4l2.95 6.07 6.65.95-4.8 4.7 1.13 6.63L12 17.6l-5.93 3.15 1.13-6.63-4.8-4.7 6.65-.95z';
const starSvg = (cls: string): string => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
const ICON_SIZE = 72;
/** Fast-forward: two arrows that run left to right while the button waits. */
const FF_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5l8 6.5-8 6.5z"/><path d="M12 5.5l8 6.5-8 6.5z"/></svg>';

/**
 * DOM layer: menus, cards and the HUD over the canvas. Only transform/opacity animate,
 * and the HUD updates text in place, so nothing here triggers layout during play.
 */
export class Ui {
  private readonly hud: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly curtainEl: HTMLElement;
  private readonly praiseEl: HTMLElement;
  private readonly praiseWords = new PraisePicker();
  private readonly icons = new Map<string, string>();
  private hudMoves: Counter | null = null;
  private hudScore: Counter | null = null;
  private hudGoalCounters: Counter[] = [];
  private hudFill: HTMLElement | null = null;
  private hudStars: HTMLElement[] = [];
  private hudGoals: HTMLElement[] = [];
  private resetArmed = false;

  public constructor(
    root: HTMLElement,
    private readonly onAction: (action: Action) => void,
  ) {
    this.hud = root.querySelector('#hud')!;
    this.overlay = root.querySelector('#overlay')!;
    this.curtainEl = root.querySelector('#curtain')!;
    this.praiseEl = root.querySelector('#praise')!;
    root.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (target) this.onAction(target.dataset.action as Action);
    });
    // `data-press` fires on touch-down, not on release: holding counts at once.
    root.addEventListener('pointerdown', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-press]');
      if (target) this.onAction(target.dataset.press as Action);
    });
  }

  public setTheme(level: number): void {
    document.documentElement.dataset.theme = String(Math.floor((level - 1) / 20) % THEMES);
  }

  // ---------- screens ----------

  public showTitle(level: number, resumable: boolean): void {
    const gems = [0, 1, 2, 3, 4, 5]
      .map((k) => `<img class="float-gem g${k}" src="${this.icon(FrameName.gem(k, Special.None))}" alt="">`)
      .join('');
    this.show(
      `<div class="title-screen">
        <div class="gems">${gems}</div>
        <h1 class="logo">${S.title}</h1>
        <p class="tagline">${S.tagline}</p>
        <button class="btn primary big" data-action="${Action.Play}">${resumable ? S.continue : S.play}</button>
        <p class="sub">${S.level(level)}</p>
        <p class="version">${S.version(__APP_VERSION__)}</p>
        <button class="btn icon corner" data-action="${Action.Settings}" aria-label="${S.settings}">⚙</button>
      </div>`,
      'title',
    );
  }

  /** What each goal means, in plain words; opens from the HUD goals at any time and on a mechanic's first level. */
  public showGoals(state: GameState): void {
    const def = state.level;
    const intro = def.intro !== null ? `<div class="badge intro">${S.intro[def.intro].title}</div>` : '';
    const goals = def.objectives
      .map((o, k) => {
        const left = Math.max(0, o.target - state.progress[k]);
        const text = left === 0 ? S.goalDone : S.goalHelp[o.kind](left);
        return `<div class="goal-help">${this.goalIcon(o)}<p>${text}</p></div>`;
      })
      .join('');
    const kinds = new Set<string>(def.objectives.map((o) => o.kind));
    const blockers = (['ice', 'crate', 'chain'] as const)
      .filter((b) => !kinds.has(b) && state.board.cells.some((cell) => cell[b] > 0))
      .map((b) => `<p class="hint">${S.blockerHelp[b]}</p>`)
      .join('');
    this.show(
      `<div class="card goals-help">
        <h2>${S.goals}</h2>
        ${intro}
        ${goals}
        ${blockers}
        <button class="btn primary big" data-action="${Action.Resume}">${S.gotIt}</button>
      </div>`,
    );
  }

  public showPause(): void {
    this.show(
      `<div class="card">
        <h2>${S.paused}</h2>
        <button class="btn primary big" data-action="${Action.Resume}">${S.resume}</button>
        <button class="btn" data-action="${Action.Restart}">${S.restart}</button>
        <button class="btn" data-action="${Action.Settings}">${S.settings}</button>
        <button class="btn ghost" data-action="${Action.Menu}">${S.menu}</button>
      </div>`,
    );
  }

  public showWin(stars: number, score: number): void {
    // Every slot shows a dashed outline at once; earned stars fly in over it.
    const starEls = [1, 2, 3]
      .map((k) => `<span class="star-slot" style="--i:${k}">${starSvg('outline')}${k <= stars ? starSvg('earned') : ''}</span>`)
      .join('');
    this.show(
      `<div class="card win">
        <h2>${S.win}</h2>
        <div class="stars">${starEls}</div>
        <p class="score-line">${S.score}: <b>${score.toLocaleString('ru-RU')}</b></p>
        <button class="btn primary big" data-action="${Action.Next}">${S.next}</button>
        <button class="btn ghost" data-action="${Action.Menu}">${S.menu}</button>
      </div>`,
    );
  }

  public showLose(state: GameState, canExtra: boolean, extra: number): void {
    const left = state.level.objectives
      .map((o, k) => (state.progress[k] < o.target ? this.goalHtml(o, o.target - state.progress[k]) : ''))
      .join('');
    this.show(
      `<div class="card lose">
        <h2>${state.movesLeft > 0 ? S.stuck : S.lose}</h2>
        <p>${S.almost}</p>
        <div class="goals">${left}</div>
        ${canExtra ? `<button class="btn primary big" data-action="${Action.ExtraMoves}">${S.extraMoves(extra)}</button>` : ''}
        <button class="btn ${canExtra ? '' : 'primary big'}" data-action="${Action.Retry}">${S.retry}</button>
        <button class="btn ghost" data-action="${Action.Menu}">${S.menu}</button>
      </div>`,
    );
  }

  public showSettings(settings: Settings): void {
    this.resetArmed = false;
    const toggle = (action: Action, label: string, on: boolean): string =>
      `<button class="toggle ${on ? 'on' : ''}" data-action="${action}"><span>${label}</span><i>${on ? S.on : S.off}</i></button>`;
    this.show(
      `<div class="card">
        <h2>${S.settings}</h2>
        ${toggle(Action.ToggleSound, S.sound, settings.sound)}
        ${toggle(Action.ToggleHaptics, S.haptics, settings.haptics)}
        ${toggle(Action.ToggleMotion, S.reducedMotion, settings.reducedMotion)}
        <div class="toggle stepper">
          <span>${S.boardSize}</span>
          <button data-action="${Action.BoardSmaller}" aria-label="${S.smaller}" ${settings.boardSize <= BoardSize.Min ? 'disabled' : ''}>−</button>
          <i>${S.percent(settings.boardSize)}</i>
          <button data-action="${Action.BoardBigger}" aria-label="${S.bigger}" ${settings.boardSize >= BoardSize.Max ? 'disabled' : ''}>+</button>
        </div>
        <button class="btn danger" data-action="${Action.Reset}">${S.reset}</button>
        <button class="btn primary" data-action="${Action.Back}">${S.back}</button>
      </div>`,
    );
  }

  /** First tap arms the reset, the second confirms. Returns whether it is confirmed. */
  public confirmReset(): boolean {
    if (this.resetArmed) return true;
    this.resetArmed = true;
    const button = this.overlay.querySelector<HTMLElement>(`[data-action="${Action.Reset}"]`);
    if (button) button.textContent = S.resetConfirm;
    return false;
  }

  /** Full-screen catcher that lets a tap anywhere fast-forward the finale; the button at the bottom says so. */
  public showSkipLayer(): void {
    this.show(
      `<div class="skip" data-press="${Action.Skip}">
        <button class="btn ff">${FF_SVG}<span>${S.speedUp}</span></button>
      </div>`,
      'clear',
    );
  }

  /** The finale now runs `factor` times faster: the button lights up and says so. */
  public showSpedUp(factor: number): void {
    const button = this.overlay.querySelector<HTMLElement>('.ff');
    if (!button) return;
    button.classList.add('on');
    button.querySelector('span')!.textContent = S.spedUp(factor);
  }

  public hideOverlay(): void {
    this.overlay.className = '';
    this.overlay.innerHTML = '';
  }

  private show(html: string, variant = ''): void {
    this.overlay.innerHTML = html;
    this.overlay.className = `visible ${variant}`;
  }

  // ---------- HUD ----------

  public showHud(def: LevelDef): void {
    this.hud.classList.remove('off');
    this.hud.innerHTML = `
      <div class="hud-moves"><span class="label">${S.moves}</span><b class="value"></b></div>
      <div class="hud-goals" data-action="${Action.Goals}" role="button" aria-label="${S.goals}">${def.objectives.map((o) => this.goalHtml(o, o.target)).join('')}</div>
      <button class="btn icon" data-action="${Action.Pause}" aria-label="${S.paused}">❚❚</button>
      <div class="hud-score">
        <div class="bar"><div class="track"><div class="fill"></div>${this.markHtml(0, '')}${this.markHtml(
          (def.stars[1] / def.stars[2]) * 100,
          def.stars[1].toLocaleString('ru-RU'),
        )}${this.markHtml(100, def.stars[2].toLocaleString('ru-RU'))}</div></div>
        <b class="value">0</b>
      </div>`;
    this.hudMoves = new Counter(this.hud.querySelector('.hud-moves .value')!);
    this.hudScore = new Counter(this.hud.querySelector('.hud-score .value')!);
    this.hudFill = this.hud.querySelector('.fill');
    this.hudStars = [...this.hud.querySelectorAll<HTMLElement>('.mark')];
    this.hudGoals = [...this.hud.querySelectorAll<HTMLElement>('.hud-goals .goal')];
    this.hudGoalCounters = this.hudGoals.map((el) => new Counter(el.querySelector('b')!));
  }

  public hideHud(): void {
    this.hud.classList.add('off');
  }

  public updateHud(state: GameState): void {
    const def = state.level;
    this.hudMoves?.set(state.movesLeft);
    this.hud.querySelector('.hud-moves')?.classList.toggle('low', state.movesLeft <= 5);
    this.hudScore?.set(state.score);
    // clip-path keeps the rounded ends and, unlike width, costs no layout.
    if (this.hudFill) this.hudFill.style.clipPath = `inset(0 ${(1 - Math.min(1, state.score / def.stars[2])) * 100}% 0 0 round 99px)`;
    // First star: the level is won; the other two: their score thresholds.
    const earned = [state.status === 'won', state.score >= def.stars[1], state.score >= def.stars[2]];
    this.hudStars.forEach((el, k) => el.classList.toggle('earned', earned[k]));
    def.objectives.forEach((o, k) => {
      const el = this.hudGoals[k];
      if (!el) return;
      const left = Math.max(0, o.target - state.progress[k]);
      // Every goal counts down, points included: the number is always "how much is left".
      this.hudGoalCounters[k].set(left);
      el.classList.toggle('done', left === 0);
    });
  }

  // ---------- feedback ----------

  /** `step` 0 is the first praised step of a cascade; later steps draw more excited words. */
  public praise(step: number): void {
    this.flashText(this.praiseWords.next(step));
  }

  public flashText(text: string): void {
    this.praiseEl.textContent = text;
    // Long phrases shrink to fit the screen width.
    this.praiseEl.style.setProperty('--chars', String(text.length));
    this.praiseEl.classList.remove('show');
    void this.praiseEl.offsetWidth;
    this.praiseEl.classList.add('show');
  }

  /** Fades to the curtain, runs the change behind it, fades back. */
  public async curtain(change: () => void | Promise<void>): Promise<void> {
    this.curtainEl.classList.add('on');
    await wait(220);
    // A failed change still lifts the curtain: the screen behind stays usable, the error reaches telemetry.
    try {
      await change();
    } finally {
      this.curtainEl.classList.remove('on');
    }
  }

  // ---------- helpers ----------

  private markHtml(left: number, label: string): string {
    return `<i class="mark" style="left:${left}%">${starSvg('')}${label ? `<span>${label}</span>` : ''}</i>`;
  }

  /**
   * The number keeps the width of its starting value: goals only count down, so the HUD row
   * never rewraps mid-level and never resizes the board under the player.
   */
  private goalHtml(o: Objective, value: number): string {
    const text = value.toLocaleString('ru-RU');
    return `<div class="goal">${this.goalIcon(o)}<b style="min-width:${text.length}ch">${text}</b></div>`;
  }

  private goalIcon(o: Objective): string {
    switch (o.kind) {
      case ObjectiveKind.Collect:
        return `<img src="${this.icon(FrameName.gem(o.color, Special.None))}" alt="">`;
      case ObjectiveKind.Ice:
        return `<img src="${this.icon(FrameName.ice(1))}" alt="">`;
      case ObjectiveKind.Crate:
        return `<img src="${this.icon(FrameName.crate(3))}" alt="">`;
      case ObjectiveKind.Score:
        return `<span class="score-icon">★</span>`;
    }
  }

  private icon(name: string): string {
    let url = this.icons.get(name);
    if (!url) {
      url = frameDataUrl(name, ICON_SIZE);
      this.icons.set(name, url);
    }
    return url;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
