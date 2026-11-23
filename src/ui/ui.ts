import { chosen, type SoundChoice, VARIANTS } from '@/audio/sounds';
import { Sfx } from '@/audio/synth';
import { type GameState, type LevelDef, type Objective, ObjectiveKind, Special } from '@/core/types';
import { BoardSize, type Settings } from '@/app/save';
import type { Update } from '@/app/updates';
import { DIFFICULTIES } from '@/player/difficulty';
import { perfFlag } from '@/telemetry/perf';
import { FrameName, frameDataUrl } from '@/view/art';
import { Fx, type FxChoice } from '@/view/fx/switches';
import { Counter } from '@/ui/counter';
import { Glide } from '@/ui/glide';
import { helpHtml, playHelp } from '@/ui/help';
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
  ToggleFullscreen: 'toggle-fullscreen',
  BoardSmaller: 'board-smaller',
  BoardBigger: 'board-bigger',
  Easier: 'easier',
  Harder: 'harder',
  Reset: 'reset',
  Sounds: 'sounds',
  SoundPrev: 'sound-prev',
  SoundNext: 'sound-next',
  SoundPlay: 'sound-play',
  Effects: 'effects',
  ToggleEffect: 'toggle-effect',
  Star: 'use-star',
  Meteor: 'use-meteor',
  Update: 'update',
  UpdateLater: 'update-later',
  ApplyUpdate: 'apply-update',
  GiveUp: 'give-up',
  Help: 'help',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

const THEMES = 5;
/** One star shape for the HUD and the result card: an SVG centers exactly, a text glyph does not. */
const STAR_PATH = 'M12 2.4l2.95 6.07 6.65.95-4.8 4.7 1.13 6.63L12 17.6l-5.93 3.15 1.13-6.63-4.8-4.7 6.65-.95z';
const starSvg = (cls: string): string => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
const ICON_SIZE = 72;
/** Two rounded bars: a glyph sits off center in a round button, a path does not. */
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.6"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.6"/></svg>';
/**
 * A flashed word pops in, holds and drifts up as it fades: opacity and transform only, run by the compositor.
 * A lone word holds long enough to read; in a fast cascade each next word cuts the previous one short,
 * so the words change as fast as the cascade goes. The pop and the fade keep their pace, only the hold is long.
 */
const FLASH_MS = 1400;
/** the moves orb starts warning at this many moves left; its pulse runs from slow to fast over them, ms per beat */
const LOW_MOVES = 5;
const ALARM_SLOW_MS = 2600;
const ALARM_FAST_MS = 550;
const FLASH_FADE_MS = 200;
const FLASH_FRAMES: Keyframe[] = [
  { offset: 0, opacity: 0, transform: 'translate(-50%, -50%) scale(0.5)', easing: 'ease-out' },
  { offset: 200 / FLASH_MS, opacity: 1, transform: 'translate(-50%, -50%) scale(1.12)', easing: 'ease-out' },
  { offset: 350 / FLASH_MS, transform: 'translate(-50%, -50%) scale(1)', easing: 'ease-out' },
  { offset: 1 - FLASH_FADE_MS / FLASH_MS, opacity: 1, easing: 'ease-out' },
  { offset: 1, opacity: 0, transform: 'translate(-50%, -70%) scale(1)' },
];

/**
 * DOM layer: menus, cards and the HUD over the canvas. Only transform/opacity animate,
 * and the HUD updates text in place, so nothing here triggers layout during play.
 */
export class Ui {
  private readonly hud: HTMLElement;
  private readonly hudGlide: Glide;
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
  private flash: Animation | null = null;
  /** DOM effects switched off in the debug menu */
  private effects: FxChoice = {};
  /** stops the guide's demos once its card is gone */
  private stopHelp: (() => void) | null = null;

  public constructor(
    root: HTMLElement,
    /** `item`: the row of a debug menu the action came from (a sound, an effect) */
    private readonly onAction: (action: Action, item?: string) => void,
  ) {
    this.hud = root.querySelector('#hud')!;
    this.hudGlide = new Glide(this.hud);
    this.overlay = root.querySelector('#overlay')!;
    this.curtainEl = root.querySelector('#curtain')!;
    this.praiseEl = root.querySelector('#praise')!;
    root.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (target) this.onAction(target.dataset.action as Action, target.closest<HTMLElement>('[data-item]')?.dataset.item);
    });
  }

  /** The effects menu's choice, for the DOM effects: the HUD pop and the praise. */
  public setEffects(choice: FxChoice): void {
    this.effects = choice;
  }

  private on(fx: Fx): boolean {
    return this.effects[fx] !== false;
  }

  /** The viewport changed: the HUD drifts to its new spot. */
  public relayout(): void {
    this.hudGlide.follow();
  }

  public setTheme(level: number): void {
    document.documentElement.dataset.theme = String(Math.floor((level - 1) / 20) % THEMES);
  }

  // ---------- screens ----------

  public showTitle(level: number, resumable: boolean, update: boolean): void {
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
        ${update ? `<button class="btn ghost update-link" data-action="${Action.Update}">✨ ${S.update.button}</button>` : ''}
        <button class="btn ghost" data-action="${Action.Help}">${S.help.button}</button>
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

  /** What the new version brings, release by release since the one running here. */
  public showUpdate(current: string, update: Update): void {
    const releases = update.releases
      .map((r) => `<div class="release"><h3>${S.update.release(r.version, r.date)}</h3><ul>${r.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`)
      .join('');
    this.show(
      `<div class="card update">
        <h2>${S.update.title}</h2>
        <p>${S.update.versions(current, update.version)}</p>
        <div class="releases">${releases}</div>
        <button class="btn primary big" data-action="${Action.ApplyUpdate}">${S.update.apply}</button>
        <button class="btn ghost" data-action="${Action.UpdateLater}">${S.update.later}</button>
      </div>`,
    );
  }

  public showPause(): void {
    this.show(
      `<div class="card">
        <h2>${S.paused}</h2>
        <button class="btn primary big" data-action="${Action.Resume}">${S.resume}</button>
        <button class="btn" data-action="${Action.Restart}">${S.restart}</button>
        <button class="btn" data-action="${Action.Help}">${S.help.button}</button>
        <button class="btn" data-action="${Action.Settings}">${S.settings}</button>
        <button class="btn ghost" data-action="${Action.Menu}">${S.menu}</button>
      </div>`,
    );
  }

  /** The guide: every rule played out on little boards, from the pause menu or the title. */
  public showHelp(): void {
    this.show(
      `<div class="card help">
        <h2>${S.help.button}</h2>
        ${helpHtml((frame) => this.icon(frame))}
        <button class="btn primary big" data-action="${Action.Back}">${S.gotIt}</button>
      </div>`,
    );
    this.stopHelp = playHelp(this.overlay.querySelector('.card')!, (frame) => this.icon(frame));
  }

  public showWin(stars: number, score: number): void {
    // Every slot shows a dashed outline at once; earned stars fly in over it.
    const starEls = [1, 2, 3]
      .map((k) => `<span class="star-slot${k <= stars ? ' won' : ''}" style="--i:${k}">${starSvg('outline')}${k <= stars ? starSvg('earned') : ''}</span>`)
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
        ${toggle(Action.ToggleFullscreen, S.fullscreen, settings.fullscreen)}
        <div class="toggle stepper">
          <span>${S.boardSize}</span>
          <button data-action="${Action.BoardSmaller}" aria-label="${S.smaller}" ${settings.boardSize <= BoardSize.Min ? 'disabled' : ''}>−</button>
          <i>${S.percent(settings.boardSize)}</i>
          <button data-action="${Action.BoardBigger}" aria-label="${S.bigger}" ${settings.boardSize >= BoardSize.Max ? 'disabled' : ''}>+</button>
        </div>
        <div class="toggle stepper">
          <span>${S.difficulty}</span>
          <button data-action="${Action.Easier}" aria-label="${S.easier}" ${settings.difficulty === DIFFICULTIES[0] ? 'disabled' : ''}>−</button>
          <i>${S.difficulties[settings.difficulty]}</i>
          <button data-action="${Action.Harder}" aria-label="${S.harder}" ${settings.difficulty === DIFFICULTIES.at(-1) ? 'disabled' : ''}>+</button>
        </div>
        <button class="btn" data-action="${Action.Sounds}">${S.sounds}</button>
        <button class="btn" data-action="${Action.Effects}">${S.effects}</button>
        <button class="btn danger" data-action="${Action.Reset}">${S.reset}</button>
        <button class="btn primary" data-action="${Action.Back}">${S.back}</button>
      </div>`,
    );
  }

  /** Debug menu: every sound the game plays, each with its variants to step through and hear. */
  public showSounds(choice: SoundChoice): void {
    const rows = Object.values(Sfx)
      .map(
        (id) => `<div class="sound-row" data-item="${id}">
          <span>${S.soundNames[id]}</span>
          <div class="toggle stepper">
            <button data-action="${Action.SoundPrev}" aria-label="${S.smaller}">‹</button>
            <button class="variant" data-action="${Action.SoundPlay}">${this.variantHtml(id, choice)}</button>
            <button data-action="${Action.SoundNext}" aria-label="${S.bigger}">›</button>
          </div>
        </div>`,
      )
      .join('');
    this.show(
      `<div class="card sounds">
        <h2>${S.sounds}</h2>
        <p class="hint">${S.soundsHint}</p>
        ${rows}
        <button class="btn primary" data-action="${Action.Back}">${S.back}</button>
      </div>`,
    );
  }

  /** In place: redrawing the card would replay its entrance and lose the scroll. */
  public updateSound(id: Sfx, choice: SoundChoice): void {
    const el = this.overlay.querySelector(`[data-item="${id}"] .variant`);
    if (el) el.innerHTML = this.variantHtml(id, choice);
  }

  /** Debug menu: every effect, each switched on and off on its own. */
  public showEffects(choice: FxChoice): void {
    const rows = Object.values(Fx)
      .map((fx) => `<button class="toggle ${choice[fx] === false ? '' : 'on'}" data-action="${Action.ToggleEffect}" data-item="${fx}">${this.effectHtml(fx, choice)}</button>`)
      .join('');
    this.show(
      `<div class="card sounds">
        <h2>${S.effects}</h2>
        <p class="hint">${S.effectsHint}</p>
        ${rows}
        <button class="btn primary" data-action="${Action.Back}">${S.back}</button>
      </div>`,
    );
  }

  /** In place, like a sound row. */
  public updateEffect(fx: Fx, choice: FxChoice): void {
    const el = this.overlay.querySelector(`[data-item="${fx}"]`);
    if (el) el.innerHTML = this.effectHtml(fx, choice);
    el?.classList.toggle('on', choice[fx] !== false);
  }

  private effectHtml(fx: Fx, choice: FxChoice): string {
    return `<span>${S.effectNames[fx]}</span><i>${choice[fx] === false ? S.off : S.on}</i>`;
  }

  private variantHtml(id: Sfx, choice: SoundChoice): string {
    const variants = VARIANTS[id];
    const variant = chosen(choice, id);
    // recordings are named "03-glass-heavy": the number shows as the position instead
    const name = S.variantNames[variant] ?? variant.replace(/^\d+-/, '').replaceAll('-', ' ');
    return `▶ ${name} <small>${variants.indexOf(variant) + 1}/${variants.length}</small>`;
  }

  /** First tap arms the reset, the second confirms. Returns whether it is confirmed. */
  public confirmReset(): boolean {
    if (this.resetArmed) return true;
    this.resetArmed = true;
    const button = this.overlay.querySelector<HTMLElement>(`[data-action="${Action.Reset}"]`);
    if (button) button.textContent = S.resetConfirm;
    return false;
  }

  public hideOverlay(): void {
    this.endHelp();
    this.overlay.className = '';
    this.overlay.innerHTML = '';
  }

  private show(html: string, variant = ''): void {
    this.endHelp();
    this.overlay.innerHTML = html;
    this.overlay.className = `visible ${variant}`;
  }

  private endHelp(): void {
    this.stopHelp?.();
    this.stopHelp = null;
  }

  // ---------- HUD ----------

  public showHud(def: LevelDef): void {
    this.hud.classList.remove('off');
    this.hud.innerHTML = `
      <div class="hud-moves"><span class="label">${S.moves}</span><b class="value"></b></div>
      <div class="hud-goals" data-action="${Action.Goals}" role="button" aria-label="${S.goals}">${def.objectives.map((o) => this.goalHtml(o, o.target)).join('')}</div>
      <button class="btn icon" data-action="${Action.Pause}" aria-label="${S.paused}">${PAUSE_ICON}</button>
      <div class="hud-score">
        <div class="bar"><div class="track"><div class="fill"></div>${this.markHtml(0, '')}${this.markHtml(
          (def.stars[1] / def.stars[2]) * 100,
          def.stars[1].toLocaleString('ru-RU'),
        )}${this.markHtml(100, def.stars[2].toLocaleString('ru-RU'))}</div></div>
        <div class="score"><b class="value">0</b></div>
      </div>`;
    const pops = (): boolean => this.on(Fx.HudPop);
    this.hudMoves = new Counter(this.hud.querySelector('.hud-moves .value')!, pops);
    this.hudScore = new Counter(this.hud.querySelector('.hud-score .value')!, pops);
    this.hudFill = this.hud.querySelector('.fill');
    this.hudStars = [...this.hud.querySelectorAll<HTMLElement>('.mark')];
    this.hudGoals = [...this.hud.querySelectorAll<HTMLElement>('.hud-goals .goal')];
    this.hudGoalCounters = this.hudGoals.map((el) => new Counter(el.querySelector('b')!, pops));
  }

  public hideHud(): void {
    this.hud.classList.add('off');
    perfFlag('alarm', false);
  }

  public updateHud(state: GameState): void {
    const def = state.level;
    this.hudMoves?.set(state.movesLeft);
    this.alarmMoves(state.movesLeft, state.status === 'won');
    this.hud.querySelector('.hud-goals')?.classList.toggle('won', state.status === 'won');
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

  /**
   * From five moves left the moves orb turns faintly red and pulses slowly; each move closer to zero it reddens
   * and pulses faster, up to an alarm on the last one, so a player racing through the level still notices.
   * Once the level is won it calms down: no pulse, and the same scale in green as the finale spends the moves.
   */
  private alarmMoves(left: number, won: boolean): void {
    const el = this.hud.querySelector<HTMLElement>('.hud-moves');
    if (!el) return;
    const near = left <= LOW_MOVES;
    el.classList.toggle('low', near && !won);
    perfFlag('alarm', near && !won);
    el.classList.toggle('won', near && won);
    if (!near) return;
    const u = (LOW_MOVES + 1 - Math.max(1, left)) / LOW_MOVES;
    el.style.setProperty('--u', u.toFixed(2));
    el.style.setProperty('--pulse', `${Math.round(ALARM_SLOW_MS + (ALARM_FAST_MS - ALARM_SLOW_MS) * (u - 1 / LOW_MOVES) / (1 - 1 / LOW_MOVES))}ms`);
  }

  // ---------- feedback ----------

  /** `step` 0 is the first praised step of a cascade; later steps draw more excited words. */
  public praise(step: number): void {
    if (this.on(Fx.Praise)) this.flashText(this.praiseWords.next(step));
  }

  /** Restarted without a forced reflow: praise comes every step of a cascade. */
  public flashText(text: string): void {
    this.praiseEl.textContent = text;
    // Long phrases shrink to fit the screen width.
    this.praiseEl.style.setProperty('--chars', String(text.length));
    this.flash?.cancel();
    this.flash = this.praiseEl.animate(FLASH_FRAMES, FLASH_MS);
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

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
