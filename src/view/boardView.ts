import 'pixi.js/text-bitmap';
import { BitmapFont, BitmapText, Container, Sprite, type Texture } from 'pixi.js';
import { isAdjacent } from '@/core/board';
import { findMoves } from '@/core/moves';
import { strikeCells } from '@/core/resolve';
import { BlastKind, type Board, Booster, type GameEvent, NO_COLOR, type Piece, type Pos, Special, type SwapEvent } from '@/core/types';
import type { SwapInput } from '@/telemetry/attempt';
import { perfContext, perfCount, perfFlag, timed } from '@/telemetry/perf';
import { FrameName, GEM_TINTS } from '@/view/art';
import { Atlas } from '@/view/atlas';
import { Camera } from '@/view/fx/camera';
import { blastPower, cascadeBoost, feel, METEOR_HITS } from '@/view/fx/impact';
import { SpritePool } from '@/view/fx/pool';
import { blastFx, comboCharge, createFx, flash, type FxKit, land, type Layer, layerFx, popPiece, strikeFall, WHITE } from '@/view/fx/stage';
import { Fx, FxSwitches } from '@/view/fx/switches';
import { planClear, strikeOf } from '@/view/fx/timeline';
import { Particles } from '@/view/particles';
import type { Scene } from '@/view/scene';
import { Ease, type EaseFn } from '@/view/tween';

export type { Layer } from '@/view/fx/stage';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type ClearEvent = Extract<GameEvent, { type: 'clear' }>;
type FallEvent = Extract<GameEvent, { type: 'fall' }>;
type PiecesEvent = Extract<GameEvent, { type: 'transform' | 'shuffle' }>;
type LightEvent = Extract<GameEvent, { type: 'light' }>;

const MAX_CELL = 84;
/** Time constant of the drift after a viewport change: ~95% of the way in three of these. */
const GLIDE_TAU = 90;
const HINT_DELAY = 5000;
/** beat between the "last chance" call-out and the specials going off */
const LAST_CHANCE_PAUSE = 650;
/** beat between the finale lighting its specials and the first one going off */
const LIGHT_PAUSE = 220;
/** period of the pulse of a lit special waiting its turn, ms per radian */
const LIT_PULSE = 70;
/** pieces above start falling this much before the cleared ones finish popping */
const FALL_OVERLAP = 50;
/** falling pieces start at this fraction of the average speed instead of from rest, then accelerate */
const FALL_START_SPEED = 0.35;
const FALL_EASE: EaseFn = (t) => t * (FALL_START_SPEED + (1 - FALL_START_SPEED) * t);
const SCORE_FONT = 'gf-score';
/** a removed piece pops this long, a merging one slides this long into its special */
const POP_END = 140;
const MERGE_MS = 140;
/** a created special appears once the pieces merged into it */
const CREATE_DELAY = 140;
const CREATE_MS = 220;
/** a clear with this many pieces throws a full burst for each; more pieces share it */
const FULL_BURSTS = 14;
/** a swapped piece passes over the other: this much bigger, the other this much smaller */
const SWAP_OVER = 0.1;
const SWAP_UNDER = 0.08;
/** the aim's tint per booster, and the period of its pulse, ms per radian */
const AIM_TINTS: Record<Booster, number> = { [Booster.Star]: 0xffd25e, [Booster.Meteor]: 0xff7a2a };
const AIM_PULSE = 110;

/** Where the board sits in the canvas area, CSS pixels. */
export interface BoardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardListener {
  onSwap(a: Pos, b: Pos, input: SwapInput): void;
  /** the player released an aimed booster over this cell */
  onStrike(at: Pos): void;
  /** a blocker layer visibly took a hit (for sound) */
  onLayerHit(layer: Layer): void;
  /** the board was fitted anew: what sits under it follows */
  onLayout(rect: BoardRect): void;
}

interface LayerSprite {
  sprite: Sprite;
  value: number;
}

/**
 * Pixi presentation of the board. It never decides anything: it mirrors the board state
 * and plays back the event script the core produced for a move.
 */
export class BoardView {
  public inputEnabled = false;
  /** player's board size setting, applied to the cell that fits */
  private scale = 1;
  private readonly atlas = new Atlas();
  /** Eases viewport changes: maps the board from where it was seen to where it now sits. */
  private readonly glide = new Container();
  private readonly boardRoot = new Container();
  private readonly tiles = new Container();
  private readonly iceLayer = new Container();
  /** halos behind lit specials */
  private readonly litLayer = new Container();
  private readonly pieceLayer = new Container();
  private readonly crateLayer = new Container();
  private readonly chainLayer = new Container();
  /** particles that cover: shards, splinters, dust */
  private readonly matterLayer = new Container();
  /** additive light: beams, rings, flashes, sparks */
  private readonly lightLayer = new Container();
  private readonly textLayer = new Container();
  /** a booster's aim: the cells it would take */
  private readonly aimLayer = new Container();
  /** shakes and punches the board; between the glide and the board, so neither fights the other */
  private readonly camera = new Camera();
  private readonly pool = new SpritePool();
  private readonly particles: Particles;
  /** effects switched on and off in the debug menu */
  public readonly fx = new FxSwitches();
  private readonly kit: Writable<FxKit>;
  private readonly sprites = new Map<number, Sprite>();
  private readonly ice = new Map<number, LayerSprite>();
  private readonly crates = new Map<number, LayerSprite>();
  private readonly chains = new Map<number, LayerSprite>();
  private readonly popupPool: BitmapText[] = [];
  /** lit specials waiting to go off, by piece id, with their halo (null until drawn) */
  private readonly lit = new Map<number, Sprite | null>();
  private litClock = 0;
  /** piece per cell as the player currently sees it (lags the core board during playback) */
  private grid: (Piece | null)[] = [];
  private board: Board | null = null;
  private cell = 48;
  private originX = 0;
  private originY = 0;
  private width = 1;
  private height = 1;
  private selected: Pos | null = null;
  private drag: { pos: Pos; x: number; y: number } | null = null;
  /** pieces picked since the last swap: the one swapped, and those let go before it */
  private picks = 0;
  private hintTimer = 0;
  private hintToken = 0;
  /** cells of the pulsing move; cells, not sprites, so a rebuild of the board keeps the hint */
  private hinted: number[] = [];
  /** cells being animated; the player can grab only the rest, so moves are possible during a cascade */
  private readonly locked = new Set<number>();
  /** bumped when the board is replaced or removed: playback still in flight stops */
  private epoch = 0;
  /** special hits so far in the script being played: each next one shakes harder */
  private hits = 0;
  /** room kept free under the board (the booster bar), CSS pixels */
  private footer = 0;
  /** the booster being aimed, the cell it points at, and whether a finger is down on the board */
  private aiming: Booster | null = null;
  private aimAt: Pos | null = null;
  private aimDown = false;
  private aimClock = 0;

  public constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly input: BoardListener,
  ) {
    this.boardRoot.addChild(this.tiles, this.iceLayer, this.litLayer, this.pieceLayer, this.crateLayer, this.chainLayer, this.matterLayer, this.lightLayer, this.aimLayer, this.textLayer);
    this.camera.view.addChild(this.boardRoot);
    this.glide.addChild(this.camera.view);
    scene.root.addChild(this.glide);
    this.particles = new Particles(this.matterLayer, this.lightLayer, this.pool, (name) => this.atlas.get(name), () => scene.request());
    this.kit = this.makeKit();
    scene.addUpdater((dt) => this.particles.update(dt));
    scene.addUpdater((dt) => this.settleGlide(dt), true);
    scene.addUpdater((dt) => this.camera.update(dt), true);
    scene.addUpdater((dt) => this.pulseLit(dt));
    scene.addUpdater((dt) => this.pulseAim(dt));
    scene.onQualityChange = () => this.layout(this.width, this.height);

    BitmapFont.install({
      name: SCORE_FONT,
      chars: [['0', '9'], '+'],
      resolution: 2,
      style: {
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: 48,
        fontWeight: '800',
        fill: '#ffffff',
        stroke: { color: '#3b1466', width: 8 },
      },
    });

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => {
      this.drag = null;
      this.aimDown = false;
    });
  }

  // ---------- setup ----------

  /** What the effects may use of the board; its sizes follow the layout. */
  private makeKit(): Writable<FxKit> {
    return {
      cell: this.cell,
      cols: 1,
      rows: 1,
      x: (c) => this.x(c),
      y: (r) => this.y(r),
      texture: (name) => this.atlas.get(name),
      light: this.lightLayer,
      pool: this.pool,
      particles: this.particles,
      camera: this.camera,
      tweens: this.scene.tweens,
      on: (fx) => this.fx.on(fx),
      after: (ms, fn) => this.after(ms, fn),
      pieceAt: (p) => (this.board && p.r >= 0 && p.r < this.board.rows && p.c >= 0 && p.c < this.board.cols ? this.spriteAt(this.indexOf(p)) : undefined),
    };
  }

  /** Keeps `px` free under the board: the board and what sits under it are centered together. */
  public setFooter(px: number): void {
    this.footer = px;
    this.layout(this.width, this.height);
  }

  /** The atlas is repainted for the new cell size, so a smaller board stays sharp. */
  public setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.layout(this.width, this.height);
  }

  public setBoard(board: Board): void {
    this.cancelHint();
    this.epoch++;
    this.locked.clear();
    this.board = board;
    this.lit.clear();
    this.grid = board.cells.map((c) => c.piece);
    this.camera.reset();
    this.deselect();
    this.aim(null);
    this.picks = 0;
    this.layout(this.width, this.height, true);
  }

  /** Removes the board from the screen (menus show the bare background). */
  public clear(): void {
    this.cancelHint();
    this.epoch++;
    this.locked.clear();
    this.lit.clear();
    this.wipe();
    this.camera.reset();
    this.aim(null);
    this.board = null;
    this.grid = [];
    this.scene.request();
  }

  /** Destroys every sprite; running animations jump to their end first. A hint survives: it names cells. */
  private wipe(): void {
    this.scene.tweens.finishAll();
    this.particles.clear();
    for (const layer of [this.tiles, this.iceLayer, this.litLayer, this.pieceLayer, this.crateLayer, this.chainLayer, this.matterLayer, this.lightLayer]) {
      for (const child of layer.removeChildren()) child.destroy();
    }
    this.sprites.clear();
    // Lit ids survive a rebuild; their halos come back on the next frame.
    for (const id of this.lit.keys()) this.lit.set(id, null);
    this.ice.clear();
    this.crates.clear();
    this.chains.clear();
    this.selected = null;
  }

  /**
   * The canvas area changed size and moved by `dx, dy` (CSS pixels):
   * the board is refitted but drifts there from where it was seen instead of jumping.
   */
  public resize(width: number, height: number, dx: number, dy: number): void {
    const { originX, originY, cell } = this;
    const shown = this.board !== null;
    this.layout(width, height);
    if (!shown || !this.board) return;
    // screen = glide.position + glide.scale · local; keep the old picture, then let it decay to identity
    const g = this.glide;
    const scale = (g.scale.x * cell) / this.cell;
    g.position.set(g.x + dx + g.scale.x * originX - scale * this.originX, g.y + dy + g.scale.y * originY - scale * this.originY);
    g.scale.set(scale);
  }

  /** Fits the board into the canvas area (CSS pixels). */
  public layout(width: number, height: number, forceRebuild = false): void {
    this.width = width;
    this.height = height;
    const b = this.board;
    if (!b) return;
    const cell = Math.max(16, Math.floor(Math.min(width / b.cols, (height - this.footer) / b.rows, MAX_CELL) * this.scale));
    this.cell = cell;
    this.originX = Math.round((width - cell * b.cols) / 2);
    this.originY = Math.round((height - this.footer - cell * b.rows) / 2);
    this.input.onLayout({ x: this.originX, y: this.originY, width: cell * b.cols, height: cell * b.rows });
    this.boardRoot.position.set(this.originX, this.originY);
    this.camera.frame(this.originX + (cell * b.cols) / 2, this.originY + (cell * b.rows) / 2, cell);
    this.particles.density = this.scene.particleDensity;
    this.particles.cell = cell;
    Object.assign(this.kit, { cell, cols: b.cols, rows: b.rows });
    perfContext({ cell });
    if (this.atlas.build(cell, this.scene.resolution) || forceRebuild) timed('rebuild', () => this.rebuild());
    this.drawAim();
    this.scene.request();
  }

  private rebuild(): void {
    const b = this.board!;
    this.wipe();
    b.cells.forEach((cell, i) => {
      if (!cell.exists) return;
      const { r, c } = this.posOf(i);
      this.tiles.addChild(this.sprite(FrameName[(r + c) % 2 === 0 ? 'TileA' : 'TileB'], r, c));
      if (cell.ice > 0) this.addLayer(this.ice, this.iceLayer, i, FrameName.ice(cell.ice), cell.ice);
      if (cell.crate > 0) this.addLayer(this.crates, this.crateLayer, i, FrameName.crate(cell.crate), cell.crate);
      if (cell.chain > 0) this.addLayer(this.chains, this.chainLayer, i, FrameName.chain(cell.chain), cell.chain);
    });
    this.grid.forEach((piece, i) => {
      if (piece) this.addPiece(piece, this.posOf(i));
    });
  }

  // ---------- playback ----------

  /**
   * Plays a script; `onEvent` fires as each event starts (sound, haptics).
   * Every cell the script touches stays locked until it ends.
   */
  public async play(events: GameEvent[], onEvent: (ev: GameEvent) => void): Promise<void> {
    const epoch = this.epoch;
    const cells = this.cellsOf(events);
    for (const i of cells) this.locked.add(i);
    this.hits = 0;
    if (this.selected && cells.has(this.indexOf(this.selected))) this.deselect();

    for (const ev of events) {
      if (epoch !== this.epoch) return;
      onEvent(ev);
      switch (ev.type) {
        case 'swap':
          await this.playSwap(ev);
          break;
        case 'clear':
          await this.playClear(ev);
          break;
        case 'fall':
          await this.playFall(ev);
          break;
        case 'transform':
          await this.playTransform(ev);
          break;
        case 'shuffle':
          await this.playShuffle(ev);
          break;
        case 'light':
          await this.playLight(ev);
          break;
        case 'lastChance':
          // The announcement gets a beat before the specials go off.
          await this.scene.tweens.wait(LAST_CHANCE_PAUSE);
          break;
      }
    }
    if (epoch === this.epoch) for (const i of cells) this.locked.delete(i);
  }

  private cellsOf(events: GameEvent[]): Set<number> {
    const b = this.board!;
    const cells = new Set<number>();
    const add = (p: Pos): void => {
      if (p.r >= 0 && p.r < b.rows) cells.add(this.indexOf(p));
    };
    for (const ev of events) {
      switch (ev.type) {
        case 'swap':
          add(ev.a);
          add(ev.b);
          break;
        case 'clear':
          for (const x of [...ev.removed, ...ev.created, ...ev.layers]) add(x.pos);
          break;
        case 'fall':
          for (const m of ev.moves) m.path.forEach(add);
          break;
        case 'transform':
        case 'shuffle':
          for (const p of ev.pieces) add(p.pos);
          break;
      }
    }
    return cells;
  }

  /** Pieces rain in column by column at level start. */
  public async entrance(): Promise<void> {
    const b = this.board!;
    const jobs: Promise<void>[] = [];
    this.grid.forEach((piece, i) => {
      if (!piece) return;
      const sprite = this.sprites.get(piece.id)!;
      const { r, c } = this.posOf(i);
      const targetY = this.y(r);
      const startY = targetY - (b.rows + 1) * this.cell;
      sprite.y = startY;
      const delay = c * 28 + (b.rows - 1 - r) * 22;
      jobs.push(
        this.scene.tweens
          .run(380, (k) => (sprite.y = startY + (targetY - startY) * k), { delay, ease: Ease.inQuad })
          .then(() => land(this.kit, sprite, b.rows + 1)),
      );
    });
    await Promise.all(jobs);
  }

  /** Pieces sparkle away when the level ends. */
  public async vanish(): Promise<void> {
    const jobs = [...this.sprites.values()].map((sprite) => {
      const delay = Math.random() * 250;
      return this.scene.tweens.run(
        260,
        (k) => {
          sprite.scale.set(1 - k);
          sprite.alpha = 1 - k;
        },
        { delay, ease: Ease.inQuad },
      );
    });
    await Promise.all(jobs);
  }

  private async playSwap(ev: SwapEvent): Promise<void> {
    const ia = this.indexOf(ev.a);
    const ib = this.indexOf(ev.b);
    const sa = this.spriteAt(ia);
    const sb = this.spriteAt(ib);
    if (!sa || !sb) return;
    const [ax, ay, bx, by] = [this.x(ev.a.c), this.y(ev.a.r), this.x(ev.b.c), this.y(ev.b.r)];
    const depth = this.fx.on(Fx.SwapDepth);
    // The moved piece passes over the other one.
    if (depth) this.pieceLayer.addChild(sa);
    const move = (k: number): void => {
      sa.position.set(ax + (bx - ax) * k, ay + (by - ay) * k);
      sb.position.set(bx + (ax - bx) * k, by + (ay - by) * k);
      if (!depth) return;
      const d = Math.sin(Math.PI * Math.min(1, Math.max(0, k)));
      sa.scale.set(1 + SWAP_OVER * d);
      sb.scale.set(1 - SWAP_UNDER * d);
    };
    if (ev.valid) {
      [this.grid[ia], this.grid[ib]] = [this.grid[ib], this.grid[ia]];
      await this.scene.tweens.run(150, move, { ease: Ease.outQuad });
      return;
    }
    await this.scene.tweens.run(130, move, { ease: Ease.outQuad });
    await this.scene.tweens.run(170, (k) => move(1 - k), { ease: Ease.outBack });
  }

  /**
   * A clear step, timed by its plan: every piece pops as its blast's wave reaches it, a chained special
   * goes off once the wave got to it, a combo gathers its power first. Every hit shakes the board, harder along the move.
   */
  private async playClear(ev: ClearEvent): Promise<void> {
    const plan = planClear(ev, { wave: this.fx.on(Fx.Wave), charge: this.fx.on(Fx.Combo) });
    perfCount('pops', ev.removed.length);
    for (const b of ev.blasts) perfCount(`blast-${b.kind}`);
    const createdAt = new Map(ev.created.map((c) => [c.piece.id, c.pos]));
    const boost = cascadeBoost(ev.cascade);
    // A crowded clear shares one budget of particles, so the last pieces are not left without any.
    const amount = boost * Math.sqrt(Math.min(1, FULL_BURSTS / Math.max(1, ev.removed.length)));
    let end = plan.lead;
    // One freeze per step at most: a freeze on every blast of a chain would drag.
    const step = { frozen: false };

    // An aimed booster falls from the sky first: the lead is its fall.
    const strike = strikeOf(ev);
    if (strike) strikeFall(this.kit, strike, plan.lead);

    if (ev.combo) {
      const center = ev.combo;
      const pair = ev.removed
        .filter((rm) => rm.order === 0 && Math.max(Math.abs(rm.pos.r - center.r), Math.abs(rm.pos.c - center.c)) <= 1)
        .flatMap((rm) => this.sprites.get(rm.id) ?? []);
      if (plan.lead > 0) comboCharge(this.kit, center, pair, plan.lead);
      // Two specials at once: lands as two hits.
      this.after(plan.lead, () => this.impact(step, 2));
    }

    const powers = ev.blasts.map((b) => blastPower(b) * boost);
    ev.blasts.forEach((blast, i) => {
      const start = plan.blasts[i];
      const tint = blast.color !== NO_COLOR ? GEM_TINTS[blast.color] : tintOf(colorAt(ev, blast.origin));
      this.after(start, () => {
        blastFx(this.kit, blast, tint, powers[i], (p) => plan.at(p, blast.order) - start);
        // A combo's own blasts hit as one, at its center; a meteor lands as a whole chain's worth.
        if (!ev.combo || blast.order > 0) this.impact(step, blast.kind === BlastKind.Meteor ? METEOR_HITS : 1);
      });
      end = Math.max(end, start + 120);
    });

    for (const rm of ev.removed) {
      const i = this.indexOf(rm.pos);
      if (this.grid[i]?.id === rm.id) this.grid[i] = null;
      const sprite = this.sprites.get(rm.id);
      if (!sprite) continue;
      this.sprites.delete(rm.id);
      const at = plan.at(rm.pos, rm.order);
      const target = rm.mergeInto >= 0 ? createdAt.get(rm.mergeInto) : undefined;
      if (target) {
        const [sx, sy, tx, ty] = [sprite.x, sprite.y, this.x(target.c), this.y(target.r)];
        void this.scene.tweens
          .run(
            MERGE_MS,
            (k) => {
              sprite.position.set(sx + (tx - sx) * k, sy + (ty - sy) * k);
              sprite.scale.set(1 - k * 0.4);
            },
            { delay: at, ease: Ease.inQuad },
          )
          .then(() => sprite.destroy());
        end = Math.max(end, at + MERGE_MS);
      } else {
        this.after(at, () => popPiece(this.kit, sprite, rm.color, tintOf(rm.color), amount));
        end = Math.max(end, at + POP_END);
      }
    }

    for (const c of ev.created) {
      this.grid[this.indexOf(c.pos)] = c.piece;
      const sprite = this.addPiece(c.piece, c.pos);
      sprite.scale.set(0);
      const at = plan.lead + CREATE_DELAY;
      void this.scene.tweens.run(CREATE_MS, (k) => sprite.scale.set(k), { delay: at, ease: Ease.outBack });
      this.after(at, () => createFx(this.kit, this.x(c.pos.c), this.y(c.pos.r), tintOf(c.piece.color)));
      end = Math.max(end, at + CREATE_MS);
    }

    for (const l of ev.layers) {
      const i = this.indexOf(l.pos);
      const at = plan.layer(l);
      this.after(at, () => {
        this.setLayer('ice', this.ice, i, l.ice, FrameName.ice);
        this.setLayer('crate', this.crates, i, l.crate, FrameName.crate);
        this.setLayer('chain', this.chains, i, l.chain, FrameName.chain);
      });
      end = Math.max(end, at);
    }

    if (this.fx.on(Fx.Popups)) for (const p of ev.popups) this.after(plan.popup(p), () => this.popup(p.r, p.c, p.value));
    // A special lights up as the blast reaches it.
    for (const l of ev.lit) this.after(plan.at(l.pos, l.order), () => this.light(l.id));

    await this.scene.tweens.wait(Math.max(0, end - FALL_OVERLAP));
  }

  /** A special's hit, worth `count` hits: lands harder the further the move got (see `feel`). */
  private impact(step: { frozen: boolean }, count = 1): void {
    const f = feel(this.hits + count - 1);
    this.hits += count;
    if (this.fx.on(Fx.Shake)) this.camera.shake(f.shake);
    if (this.fx.on(Fx.Punch)) this.camera.punch(f.punch);
    if (this.fx.on(Fx.Hitstop) && f.stopMs > 0 && !step.frozen) {
      step.frozen = true;
      this.scene.hitstop(f.stopMs);
    }
  }

  private async playFall(ev: FallEvent): Promise<void> {
    for (const m of ev.moves) {
      if (m.spawned) continue;
      const i = this.indexOf(m.path[0]);
      if (this.grid[i]?.id === m.piece.id) this.grid[i] = null;
    }
    let end = 0;
    for (const m of ev.moves) {
      this.grid[this.indexOf(m.path[m.path.length - 1])] = m.piece;
      const sprite = this.sprites.get(m.piece.id) ?? this.addPiece(m.piece, m.path[0]);
      const points = m.path.map((p) => ({ x: this.x(p.c), y: this.y(p.r) }));
      const lengths = points.slice(1).map((p, k) => Math.hypot(p.x - points[k].x, p.y - points[k].y));
      const total = lengths.reduce((a, b) => a + b, 0);
      const duration = 90 + 95 * Math.sqrt(total / this.cell);
      const fadeIn = m.spawned;
      if (fadeIn) sprite.alpha = 0;
      void this.scene.tweens
        .run(
          duration,
          (k) => {
            let d = k * total;
            let seg = 0;
            while (seg < lengths.length - 1 && d > lengths[seg]) d -= lengths[seg++];
            const from = points[seg];
            const to = points[seg + 1];
            const t = lengths[seg] > 0 ? Math.min(1, d / lengths[seg]) : 1;
            sprite.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            // Spawned pieces fade in as they cross the top edge instead of using a mask.
            if (fadeIn) sprite.alpha = Math.max(0, Math.min(1, sprite.y / this.cell + 0.5));
          },
          { ease: FALL_EASE },
        )
        .then(() => land(this.kit, sprite, total / this.cell));
      end = Math.max(end, duration);
    }
    await this.scene.tweens.wait(end + 40);
  }

  private async playLight(ev: LightEvent): Promise<void> {
    for (const p of ev.pieces) this.light(p.id);
    await this.scene.tweens.wait(LIGHT_PAUSE);
  }

  /** A lit special pulses with a halo until it goes off. */
  private light(id: number): void {
    const sprite = this.sprites.get(id);
    if (!sprite || this.lit.has(id)) return;
    this.lit.set(id, null);
    flash(this.kit, sprite.x, sprite.y, 1.5, WHITE);
    this.scene.request();
  }

  /** Halos follow their pieces as they fall; a piece that went off takes its halo along. */
  private pulseLit(dt: number): boolean {
    if (this.lit.size === 0) return false;
    this.litClock += dt;
    const pulse = Math.sin(this.litClock / LIT_PULSE);
    for (const [id, halo] of this.lit) {
      const piece = this.sprites.get(id);
      if (!piece) {
        halo?.destroy();
        this.lit.delete(id);
        continue;
      }
      const h = halo ?? this.addHalo(id);
      h.position.copyFrom(piece.position);
      h.scale.set(1.3 + 0.15 * pulse);
      h.alpha = 0.75 + 0.25 * pulse;
    }
    return this.lit.size > 0;
  }

  private addHalo(id: number): Sprite {
    const halo = new Sprite(this.atlas.get(FrameName.Glow));
    halo.anchor.set(0.5);
    halo.blendMode = 'add';
    this.litLayer.addChild(halo);
    this.lit.set(id, halo);
    return halo;
  }

  private async playTransform(ev: PiecesEvent): Promise<void> {
    const jobs = ev.pieces.map((p, k) => {
      const sprite = this.sprites.get(p.piece.id);
      if (!sprite) return Promise.resolve();
      return this.scene.tweens.wait(k * 45).then(() => {
        sprite.texture = this.pieceTexture(p.piece);
        flash(this.kit, sprite.x, sprite.y, 1.4, WHITE);
        return this.scene.tweens.run(220, (t) => sprite.scale.set(1.35 - 0.35 * t), { ease: Ease.outQuad });
      });
    });
    await Promise.all(jobs);
  }

  private async playShuffle(ev: PiecesEvent): Promise<void> {
    const jobs = ev.pieces.map((p) => {
      this.grid[this.indexOf(p.pos)] = p.piece;
      const sprite = this.sprites.get(p.piece.id);
      if (!sprite) return Promise.resolve();
      sprite.texture = this.pieceTexture(p.piece);
      const [sx, sy, tx, ty] = [sprite.x, sprite.y, this.x(p.pos.c), this.y(p.pos.r)];
      return this.scene.tweens.run(
        460,
        (k) => {
          sprite.position.set(sx + (tx - sx) * k, sy + (ty - sy) * k);
          sprite.scale.set(1 - Math.sin(k * Math.PI) * 0.35);
        },
        { ease: Ease.inOutCubic },
      );
    });
    await Promise.all(jobs);
  }

  // ---------- effects ----------

  private popup(r: number, c: number, value: number): void {
    const text = this.popupPool.pop() ?? new BitmapText({ text: '', style: { fontFamily: SCORE_FONT, fontSize: 24 } });
    text.text = `+${value}`;
    text.style.fontSize = Math.round(this.cell * 0.42);
    text.anchor.set(0.5);
    const x = this.x(c);
    const y0 = this.y(r);
    text.position.set(x, y0);
    text.alpha = 1;
    this.textLayer.addChild(text);
    void this.scene.tweens
      .run(
        650,
        (k) => {
          text.y = y0 - k * this.cell * 0.8;
          text.alpha = k < 0.5 ? 1 : 1 - (k - 0.5) * 2;
          text.scale.set(k < 0.15 ? 0.6 + (k / 0.15) * 0.4 : 1);
        },
        { ease: Ease.outCubic },
      )
      .then(() => {
        this.textLayer.removeChild(text);
        this.popupPool.push(text);
      });
  }

  /** Decays the glide; position and scale shrink by one factor, so every point moves in a straight line. */
  private settleGlide(dt: number): boolean {
    const g = this.glide;
    if (g.scale.x === 1 && g.x === 0 && g.y === 0) return false;
    const k = Math.exp(-dt / GLIDE_TAU);
    const scale = 1 + (g.scale.x - 1) * k;
    if (Math.abs(scale - 1) * this.cell < 0.05 && Math.abs(g.x * k) < 0.5 && Math.abs(g.y * k) < 0.5) {
      g.position.set(0, 0);
      g.scale.set(1);
    } else {
      g.position.set(g.x * k, g.y * k);
      g.scale.set(scale);
    }
    return true;
  }

  private setLayer(layer: Layer, map: Map<number, LayerSprite>, i: number, value: number, frame: (v: number) => string): void {
    const entry = map.get(i);
    if (!entry || entry.value === value) return;
    this.input.onLayerHit(layer);
    const { sprite } = entry;
    layerFx(this.kit, layer, sprite.x, sprite.y);
    if (value === 0) {
      map.delete(i);
      void this.scene.tweens
        .run(220, (k) => {
          sprite.scale.set(1 + k * 0.3);
          sprite.alpha = 1 - k;
        }, { ease: Ease.outQuad })
        .then(() => sprite.destroy());
      return;
    }
    entry.value = value;
    sprite.texture = this.atlas.get(frame(value));
    void this.scene.tweens.run(200, (k) => sprite.scale.set(1.15 - 0.15 * k), { ease: Ease.outQuad });
  }

  // ---------- aim ----------

  /** Aims a booster: touching the board shows what it would take, letting go there strikes. Null stops aiming. */
  public aim(booster: Booster | null): void {
    this.aiming = booster;
    perfFlag('aiming', booster !== null);
    this.aimAt = null;
    this.aimDown = false;
    this.drag = null;
    if (booster) {
      this.deselect();
      this.cancelHint();
    }
    this.drawAim();
  }

  private pointAim(pos: Pos | null): void {
    if (pos?.r === this.aimAt?.r && pos?.c === this.aimAt?.c) return;
    this.aimAt = pos;
    this.drawAim();
  }

  /** The cells the booster would take, the aimed one brightest. */
  private drawAim(): void {
    for (const child of this.aimLayer.removeChildren()) child.destroy();
    const b = this.board;
    if (!b || !this.aiming || !this.aimAt) {
      this.scene.request();
      return;
    }
    const at = this.indexOf(this.aimAt);
    for (const i of strikeCells(b, this.aiming, at)) {
      const { r, c } = this.posOf(i);
      const s = this.sprite(FrameName.Aim, r, c);
      s.tint = AIM_TINTS[this.aiming];
      s.blendMode = 'add';
      s.alpha = i === at ? 1 : 0.6;
      this.aimLayer.addChild(s);
    }
    this.scene.request();
  }

  private pulseAim(dt: number): boolean {
    if (this.aimLayer.children.length === 0) return false;
    this.aimClock += dt;
    this.aimLayer.alpha = 0.8 + 0.2 * Math.sin(this.aimClock / AIM_PULSE);
    return true;
  }

  // ---------- hints ----------

  /**
   * Starts the idle timer: a possible move pulses when the player hesitates.
   * A hint already pulsing stays: only a made move (`cancelHint`) stops it.
   */
  public armHint(): void {
    if (this.hinted.length > 0) return;
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => void this.showHint(), HINT_DELAY);
  }

  /** A move is pulsing: a swap made now may just follow it. */
  public get hintShown(): boolean {
    return this.hinted.length > 0;
  }

  /** Call before the board changes under the hinted cells: their sprites return to rest. */
  public cancelHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hintToken++;
    for (const s of this.hintSprites()) s.scale.set(1);
    this.hinted = [];
  }

  private async showHint(): Promise<void> {
    if (!this.board || !this.inputEnabled) return;
    const moves = findMoves(this.board);
    if (moves.length === 0) return;
    const token = ++this.hintToken;
    this.hinted = moves[Math.floor(Math.random() * moves.length)];
    while (token === this.hintToken) {
      await this.scene.tweens.run(700, (k) => {
        if (token !== this.hintToken) return;
        for (const s of this.hintSprites()) s.scale.set(1 + Math.sin(k * Math.PI) * 0.14);
      }, { ease: Ease.linear });
      await this.scene.tweens.wait(500);
    }
  }

  /** Sprites on the hinted cells, minus the selected one: the selection owns its scale. */
  private hintSprites(): Sprite[] {
    const selected = this.selected ? this.indexOf(this.selected) : -1;
    return this.hinted.flatMap((i) => {
      const s = i === selected ? undefined : this.spriteAt(i);
      return s ? [s] : [];
    });
  }

  // ---------- input ----------

  private onDown(e: PointerEvent): void {
    if (!this.inputEnabled) return;
    const pos = this.pointToCell(e);
    if (this.aiming) {
      this.aimDown = true;
      this.pointAim(pos);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (!pos || !this.isFree(pos)) {
      this.deselect();
      return;
    }
    if (this.selected && isAdjacent(this.selected, pos)) {
      const from = this.selected;
      this.deselect();
      this.swap(from, pos, false);
      return;
    }
    this.select(pos);
    this.picks++;
    this.drag = { pos, x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    // A mouse aims by hovering; a finger by touching and sliding.
    if (this.aiming && this.inputEnabled && (this.aimDown || e.pointerType === 'mouse')) this.pointAim(this.pointToCell(e));
    if (!this.drag || !this.inputEnabled) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < this.cell * 0.32) return;
    const from = this.drag.pos;
    const to = Math.abs(dx) > Math.abs(dy) ? { r: from.r, c: from.c + Math.sign(dx) } : { r: from.r + Math.sign(dy), c: from.c };
    this.drag = null;
    this.deselect();
    this.swap(from, to, true);
  }

  /** Letting go over a cell strikes it; anywhere else the aim just waits. */
  private onUp(e: PointerEvent): void {
    this.drag = null;
    if (!this.aiming || !this.aimDown) return;
    this.aimDown = false;
    const pos = this.pointToCell(e);
    if (pos && this.inputEnabled) this.input.onStrike(pos);
    else this.pointAim(null);
  }

  /** Both cells must still be calm: a selection or a drag may have started before a cascade reached them. */
  private swap(from: Pos, to: Pos, drag: boolean): void {
    if (!this.isFree(from) || !this.isFree(to)) return;
    const repicks = Math.max(0, this.picks - 1);
    this.picks = 0;
    this.input.onSwap(from, to, { drag, repicks });
  }

  private isFree(p: Pos): boolean {
    const b = this.board!;
    if (p.r < 0 || p.r >= b.rows || p.c < 0 || p.c >= b.cols) return false;
    const i = this.indexOf(p);
    return this.grid[i] !== null && !this.locked.has(i);
  }

  private pointToCell(e: PointerEvent): Pos | null {
    const b = this.board;
    if (!b) return null;
    const rect = this.canvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - rect.left - this.originX) / this.cell);
    const r = Math.floor((e.clientY - rect.top - this.originY) / this.cell);
    if (r < 0 || r >= b.rows || c < 0 || c >= b.cols || !b.cells[r * b.cols + c].exists) return null;
    return { r, c };
  }

  private select(pos: Pos): void {
    this.deselect();
    this.selected = pos;
    const sprite = this.spriteAt(this.indexOf(pos));
    if (!sprite) return;
    void this.scene.tweens.run(
      110,
      (k) => {
        // Only while this very cell stays selected: a quick re-selection must not leave it enlarged.
        if (this.selected === pos) sprite.scale.set(1 + 0.14 * k);
      },
      { ease: Ease.outQuad },
    );
  }

  private deselect(): void {
    if (this.selected) this.spriteAt(this.indexOf(this.selected))?.scale.set(1);
    this.selected = null;
    this.scene.request();
  }

  // ---------- helpers ----------

  private x(c: number): number {
    return (c + 0.5) * this.cell;
  }

  private y(r: number): number {
    return (r + 0.5) * this.cell;
  }

  private indexOf(p: Pos): number {
    return p.r * this.board!.cols + p.c;
  }

  private posOf(i: number): Pos {
    const cols = this.board!.cols;
    return { r: Math.floor(i / cols), c: i % cols };
  }

  private spriteAt(i: number): Sprite | undefined {
    const piece = this.grid[i];
    return piece ? this.sprites.get(piece.id) : undefined;
  }

  private pieceTexture(piece: Piece): Texture {
    return this.atlas.get(piece.special === Special.Prism ? FrameName.Prism : FrameName.gem(piece.color, piece.special));
  }

  private sprite(frame: string, r: number, c: number): Sprite {
    const s = new Sprite(this.atlas.get(frame));
    s.anchor.set(0.5);
    s.position.set(this.x(c), this.y(r));
    return s;
  }

  private addPiece(piece: Piece, pos: Pos): Sprite {
    const s = new Sprite(this.pieceTexture(piece));
    s.anchor.set(0.5);
    s.position.set(this.x(pos.c), this.y(pos.r));
    this.pieceLayer.addChild(s);
    this.sprites.set(piece.id, s);
    return s;
  }

  private addLayer(map: Map<number, LayerSprite>, layer: Container, i: number, frame: string, value: number): void {
    const { r, c } = this.posOf(i);
    const sprite = this.sprite(frame, r, c);
    layer.addChild(sprite);
    map.set(i, { sprite, value });
  }

  /** Delayed effect; dropped when the board was replaced meanwhile. */
  private after(delay: number, fn: () => void): void {
    const epoch = this.epoch;
    if (delay <= 0) fn();
    else {
      void this.scene.tweens.wait(delay).then(() => {
        if (epoch === this.epoch) fn();
      });
    }
  }
}

function tintOf(color: number): number {
  return color === NO_COLOR ? WHITE : GEM_TINTS[color];
}

/** Color of the piece that left `pos` in this step: a blast takes the color of the special that went off. */
function colorAt(ev: ClearEvent, pos: Pos): number {
  return ev.removed.find((rm) => rm.pos.r === pos.r && rm.pos.c === pos.c)?.color ?? NO_COLOR;
}
