import { type GameState, LevelKind, type LevelDef, type Objective, ObjectiveKind, Special } from '@/core/types';
import type { Settings } from '@/app/save';
import { FrameName, frameDataUrl } from '@/view/art';
import { S } from '@/ui/strings';

export const Action = {
  Play: 'play',
  Start: 'start',
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
  Reset: 'reset',
  Skip: 'skip',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

const THEMES = 5;
const ICON_SIZE = 72;

/**
 * DOM layer: menus, cards and the HUD over the canvas. Only transform/opacity animate,
 * and the HUD updates text in place, so nothing here triggers layout during play.
 */
export class Ui {
  private readonly hud: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly curtainEl: HTMLElement;
  private readonly praiseEl: HTMLElement;
  private readonly icons = new Map<string, string>();
  private hudMoves: HTMLElement | null = null;
  private hudScore: HTMLElement | null = null;
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
        <button class="btn icon corner" data-action="${Action.Settings}" aria-label="${S.settings}">⚙</button>
      </div>`,
      'title',
    );
  }

  public showLevelCard(def: LevelDef, fails: number, resumable: boolean): void {
    const badge =
      def.intro !== null
        ? `<div class="badge intro">${S.intro[def.intro].title}</div><p class="hint">${S.intro[def.intro].text}</p>`
        : def.kind === LevelKind.Hard
          ? `<div class="badge hard">${S.hard}</div>`
          : def.kind === LevelKind.Relief && def.number > 3
            ? `<div class="badge relief">${S.relief}</div>`
            : '';
    const goals = def.objectives.map((o) => this.goalHtml(o, o.target)).join('');
    this.show(
      `<div class="card">
        <h2>${S.level(def.number)}</h2>
        ${badge}
        <div class="goals">${goals}</div>
        <p class="moves-line">${S.movesCount(def.moves)}</p>
        ${fails >= 3 ? `<p class="hint">${S.assist}</p>` : ''}
        <button class="btn primary big" data-action="${Action.Start}">${resumable ? S.continue : S.start}</button>
        <button class="btn ghost" data-action="${Action.Menu}">${S.menu}</button>
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
    const starEls = [1, 2, 3].map((k) => `<span class="star ${k <= stars ? 'earned' : ''}" style="--i:${k}">★</span>`).join('');
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
        <h2>${S.lose}</h2>
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

  /** Invisible full-screen catcher that lets a tap fast-forward the finale. */
  public showSkipLayer(): void {
    this.show(`<div class="skip" data-action="${Action.Skip}"><span>${S.tapToSkip}</span></div>`, 'clear');
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
      <div class="hud-goals">${def.objectives.map((o) => this.goalHtml(o, o.target)).join('')}</div>
      <button class="btn icon" data-action="${Action.Pause}" aria-label="${S.paused}">❚❚</button>
      <div class="hud-score">
        <div class="bar"><div class="fill"></div>
          <i class="mark" style="left:${(def.stars[1] / def.stars[2]) * 100}%">★</i><i class="mark" style="left:100%">★</i>
        </div>
        <b class="value">0</b>
      </div>`;
    this.hudMoves = this.hud.querySelector('.hud-moves .value');
    this.hudScore = this.hud.querySelector('.hud-score .value');
    this.hudFill = this.hud.querySelector('.fill');
    this.hudStars = [...this.hud.querySelectorAll<HTMLElement>('.mark')];
    this.hudGoals = [...this.hud.querySelectorAll<HTMLElement>('.hud-goals .goal')];
  }

  public hideHud(): void {
    this.hud.classList.add('off');
  }

  public updateHud(state: GameState): void {
    const def = state.level;
    if (this.hudMoves) {
      this.hudMoves.textContent = String(state.movesLeft);
      this.hudMoves.parentElement!.classList.toggle('low', state.movesLeft <= 5);
    }
    if (this.hudScore) this.hudScore.textContent = state.score.toLocaleString('ru-RU');
    if (this.hudFill) this.hudFill.style.transform = `scaleX(${Math.min(1, state.score / def.stars[2])})`;
    this.hudStars.forEach((el, k) => el.classList.toggle('earned', state.score >= def.stars[k + 1]));
    def.objectives.forEach((o, k) => {
      const el = this.hudGoals[k];
      if (!el) return;
      const left = Math.max(0, o.target - state.progress[k]);
      el.querySelector('b')!.textContent = o.kind === ObjectiveKind.Score ? state.score.toLocaleString('ru-RU') : String(left);
      el.classList.toggle('done', left === 0);
    });
  }

  // ---------- feedback ----------

  public praise(level: number): void {
    const words = S.praise;
    this.flashText(words[Math.min(words.length - 1, level)]);
  }

  public flashText(text: string): void {
    this.praiseEl.textContent = text;
    this.praiseEl.classList.remove('show');
    void this.praiseEl.offsetWidth;
    this.praiseEl.classList.add('show');
  }

  /** Fades to the curtain, runs the change behind it, fades back. */
  public async curtain(change: () => void | Promise<void>): Promise<void> {
    this.curtainEl.classList.add('on');
    await wait(220);
    await change();
    this.curtainEl.classList.remove('on');
  }

  // ---------- helpers ----------

  private goalHtml(o: Objective, value: number): string {
    const label = o.kind === ObjectiveKind.Score ? value.toLocaleString('ru-RU') : String(value);
    return `<div class="goal">${this.goalIcon(o)}<b>${label}</b></div>`;
  }

  private goalIcon(o: Objective): string {
    switch (o.kind) {
      case ObjectiveKind.Collect:
        return `<img src="${this.icon(FrameName.gem(o.color, Special.None))}" alt="">`;
      case ObjectiveKind.Ice:
        return `<img src="${this.icon(FrameName.ice(1))}" alt="">`;
      case ObjectiveKind.Crate:
        return `<img src="${this.icon(FrameName.crate(1))}" alt="">`;
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
