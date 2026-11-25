import { type Charges, EARN, sparkCount, spend, stock, winGain, withGain } from '@/app/boosters';
import { type Attempt, BoardSize, type CurrentLevel, type SaveData, defaultSave, flushSaves, loadSave, persist, randomSeed } from '@/app/save';
import { type Update, UpdateWatch } from '@/app/updates';
import { AudioBus } from '@/audio/audio';
import { chosen, VARIANTS } from '@/audio/sounds';
import { Sfx } from '@/audio/synth';
import { goalsOf, type MoveOptions, moveOptions } from '@/bot/features';
import { indexOf } from '@/core/board';
import { addExtraMoves, advance, canAct, canRescue, canStrike, createGame, EXTRA_MOVES, makeMove, startFinale, starsFor, strike } from '@/core/game';
import { BlastKind, Booster, type GameEvent, type GameState, LevelKind, type Pos } from '@/core/types';
import { LevelDrafts } from '@/gen/drafts';
import { type DraftRequest, finalizeLevel, GEN_VERSION, isWinnable, twinMoves } from '@/gen/generator';
import { planLevel } from '@/gen/plan';
import { DIFFICULTIES, targetWinRate } from '@/player/difficulty';
import { paceFactor, updatePace } from '@/player/pace';
import { observeMove, observeOutcome, twinOf } from '@/player/model';
import { updateThreeStars } from '@/player/stars';
import { AttemptEnd, type AttemptRecord, newRecord, recordMiss, recordMove, recordStep, recordStrike, type SwapInput, trackAttempt } from '@/telemetry/attempt';
import { flushPerf, perfContext, timed } from '@/telemetry/perf';
import { exitApp, Haptic, haptic, isNative, onBackButton, onHidden, onVisible, setFullscreen, setHapticsEnabled } from '@/platform/platform';
import { track } from '@/telemetry/telemetry';
import { BOOSTER_FOOTER, BoosterBar } from '@/ui/boosterBar';
import { Sparks } from '@/ui/sparks';
import { Action, Ui } from '@/ui/ui';
import { S } from '@/ui/strings';
import { BoardView, type Layer } from '@/view/boardView';
import { Fx } from '@/view/fx/switches';
import { Timing } from '@/view/fx/timeline';
import type { Scene } from '@/view/scene';

const Mode = {
  Title: 'title',
  Play: 'play',
  Pause: 'pause',
  Settings: 'settings',
  Sounds: 'sounds',
  Effects: 'effects',
  Finale: 'finale',
  Won: 'won',
  Lost: 'lost',
  /** the update notice is open */
  Update: 'update',
  Help: 'help',
} as const;
type Mode = (typeof Mode)[keyof typeof Mode];

/**
 * Every step of a chain plays this much faster than the one before, up to CHAIN_MAX_SPEED: long chains,
 * lit specials going off one by one and the finale rush, but stay readable. A board at rest plays at normal speed.
 */
const CHAIN_RAMP = 1.12;
/** The ramp levels off here (around step 11 at 1.12×). */
const CHAIN_MAX_SPEED = 3;
const chainSpeed = (cascade: number): number =>
  Math.min(CHAIN_MAX_SPEED, CHAIN_RAMP ** Math.max(0, cascade - 1));
/** Off until there is something to pay for extra moves with (ads, coins): out of moves means a plain loss. */
const OFFER_EXTRA_MOVES = false;
/** An outcome eased by boosters teaches the player's strength this much: the twin plays without them. */
const BOOSTED_WEIGHT = 0.5;

const LAYER_SFX: Record<Layer, Sfx> = { ice: Sfx.Ice, crate: Sfx.Crate, chain: Sfx.Chain };

/** A share of a win's gain: the moves left that feed the star, the stars that feed the meteor. */
type WinShare = { moves: number; stars: number };

/**
 * A won level's gain flies into the bar: `moves` left at the win (the stars follow the score as the finale adds to it),
 * the share that took off as sparks, the share that landed (what the bar shows), and the sparks still in the air.
 */
type WinGain = { moves: number; sent: WinShare; landed: WinShare; landing: Promise<void> };

/** Game flow: screens, moves, results, persistence. Owns no rules (core) and draws nothing itself (view, ui). */
export class GameApp {
  private readonly ui: Ui;
  private readonly boosters: BoosterBar;
  private readonly sparks: Sparks;
  private readonly view: BoardView;
  private readonly audio = new AudioBus();
  private readonly drafts = new LevelDrafts();
  private save: SaveData = defaultSave();
  private game: GameState | null = null;
  private mode: Mode = Mode.Title;
  /** where a menu opened from the pause or the title (settings, the guide) goes back to */
  private menuReturn: Mode = Mode.Title;
  /** game whose board steps are being played back; the player may keep swapping meanwhile */
  private running: GameState | null = null;
  /** swap animations in flight; the next board step waits for them */
  private readonly swaps = new Set<Promise<void>>();
  private actionRunning = false;
  /** where the stage sat at the last resize, so the board knows how far its canvas moved */
  private stageAt = { x: 0, y: 0 };
  /** the calm board's moves, valued once when it came to rest: the next swap is read against them */
  private rest: MoveOptions | null = null;
  /** when the player could last act: thinking time of the next swap counts from here */
  private thinkFrom = 0;
  /** where the player's last move landed in this attempt, or -1: where they are looking */
  private lastTo = -1;
  /** the booster being aimed, or null */
  private aiming: Booster | null = null;
  /** the gain of the level being won, flying into the bar; null outside a win */
  private win: WinGain | null = null;
  /** a newer build is live, once noticed */
  private update: Update | null = null;
  /** where the update notice returns to */
  private updateReturn: Mode = Mode.Title;
  /** `?debug` in the URL shows level and difficulty numbers for tuning, and fills the boosters at each level */
  private readonly debugEl = new URLSearchParams(location.search).has('debug') ? createDebugEl() : null;

  public constructor(
    root: HTMLElement,
    private readonly scene: Scene,
    canvas: HTMLCanvasElement,
  ) {
    this.ui = new Ui(root, (action, item) => void this.onAction(action, item));
    this.boosters = new BoosterBar(root.querySelector<HTMLElement>('#boosters')!, () => this.audio.play(Sfx.Charged));
    this.sparks = new Sparks(root.querySelector<HTMLElement>('#sparks')!, () => this.save.settings.effects[Fx.BoosterSparks] !== false);
    this.view = new BoardView(scene, canvas, {
      onSwap: (a, b, input) => void this.onSwap(a, b, input),
      onStrike: (at) => this.onStrike(at),
      onLayerHit: (layer) => this.audio.play(LAYER_SFX[layer]),
      onLayout: (rect) => this.boosters.place(rect),
    });
    this.view.setFooter(BOOSTER_FOOTER);

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
    if (!this.save.current) void this.drafts.get(this.draftRequest(this.save.level));
    // The web build updates by reloading; a native shell ships its files and updates through its store.
    if (!isNative) new UpdateWatch(__APP_VERSION__, (update) => this.onUpdate(update)).start();
  }

  // ---------- flow ----------

  private showTitle(): void {
    flushPerf('title');
    perfContext({ level: null, board: null });
    this.mode = Mode.Title;
    this.game = null;
    this.aiming = null;
    this.view.inputEnabled = false;
    this.view.clear();
    this.ui.hideHud();
    this.boosters.hide();
    this.ui.showTitle(this.save.level, this.save.current?.attempt != null, this.update !== null);
  }

  /** The level to play now; a new one is built when the saved one is already won. The next one is built meanwhile. */
  private async currentLevel(): Promise<CurrentLevel> {
    const n = this.save.level;
    let current = this.save.current;
    // A level built by an older generator is rebuilt, unless an attempt on it is under way that can still be won.
    const stale = current && current.draft.version !== GEN_VERSION && (!current.attempt || !isWinnable(current.draft));
    if (!current || current.draft.request.number !== n || stale) {
      const fails = current?.draft.request.number === n ? current.fails : 0;
      current = { draft: await this.drafts.get(this.draftRequest(n)), fails, attempt: null };
      this.save.current = current;
    }
    void this.drafts.get(this.draftRequest(n + 1));
    return current;
  }

  /** A level of this player, for their twin as it reads now. */
  private draftRequest(n: number): DraftRequest {
    const { player } = this.save;
    return { seed: this.save.seed, number: n, style: twinOf(player.model), pace: paceFactor(player.pace) };
  }

  /**
   * A new attempt on a fresh random board, finalized for the target of this moment: the difficulty setting
   * and failures so far, and the player's own 3-star rate. Difficulty is calibrated over many boards, not this one.
   */
  private startAttempt(current: CurrentLevel): Attempt {
    const n = current.draft.request.number;
    const { settings, player } = this.save;
    const target = targetWinRate(planLevel(n).baseWinRate, settings.difficulty, current.fails);
    const def = finalizeLevel(current.draft, target, player.threeStars);
    const seed = randomSeed();
    current.attempt = { game: createGame(def, seed), record: newRecord(seed), target, threeStars: player.threeStars };
    return current.attempt;
  }

  /** Straight into play: no level card in between, the HUD shows the goals and explains them on tap. */
  private async playLevel(): Promise<void> {
    flushPerf('level');
    // Measured behind the curtain: draft wait, calibration, board build.
    await this.ui.curtain(() => timed('level', async () => {
      const current = await this.currentLevel();
      const game = (current.attempt ?? this.startAttempt(current)).game;
      this.game = game;
      this.rest = null;
      this.lastTo = -1;
      this.aiming = null;
      this.win = null;
      if (this.debugEl) for (const b of Object.values(Booster)) this.save.boosters[b] = EARN[b].unit * EARN[b].max;
      perfContext({ level: game.level.number, board: `${game.board.cols}x${game.board.rows}` });
      this.view.inputEnabled = false;
      this.persist();
      this.ui.setTheme(game.level.number);
      this.ui.hideOverlay();
      this.ui.showHud(game.level);
      this.ui.updateHud(game);
      this.boosters.show(this.save.boosters);
      this.view.setBoard(game.board);
      this.showDebug();
    }));
    const game = this.game;
    const current = this.save.current;
    if (!game || !current) return;
    this.mode = Mode.Play;
    await this.view.entrance();
    if (this.game !== game) return;
    this.announce(game, current.fails);
    // A save made mid-cascade or right after the last move resumes from there.
    void this.run(game);
  }

  /** A newer build is live: its button shows under the board, and on the title screen. */
  private onUpdate(update: Update): void {
    this.update = update;
    track('update', { event: 'found', to: update.version });
    this.boosters.showUpdate();
    if (this.mode === Mode.Title) this.showTitle();
  }

  /** The notice: what the new version brings. From play it pauses the level; "later" goes back where it was. */
  private openUpdate(): void {
    if (!this.update || (this.mode !== Mode.Play && this.mode !== Mode.Title)) return;
    this.updateReturn = this.mode;
    if (this.mode === Mode.Play) this.pause();
    this.mode = Mode.Update;
    this.ui.showUpdate(__APP_VERSION__, this.update);
  }

  private closeUpdate(): void {
    if (this.mode !== Mode.Update) return;
    if (this.updateReturn === Mode.Play) this.resume();
    else this.showTitle();
  }

  /** Reloads into the new build once the save is written: a level in progress resumes where it was. */
  private async applyUpdate(): Promise<void> {
    track('update', { event: 'applied', to: this.update?.version ?? null });
    flushPerf('update');
    this.persist();
    await flushSaves();
    location.reload();
  }

  /** A new mechanic explains itself once; otherwise a short flash names the level. */
  private announce(game: GameState, fails: number): void {
    const def = game.level;
    if (def.intro !== null && game.movesMade === 0) {
      this.showGoals();
      return;
    }
    this.ui.flashText(fails >= 3 ? S.assist : def.kind === LevelKind.Hard ? S.hard : S.level(def.number));
  }

  private showGoals(): void {
    if (!this.game) return;
    this.mode = Mode.Pause;
    this.view.inputEnabled = false;
    this.view.cancelHint();
    this.ui.showGoals(this.game);
  }

  /** Swaps are accepted while a cascade plays on, as long as both cells are calm (the view checks that). */
  private onSwap(a: Pos, b: Pos, input: SwapInput): void {
    const game = this.game;
    if (this.mode !== Mode.Play || !game) return;
    const hint = this.view.hintShown;
    const swap = makeMove(game, a, b);
    if (!swap) return;
    if (swap.valid) {
      // Only a real move ends the hint; a rejected swap leaves it pulsing.
      this.view.cancelHint();
      this.learn(game, a, b, hint, input);
    }
    const anim = this.view.play([swap], (ev) => this.feedback(ev));
    this.swaps.add(anim);
    void anim.then(() => this.swaps.delete(anim));
    if (!swap.valid) {
      const record = this.recordOf(game);
      // An invalid swap leaves the board as it was: the cells are what the player tried.
      if (record) recordMiss(record, game.board, a, b);
      // A miss shows a possible move as soon as the pieces are back; mid-cascade the rest arms the usual wait.
      void anim.then(() => {
        if (this.game === game && this.running !== game && this.mode === Mode.Play) this.view.armHint(0);
      });
      return;
    }
    this.ui.updateHud(game);
    this.updateInput();
    void this.run(game);
  }

  /** The aimed booster was let go over a cell: it strikes in the next step, and is spent. */
  private onStrike(at: Pos): void {
    const game = this.game;
    const booster = this.aiming;
    if (this.mode !== Mode.Play || !game || !booster || this.running === game) return;
    if (stock(this.save.boosters, booster) < 1 || !strike(game, booster, at)) return;
    spend(this.save.boosters, booster);
    this.boosters.beckon(false);
    const record = this.recordOf(game);
    if (record) recordStrike(record, game.board, booster, at);
    // The moves valued at rest no longer stand: the next swap is not read against them.
    this.rest = null;
    this.thinkFrom = performance.now();
    this.aiming = null;
    this.view.aim(null);
    this.persist();
    this.updateInput();
    void this.run(game);
  }

  /** A tap on a booster: aims it, or stops aiming it. One not charged yet says how it charges. */
  private toggleAim(booster: Booster): void {
    const game = this.game;
    if (this.mode !== Mode.Play || !game) return;
    if (this.aiming === booster) {
      this.stopAim();
    } else if (stock(this.save.boosters, booster) < 1) {
      this.ui.flashText(S.boosterHint[booster]);
      return;
    } else if (canStrike(game) && this.running !== game) {
      this.aiming = booster;
      this.view.aim(booster);
      this.ui.flashText(S.aim[booster]);
    }
    this.updateInput();
  }

  private stopAim(): void {
    if (!this.aiming) return;
    this.aiming = null;
    this.view.aim(null);
    if (this.game && this.running !== this.game && this.mode === Mode.Play) this.view.armHint();
  }

  /**
   * The bar follows the saved charges; once the level is won, the win's gain too, as its sparks land:
   * the star fills from the moves left, the meteor from each star mark the win and then the score reaches.
   */
  private updateBoosters(): void {
    const game = this.game;
    if (!game) return;
    const usable = this.mode === Mode.Play && canStrike(game) && this.running !== game;
    if (!usable) this.stopAim();
    if (this.win) this.sendGain(game, this.win);
    const landed = this.win?.landed;
    this.boosters.update(landed ? this.chargesWith(landed) : this.save.boosters, usable, this.aiming);
  }

  /** Sends off what of the win's gain has not flown yet: the moves left to the star, each new star mark to the meteor. */
  private sendGain(game: GameState, win: WinGain): void {
    if (win.moves > win.sent.moves) this.fly(win, Booster.Star, this.ui.movesOrb(), { ...win.sent, moves: win.moves });
    const stars = starsFor(game);
    for (let k = win.sent.stars + 1; k <= stars; k++) this.fly(win, Booster.Meteor, this.ui.starMark(k), { ...win.sent, stars: k });
  }

  /** One leg of the gain: a spark per fortieth of a booster it adds; the bar takes it in as the first spark lands. */
  private fly(win: WinGain, b: Booster, from: HTMLElement | undefined, next: WinShare): void {
    const count = sparkCount(b, this.chargesWith(win.sent), this.chargesWith(next));
    win.sent = next;
    const landing = this.sparks.fly(b, from, this.boosters.orb(b), count, (first) => {
      if (count > 0) this.boosters.gulp(b);
      if (!first || this.win !== win) return;
      win.landed = { moves: Math.max(win.landed.moves, next.moves), stars: Math.max(win.landed.stars, next.stars) };
      this.updateBoosters();
    });
    win.landing = Promise.all([win.landing, landing]).then(() => undefined);
  }

  /** The saved charges with a share of the win's gain added. */
  private chargesWith(share: WinShare): Charges {
    return withGain(this.save.boosters, winGain(share.moves, share.stars));
  }

  /** Plays board steps one by one until the board rests, then ends the level or waits for the player. */
  private async run(game: GameState): Promise<void> {
    if (this.running === game) return;
    this.running = game;
    while (this.game === game) {
      while (this.swaps.size > 0) await Promise.all(this.swaps);
      if (this.game !== game) break;
      const events = timed('advance', () => advance(game));
      if (!events) break;
      const record = this.recordOf(game);
      if (record) recordStep(record);
      this.ui.updateHud(game);
      this.updateInput();
      this.scene.tweens.speed = chainSpeed(game.cascade);
      await this.view.play(events, (ev) => this.feedback(ev));
    }
    this.scene.tweens.speed = 1;
    if (this.running === game) this.running = null;
    if (this.game !== game) return;
    this.ui.updateHud(game);
    this.updateInput();
    this.persist();
    await this.onRest();
  }

  /** The board is calm: finish the level or let the player think. Deferred while paused. */
  private async onRest(): Promise<void> {
    const game = this.game;
    if (!game || this.running === game || this.mode !== Mode.Play) return;
    if (game.status === 'won') await this.finishWin(game);
    else if (game.status === 'lost' && this.canRescue(game)) this.offerRescue();
    else if (game.status === 'lost') this.showLose(game);
    else {
      this.rest = timed('options', () => moveOptions(game.board, goalsOf(game), this.lastTo));
      this.thinkFrom = performance.now();
      this.view.armHint();
    }
  }

  /**
   * A valid swap goes into the attempt record. Made on the calm board without a hint, it also shows
   * how the player picks among all the moves there were: that teaches their taste.
   */
  private learn(game: GameState, a: Pos, b: Pos, hint: boolean, input: SwapInput): void {
    const now = performance.now();
    const record = this.recordOf(game);
    // makeMove already swapped the pieces; the cells are what the record needs.
    if (record) recordMove(record, game.board, a, b, hint, now - this.thinkFrom, input);
    this.thinkFrom = now;
    const from = indexOf(game.board, a.r, a.c);
    const to = indexOf(game.board, b.r, b.c);
    this.lastTo = to;
    const options = this.rest;
    this.rest = null;
    if (!options || hint) return;
    const chosen = options.moves.findIndex(([i, j]) => (i === from && j === to) || (i === to && j === from));
    if (chosen >= 0) observeMove(this.save.player.model, options, chosen);
  }

  private recordOf(game: GameState): AttemptRecord | null {
    const attempt = this.save.current?.attempt;
    return attempt?.game === game ? attempt.record : null;
  }

  /** Reports the attempt, then lets the player's strength, star rate and pace learn from it. */
  private endAttempt(game: GameState, end: AttemptEnd, left: number, stars: number): void {
    const attempt = this.save.current?.attempt;
    const current = this.save.current;
    if (!current || !attempt || attempt.game !== game) return;
    const { player, settings } = this.save;
    const { record, target, threeStars } = attempt;
    trackAttempt({ draft: current.draft, game, record, end, left, stars, fails: current.fails, difficulty: settings.difficulty, target, threeStars, model: player.model });
    // An abandoned attempt has no outcome: it teaches neither strength nor stars.
    const weight = game.strikes > 0 ? BOOSTED_WEIGHT : 1;
    if (end !== AttemptEnd.Restart) observeOutcome(player.model, end === AttemptEnd.Won, game.level.targetWinRate, weight);
    if (end === AttemptEnd.Won) player.threeStars = updateThreeStars(player.threeStars, stars === 3);
    const progress = Math.min(...game.level.objectives.map((o, k) => game.progress[k] / o.target));
    player.pace = updatePace(player.pace, twinMoves(current.draft, game.level), game.movesMade, progress);
  }

  private async finishWin(game: GameState): Promise<void> {
    this.mode = Mode.Finale;
    const movesAtWin = game.movesLeft;
    haptic(Haptic.Success);
    this.ui.flashText(S.win);
    // The moves left turn into specials on the board and, as the counter rolls down, fly off the orb to the star.
    const finale = movesAtWin > 0 ? startFinale(game) : [];
    const none = { moves: 0, stars: 0 };
    const win: WinGain = { moves: movesAtWin, sent: none, landed: none, landing: Promise.resolve() };
    this.win = win;
    this.updateBoosters();
    this.ui.updateHud(game);
    if (movesAtWin > 0) {
      // The finale continues the winning chain: it opens at the speed that chain reached.
      this.scene.tweens.speed = chainSpeed(game.cascade);
      await this.view.play(finale, (ev) => this.feedback(ev));
      await this.run(game);
      this.ui.updateHud(game);
    }

    const def = game.level;
    const stars = starsFor(game);
    // The bar shows the win's gain as its sparks land and the fill rises; it is saved once all of it has played out.
    this.updateBoosters();
    await win.landing;
    await this.boosters.settled();
    this.save.boosters = withGain(this.save.boosters, winGain(movesAtWin, stars));
    this.endAttempt(game, AttemptEnd.Won, movesAtWin, stars);
    this.save.stars[def.number - 1] = Math.max(this.save.stars[def.number - 1] ?? 0, stars);
    this.save.level = def.number + 1;
    this.save.current = null;
    this.game = null;
    this.win = null;
    this.persist();

    await this.view.vanish();
    this.mode = Mode.Won;
    this.ui.hideHud();
    this.boosters.hide();
    this.ui.showWin(stars, game.score);
    this.audio.play(Sfx.Win);
    for (let k = 0; k < stars; k++) setTimeout(() => this.audio.play(Sfx.Star, 1 + k * 0.12), 150 + k * 120);
  }

  /** Out of moves with goals left and a booster saved: the level is not lost before the player says so. */
  private canRescue(game: GameState): boolean {
    return canRescue(game) && Object.values(Booster).some((b) => stock(this.save.boosters, b) > 0);
  }

  private offerRescue(): void {
    this.boosters.beckon(true);
    this.updateBoosters();
    this.ui.flashText(S.rescue);
  }

  private showLose(game: GameState): void {
    this.boosters.beckon(false);
    this.mode = Mode.Lost;
    this.audio.play(Sfx.Lose);
    // Extra moves cannot help a board that is stuck with moves still left.
    this.ui.showLose(game, OFFER_EXTRA_MOVES && !game.extraMovesUsed && game.movesLeft === 0, EXTRA_MOVES);
  }

  /** Ends the attempt as a failure; the next one is finalized with the failure counted. */
  private failLevel(end: AttemptEnd): void {
    const current = this.save.current;
    const game = current?.attempt?.game;
    if (!current || !game) return;
    this.endAttempt(game, end, game.movesLeft, 0);
    current.fails++;
    current.attempt = null;
    this.game = null;
    this.persist();
  }

  private pause(): void {
    this.stopAim();
    const record = this.game && this.recordOf(this.game);
    if (record) record.pauses++;
    this.mode = Mode.Pause;
    this.view.inputEnabled = false;
    this.view.cancelHint();
    this.ui.showPause();
  }

  private resume(): void {
    this.mode = Mode.Play;
    this.ui.hideOverlay();
    this.updateInput();
    void this.onRest();
  }

  /** Out of moves the board takes no swaps; an aimed booster still takes its cell. */
  private updateInput(): void {
    const game = this.game;
    this.view.inputEnabled = this.mode === Mode.Play && game !== null && (canAct(game) || (this.aiming !== null && canRescue(game)));
    this.updateBoosters();
  }

  // ---------- actions ----------

  /** Screen actions run one at a time; a double tap must not start a level twice. */
  private async onAction(action: Action, item?: string): Promise<void> {
    if (action === Action.ToggleEffect) {
      this.audio.play(Sfx.Button);
      this.toggleEffect(item as Fx);
      return;
    }
    if (item) {
      // the sound menu plays the variant itself, without the button sound over it
      this.pickSound(action, item as Sfx);
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
        await this.playLevel();
        break;
      case Action.Goals:
        if (this.mode === Mode.Play) this.showGoals();
        break;
      case Action.Update:
        this.openUpdate();
        break;
      case Action.GiveUp:
        if (this.game && this.mode === Mode.Play && this.running !== this.game && this.canRescue(this.game)) {
          this.stopAim();
          this.showLose(this.game);
          this.updateInput();
        }
        break;
      case Action.UpdateLater:
        this.closeUpdate();
        break;
      case Action.ApplyUpdate:
        await this.applyUpdate();
        break;
      case Action.Star:
        this.toggleAim(Booster.Star);
        break;
      case Action.Meteor:
        this.toggleAim(Booster.Meteor);
        break;
      case Action.Pause:
        if (this.mode === Mode.Play) this.pause();
        break;
      case Action.Resume:
        this.resume();
        break;
      case Action.Restart:
        if ((this.game?.movesMade ?? 0) > 0) this.failLevel(AttemptEnd.Restart);
        else if (this.save.current) this.save.current.attempt = null;
        await this.playLevel();
        break;
      case Action.Retry:
        this.failLevel(AttemptEnd.Lost);
        await this.playLevel();
        break;
      case Action.ExtraMoves:
        if (this.game && this.mode === Mode.Lost) {
          addExtraMoves(this.game);
          this.persist();
          this.ui.updateHud(this.game);
          this.ui.hideOverlay();
          this.mode = Mode.Play;
          // Runs the board to rest again: a board without moves gets shuffled.
          void this.run(this.game);
        }
        break;
      case Action.Menu:
        if (this.mode === Mode.Lost) this.failLevel(AttemptEnd.Lost);
        await this.ui.curtain(() => this.showTitle());
        break;
      case Action.Help:
        this.menuReturn = this.mode;
        this.mode = Mode.Help;
        this.ui.showHelp();
        break;
      case Action.Settings:
        this.menuReturn = this.mode;
        this.mode = Mode.Settings;
        this.ui.showSettings(this.save.settings);
        break;
      case Action.Sounds:
        this.mode = Mode.Sounds;
        this.ui.showSounds(this.save.settings.sounds);
        break;
      case Action.Effects:
        this.mode = Mode.Effects;
        this.ui.showEffects(this.save.settings.effects);
        break;
      case Action.Back:
        if (this.mode === Mode.Sounds || this.mode === Mode.Effects) {
          this.mode = Mode.Settings;
          this.ui.showSettings(this.save.settings);
          break;
        }
        this.mode = this.menuReturn;
        if (this.mode === Mode.Pause) this.ui.showPause();
        else this.showTitle();
        break;
      case Action.ToggleSound:
      case Action.ToggleHaptics:
      case Action.ToggleFullscreen:
        this.toggleSetting(action);
        break;
      case Action.BoardSmaller:
      case Action.BoardBigger:
        this.resizeBoard(action === Action.BoardBigger ? BoardSize.Step : -BoardSize.Step);
        break;
      case Action.Easier:
      case Action.Harder:
        this.stepDifficulty(action === Action.Harder ? 1 : -1);
        break;
      case Action.Reset:
        if (this.ui.confirmReset()) {
          this.save = defaultSave();
          this.game = null;
          this.rest = null;
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
    if (action === Action.ToggleFullscreen) s.fullscreen = !s.fullscreen;
    this.applySettings();
    if (action === Action.ToggleHaptics && s.haptics) haptic(Haptic.Confirm);
    this.persist();
    this.ui.showSettings(s);
  }

  /** Applies at once: opened from pause, the board behind the card shows the new size. */
  private resizeBoard(delta: number): void {
    const s = this.save.settings;
    s.boardSize = Math.min(BoardSize.Max, Math.max(BoardSize.Min, s.boardSize + delta));
    this.applySettings();
    this.persist();
    this.ui.showSettings(s);
  }

  /** Takes effect from the next attempt: the one in progress keeps its moves. */
  private stepDifficulty(delta: number): void {
    const s = this.save.settings;
    const k = Math.min(DIFFICULTIES.length - 1, Math.max(0, DIFFICULTIES.indexOf(s.difficulty) + delta));
    s.difficulty = DIFFICULTIES[k];
    this.persist();
    this.ui.showSettings(s);
  }

  /** Sound menu: ‹ › step to the neighbouring variant and play it, the name replays it. The pick plays in the game at once. */
  private pickSound(action: Action, id: Sfx): void {
    const sounds = this.save.settings.sounds;
    const variants = VARIANTS[id];
    const step = action === Action.SoundNext ? 1 : action === Action.SoundPrev ? -1 : 0;
    if (step !== 0) {
      const k = variants.indexOf(chosen(sounds, id));
      sounds[id] = variants[(k + step + variants.length) % variants.length];
      this.audio.choose(sounds);
      this.persist();
      this.ui.updateSound(id, sounds);
    }
    void this.audio.preview(id, chosen(sounds, id));
  }

  /** Effects menu: a tap switches the effect on or off, and the board plays it that way at once. */
  private toggleEffect(fx: Fx): void {
    const effects = this.save.settings.effects;
    if (effects[fx] === false) delete effects[fx];
    else effects[fx] = false;
    this.applyEffects();
    this.persist();
    this.ui.updateEffect(fx, effects);
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
      case Mode.Sounds:
      case Mode.Effects:
      case Mode.Help:
        await this.onAction(Action.Back);
        break;
      case Mode.Won:
      case Mode.Lost:
        await this.onAction(Action.Menu);
        break;
      case Mode.Update:
        this.closeUpdate();
        break;
      case Mode.Title:
        exitApp();
        break;
    }
  }

  // ---------- presentation ----------

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
        if (kinds.has(BlastKind.Star)) this.audio.play(Sfx.FallingStar);
        if (kinds.has(BlastKind.Meteor)) this.audio.play(Sfx.Meteor);
        if (kinds.has(BlastKind.Bomb)) this.audio.play(Sfx.Bomb);
        if (kinds.has(BlastKind.Prism)) this.audio.play(Sfx.Prism);
        // A booster is felt as it strikes, after its fall.
        if (kinds.has(BlastKind.Meteor)) setTimeout(() => haptic(Haptic.Heavy), Timing.meteorFall);
        else if (kinds.has(BlastKind.Star)) setTimeout(() => haptic(Haptic.Medium), Timing.starFall);
        else if (kinds.has(BlastKind.Bomb) || kinds.has(BlastKind.Prism)) haptic(Haptic.Heavy);
        else if (kinds.size > 0) haptic(Haptic.Medium);
        else haptic(Haptic.Light);
        if (ev.cascade >= 2) this.ui.praise(ev.cascade - 2);
        break;
      }
      case 'transform':
        this.audio.play(Sfx.Transform);
        break;
      case 'shuffle':
        this.audio.play(Sfx.Shuffle);
        this.ui.flashText(S.shuffle);
        break;
      case 'light':
        this.audio.play(Sfx.Light);
        break;
      case 'lastChance':
        this.audio.play(Sfx.LastChance);
        haptic(Haptic.Heavy);
        this.ui.flashText(S.lastChance);
        break;
      case 'fall':
        break;
    }
  }

  // ---------- misc ----------

  private applySettings(): void {
    const s = this.save.settings;
    this.audio.enabled = s.sound;
    this.audio.choose(s.sounds);
    this.applyEffects();
    setHapticsEnabled(s.haptics);
    setFullscreen(s.fullscreen);
    this.view.setScale(s.boardSize / 100);
    perfContext({ boardSize: s.boardSize });
  }

  /** The board, the HUD and the bar follow the effects menu. */
  private applyEffects(): void {
    const effects = this.save.settings.effects;
    this.view.fx.set(effects);
    this.ui.setEffects(effects);
    this.boosters.setGlow(effects[Fx.BoosterGlow] !== false);
  }

  /** Viewport changes (system bars sliding in, rotation) glide instead of jumping. */
  private resize(stage: HTMLElement): void {
    const { width, height } = stage.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const { offsetLeft, offsetTop } = stage;
    this.view.resize(width, height, this.stageAt.x - offsetLeft, this.stageAt.y - offsetTop);
    this.stageAt = { x: offsetLeft, y: offsetTop };
    this.scene.resize(width, height);
    this.ui.relayout();
  }

  private persist(): void {
    persist(this.save);
  }

  private showDebug(): void {
    const current = this.save.current;
    const d = current?.attempt?.game.level;
    if (!this.debugEl || !current || !d) return;
    const { player, settings } = this.save;
    const built = current.draft.request.style;
    const now = twinOf(player.model);
    this.debugEl.textContent = [
      `L${d.number} ${d.kind}${d.intro ? ` +${d.intro}` : ''} v${current.draft.variant}`,
      `p=${d.targetWinRate.toFixed(2)} ${settings.difficulty} colors=${d.colors} moves=${d.moves}`,
      `fails=${current.fails} pace=${paceFactor(player.pace)} (built ${current.draft.request.pace}) 3★q=${player.threeStars.toFixed(2)}`,
      `built strength=${built.strength} craft=${built.craft}`,
      `now strength=${now.strength} craft=${now.craft} (${player.model.moves} moves)`,
      `taste ${now.weights.map((w) => w.toFixed(1)).join(' ')}`,
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
