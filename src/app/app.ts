import { type SaveData, defaultSave, loadSave, persist } from '@/app/save';
import { AudioBus } from '@/audio/audio';
import { Sfx } from '@/audio/synth';
import { addExtraMoves, canSwap, createGame, EXTRA_MOVES, makeMove, runFinale, starsFor } from '@/core/game';
import { BlastKind, type GameEvent, type GameState, type LevelDef, type Pos } from '@/core/types';
import { recordAttempt, targetWinRate } from '@/difficulty/director';
import { LevelDrafts } from '@/gen/drafts';
import { finalizeLevel } from '@/gen/generator';
import { planLevel } from '@/gen/plan';
import { exitApp, Haptic, haptic, onBackButton, onHidden, onVisible, setHapticsEnabled } from '@/platform/platform';
import { Action, Ui } from '@/ui/ui';
import { S } from '@/ui/strings';
import { BoardView, type Layer } from '@/view/boardView';
import type { Scene } from '@/view/scene';

const Mode = {
  Title: 'title',
  Card: 'card',
  Play: 'play',
  Pause: 'pause',
  Settings: 'settings',
  Finale: 'finale',
  Won: 'won',
  Lost: 'lost',
} as const;
type Mode = (typeof Mode)[keyof typeof Mode];

const FINALE_FAST_FORWARD = 4;

const LAYER_SFX: Record<Layer, Sfx> = { ice: Sfx.Ice, crate: Sfx.Crate, chain: Sfx.Chain };

/** Game flow: screens, moves, results, persistence. Owns no rules (core) and draws nothing itself (view, ui). */
export class GameApp {
  private readonly ui: Ui;
  private readonly view: BoardView;
  private readonly audio = new AudioBus();
  private readonly drafts = new LevelDrafts();
  private save: SaveData = defaultSave();
  private game: GameState | null = null;
  private mode: Mode = Mode.Title;
  private settingsReturn: Mode = Mode.Title;
  /** a move is being played back */
  private busy = false;
  private actionRunning = false;
  /** `?debug` in the URL shows level and director numbers for tuning */
  private readonly debugEl = new URLSearchParams(location.search).has('debug') ? createDebugEl() : null;

  public constructor(
    root: HTMLElement,
    private readonly scene: Scene,
    canvas: HTMLCanvasElement,
  ) {
    this.ui = new Ui(root, (action) => void this.onAction(action));
    this.view = new BoardView(scene, canvas, {
      onSwap: (a, b) => void this.onSwap(a, b),
      onLayerHit: (layer) => this.audio.play(LAYER_SFX[layer]),
    });

    const stage = root.querySelector<HTMLElement>('#stage')!;
    new ResizeObserver(() => this.resize(stage)).observe(stage);
    this.resize(stage);

    // Mobile browsers allow audio only after a gesture; every tap re-checks cheaply.
    document.addEventListener('pointerdown', () => this.audio.unlock(), { capture: true });
    onHidden(() => {
      if (this.mode === Mode.Play) this.pause();
      this.audio.suspend();
      this.persist();
    });
    onVisible(() => this.audio.resume());
    onBackButton(() => void this.onBack());
  }

  public async init(): Promise<void> {
    this.save = await loadSave();
    this.applySettings();
    this.ui.setTheme(this.save.level);
    this.showTitle();
    void this.drafts.get({ number: this.save.level, assist: this.save.current?.fails ?? 0 });
  }

  // ---------- flow ----------

  private showTitle(): void {
    this.mode = Mode.Title;
    this.view.inputEnabled = false;
    this.view.clear();
    this.ui.hideHud();
    this.ui.showTitle(this.save.level, this.save.current?.game != null);
  }

  private async openLevel(): Promise<void> {
    const n = this.save.level;
    let current = this.save.current;
    if (!current || current.def.number !== n) {
      current = { def: await this.makeLevel(n, 0), fails: 0, game: null };
      this.save.current = current;
      this.persist();
    }
    this.ui.setTheme(n);
    this.mode = Mode.Card;
    this.ui.showLevelCard(current.def, current.fails, current.game !== null);
    this.showDebug();
    void this.drafts.get({ number: n + 1, assist: 0 });
  }

  private async makeLevel(n: number, fails: number): Promise<LevelDef> {
    const draft = await this.drafts.get({ number: n, assist: fails });
    return finalizeLevel(draft, targetWinRate(this.save.director, planLevel(n).baseWinRate, fails));
  }

  private async startLevel(): Promise<void> {
    const current = this.save.current!;
    const game = current.game ?? createGame(current.def);
    current.game = game;
    this.game = game;
    this.busy = true;
    this.persist();
    await this.ui.curtain(() => {
      this.ui.hideOverlay();
      this.ui.showHud(game.level);
      this.ui.updateHud(game);
      this.view.setBoard(game.board);
    });
    this.mode = Mode.Play;
    await this.view.entrance();
    // A save made right after the last move resumes into its result.
    if (game.status === 'won') await this.finishWin(game);
    else if (game.status === 'lost') this.showLose(game);
    else {
      this.busy = false;
      this.enableInput();
    }
  }

  private async onSwap(a: Pos, b: Pos): Promise<void> {
    const game = this.game;
    if (this.mode !== Mode.Play || this.busy || !game || !canSwap(game, a, b)) return;
    this.busy = true;
    this.view.inputEnabled = false;
    this.view.cancelHint();

    const result = makeMove(game, a, b);
    await this.present(result.events);
    this.ui.updateHud(game);
    if (result.valid) this.persist();

    if (game.status === 'won') await this.finishWin(game);
    else if (game.status === 'lost') this.showLose(game);
    else {
      this.busy = false;
      this.enableInput();
    }
  }

  private async finishWin(game: GameState): Promise<void> {
    this.mode = Mode.Finale;
    const movesAtWin = game.movesLeft;
    haptic(Haptic.Success);
    this.ui.flashText(S.win);
    if (game.movesLeft > 0) {
      this.ui.showSkipLayer();
      await this.present(runFinale(game));
      this.scene.tweens.speed = 1;
      this.ui.hideOverlay();
      this.ui.updateHud(game);
    }

    const def = game.level;
    const stars = starsFor(game);
    recordAttempt(this.save.director, {
      level: def.number,
      won: true,
      predicted: def.targetWinRate,
      movesLeftRatio: movesAtWin / def.moves,
      usedExtraMoves: game.extraMovesUsed,
    });
    this.save.stars[def.number - 1] = Math.max(this.save.stars[def.number - 1] ?? 0, stars);
    this.save.level = def.number + 1;
    this.save.current = null;
    this.game = null;
    this.persist();

    await this.view.vanish();
    this.busy = false;
    this.mode = Mode.Won;
    this.ui.hideHud();
    this.ui.showWin(stars, game.score);
    this.audio.play(Sfx.Win);
    for (let k = 0; k < stars; k++) setTimeout(() => this.audio.play(Sfx.Star, 1 + k * 0.12), 450 + k * 280);
  }

  private showLose(game: GameState): void {
    this.mode = Mode.Lost;
    this.busy = false;
    this.audio.play(Sfx.Lose);
    this.ui.showLose(game, !game.extraMovesUsed, EXTRA_MOVES);
  }

  /** Ends the attempt as a failure: the director learns, the next attempt gets recalibrated. */
  private async failLevel(): Promise<void> {
    const current = this.save.current;
    if (!current) return;
    recordAttempt(this.save.director, {
      level: current.def.number,
      won: false,
      predicted: current.def.targetWinRate,
      movesLeftRatio: 0,
      usedExtraMoves: current.game?.extraMovesUsed ?? false,
    });
    current.fails++;
    current.game = null;
    current.def = await this.makeLevel(current.def.number, current.fails);
    this.game = null;
    this.persist();
  }

  private pause(): void {
    this.mode = Mode.Pause;
    this.view.inputEnabled = false;
    this.view.cancelHint();
    this.ui.showPause();
  }

  private resume(): void {
    this.mode = Mode.Play;
    this.ui.hideOverlay();
    this.enableInput();
  }

  private enableInput(): void {
    const on = this.mode === Mode.Play && !this.busy;
    this.view.inputEnabled = on;
    if (on) this.view.armHint();
  }

  // ---------- actions ----------

  /** Screen actions run one at a time; a double tap must not start a level twice. */
  private async onAction(action: Action): Promise<void> {
    if (action === Action.Skip) {
      this.scene.tweens.speed = FINALE_FAST_FORWARD;
      return;
    }
    if (this.actionRunning) return;
    this.actionRunning = true;
    this.audio.play(Sfx.Button);
    try {
      await this.runAction(action);
    } finally {
      this.actionRunning = false;
    }
  }

  private async runAction(action: Action): Promise<void> {
    switch (action) {
      case Action.Play:
      case Action.Next:
        await this.ui.curtain(() => this.openLevel());
        break;
      case Action.Start:
        await this.startLevel();
        break;
      case Action.Pause:
        if (this.mode === Mode.Play) this.pause();
        break;
      case Action.Resume:
        this.resume();
        break;
      case Action.Restart:
        if ((this.game?.movesMade ?? 0) > 0) await this.failLevel();
        else if (this.save.current) this.save.current.game = null;
        await this.ui.curtain(() => this.openLevel());
        break;
      case Action.Retry:
        await this.failLevel();
        await this.ui.curtain(() => this.openLevel());
        break;
      case Action.ExtraMoves:
        if (this.game && this.mode === Mode.Lost) {
          addExtraMoves(this.game);
          this.persist();
          this.ui.updateHud(this.game);
          this.ui.hideOverlay();
          this.mode = Mode.Play;
          this.enableInput();
        }
        break;
      case Action.Menu:
        if (this.mode === Mode.Lost) await this.failLevel();
        await this.ui.curtain(() => this.showTitle());
        break;
      case Action.Settings:
        this.settingsReturn = this.mode;
        this.mode = Mode.Settings;
        this.ui.showSettings(this.save.settings);
        break;
      case Action.Back:
        this.mode = this.settingsReturn;
        if (this.mode === Mode.Pause) this.ui.showPause();
        else this.showTitle();
        break;
      case Action.ToggleSound:
      case Action.ToggleHaptics:
      case Action.ToggleMotion:
        this.toggleSetting(action);
        break;
      case Action.Reset:
        if (this.ui.confirmReset()) {
          this.save = defaultSave();
          this.game = null;
          this.applySettings();
          this.persist();
          this.ui.setTheme(1);
          this.showTitle();
        }
        break;
    }
  }

  private toggleSetting(action: Action): void {
    const s = this.save.settings;
    if (action === Action.ToggleSound) s.sound = !s.sound;
    if (action === Action.ToggleHaptics) s.haptics = !s.haptics;
    if (action === Action.ToggleMotion) s.reducedMotion = !s.reducedMotion;
    this.applySettings();
    this.persist();
    this.ui.showSettings(s);
  }

  private async onBack(): Promise<void> {
    switch (this.mode) {
      case Mode.Play:
        this.pause();
        break;
      case Mode.Pause:
        this.resume();
        break;
      case Mode.Settings:
        await this.onAction(Action.Back);
        break;
      case Mode.Card:
      case Mode.Won:
      case Mode.Lost:
        await this.onAction(Action.Menu);
        break;
      case Mode.Title:
        exitApp();
        break;
    }
  }

  // ---------- presentation ----------

  /** Plays events one by one with sound and haptics. */
  private async present(events: GameEvent[]): Promise<void> {
    for (const ev of events) {
      this.feedback(ev);
      await this.view.play([ev]);
    }
  }

  private feedback(ev: GameEvent): void {
    switch (ev.type) {
      case 'swap':
        this.audio.play(ev.valid ? Sfx.Swap : Sfx.SwapFail);
        if (!ev.valid) haptic(Haptic.Light);
        break;
      case 'clear': {
        const pitch = 2 ** (Math.min(ev.cascade, 8) / 6);
        if (ev.removed.length > 0) this.audio.play(Sfx.Match, pitch);
        if (ev.created.length > 0) this.audio.play(Sfx.Create);
        const kinds = new Set(ev.blasts.map((b) => b.kind));
        if (kinds.has(BlastKind.Row) || kinds.has(BlastKind.Col)) this.audio.play(Sfx.Line);
        if (kinds.has(BlastKind.Spark)) this.audio.play(Sfx.Spark);
        if (kinds.has(BlastKind.Bomb)) this.audio.play(Sfx.Bomb);
        if (kinds.has(BlastKind.Prism)) this.audio.play(Sfx.Prism);
        if (kinds.has(BlastKind.Bomb) || kinds.has(BlastKind.Prism)) haptic(Haptic.Heavy);
        else if (kinds.size > 0) haptic(Haptic.Medium);
        else haptic(Haptic.Light);
        if (ev.cascade >= 2) this.ui.praise(ev.cascade - 2);
        break;
      }
      case 'transform':
        this.audio.play(Sfx.Create);
        break;
      case 'shuffle':
        this.audio.play(Sfx.Shuffle);
        this.ui.flashText(S.shuffle);
        break;
      case 'fall':
        break;
    }
  }

  // ---------- misc ----------

  private applySettings(): void {
    const s = this.save.settings;
    this.audio.enabled = s.sound;
    setHapticsEnabled(s.haptics);
    this.view.setReducedMotion(s.reducedMotion);
    document.documentElement.classList.toggle('reduced-motion', s.reducedMotion);
  }

  private resize(stage: HTMLElement): void {
    const { width, height } = stage.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    this.scene.resize(width, height);
    this.view.layout(width, height);
  }

  private persist(): void {
    persist(this.save);
  }

  private showDebug(): void {
    const current = this.save.current;
    if (!this.debugEl || !current) return;
    const d = current.def;
    this.debugEl.textContent = [
      `L${d.number} ${d.kind}${d.intro ? ` +${d.intro}` : ''}`,
      `p=${d.targetWinRate.toFixed(2)} colors=${d.colors} moves=${d.moves}`,
      `fails=${current.fails} skill=${this.save.director.skill.toFixed(2)}`,
      `stars=${d.stars.join('/')}`,
    ].join('\n');
  }
}

function createDebugEl(): HTMLElement {
  const el = document.createElement('pre');
  el.style.cssText =
    'position:fixed;left:4px;bottom:4px;margin:0;padding:4px 6px;font:11px monospace;color:#0f0;background:rgba(0,0,0,.6);pointer-events:none;z-index:9';
  document.body.appendChild(el);
  return el;
}
