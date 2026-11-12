import 'pixi.js/text-bitmap';
import { BitmapFont, BitmapText, Container, Sprite, type Texture } from 'pixi.js';
import { isAdjacent } from '@/core/board';
import { findMoves } from '@/core/moves';
import { type Blast, BlastKind, type Board, type GameEvent, NO_COLOR, type Piece, type Pos, Special, type SwapEvent } from '@/core/types';
import { FrameName, GEM_TINTS } from '@/view/art';
import { Atlas } from '@/view/atlas';
import { Particles } from '@/view/particles';
import type { Scene } from '@/view/scene';
import { Ease } from '@/view/tween';

type ClearEvent = Extract<GameEvent, { type: 'clear' }>;
type FallEvent = Extract<GameEvent, { type: 'fall' }>;
type PiecesEvent = Extract<GameEvent, { type: 'transform' | 'shuffle' }>;

/** Delay between playback "waves" inside one clear step (special chains fire one after another). */
const ORDER_STEP = 70;
const MAX_CELL = 84;
const HINT_DELAY = 5000;
const SCORE_FONT = 'gf-score';
const WHITE = 0xffffff;
const ICE_TINT = 0xbfe8ff;
const CRATE_TINT = 0xc98a4b;
const CHAIN_TINT = 0xd7dde8;

export type Layer = 'ice' | 'crate' | 'chain';

export interface BoardListener {
  onSwap(a: Pos, b: Pos): void;
  /** a blocker layer visibly took a hit (for sound) */
  onLayerHit(layer: Layer): void;
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
  private reducedMotion = false;
  /** player's board size setting, applied to the cell that fits */
  private scale = 1;
  private readonly atlas = new Atlas();
  private readonly boardRoot = new Container();
  private readonly tiles = new Container();
  private readonly iceLayer = new Container();
  private readonly pieceLayer = new Container();
  private readonly crateLayer = new Container();
  private readonly chainLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly textLayer = new Container();
  private readonly particles: Particles;
  private readonly sprites = new Map<number, Sprite>();
  private readonly ice = new Map<number, LayerSprite>();
  private readonly crates = new Map<number, LayerSprite>();
  private readonly chains = new Map<number, LayerSprite>();
  private readonly popupPool: BitmapText[] = [];
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
  private hintTimer = 0;
  private hintToken = 0;
  private hinted: Sprite[] = [];
  /** cells being animated; the player can grab only the rest, so moves are possible during a cascade */
  private readonly locked = new Set<number>();
  /** bumped when the board is replaced or removed: playback still in flight stops */
  private epoch = 0;

  public constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly input: BoardListener,
  ) {
    this.boardRoot.addChild(this.tiles, this.iceLayer, this.pieceLayer, this.crateLayer, this.chainLayer, this.fxLayer, this.textLayer);
    scene.root.addChild(this.boardRoot);
    this.particles = new Particles(this.fxLayer, () => scene.request());
    scene.addUpdater((dt) => this.particles.update(dt));
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
    canvas.addEventListener('pointerup', () => (this.drag = null));
    canvas.addEventListener('pointercancel', () => (this.drag = null));
  }

  // ---------- setup ----------

  public setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.particles.density = this.scene.particleDensity * (on ? 0.5 : 1);
  }

  /** The atlas is repainted for the new cell size, so a smaller board stays sharp. */
  public setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.layout(this.width, this.height);
  }

  public setBoard(board: Board): void {
    this.epoch++;
    this.locked.clear();
    this.board = board;
    this.grid = board.cells.map((c) => c.piece);
    this.deselect();
    this.layout(this.width, this.height, true);
  }

  /** Removes the board from the screen (menus show the bare background). */
  public clear(): void {
    this.epoch++;
    this.locked.clear();
    this.wipe();
    this.board = null;
    this.grid = [];
    this.scene.request();
  }

  /** Destroys every sprite; running animations jump to their end first. */
  private wipe(): void {
    this.scene.tweens.finishAll();
    this.cancelHint();
    this.particles.clear();
    for (const layer of [this.tiles, this.iceLayer, this.pieceLayer, this.crateLayer, this.chainLayer, this.fxLayer]) {
      for (const child of layer.removeChildren()) child.destroy();
    }
    this.sprites.clear();
    this.ice.clear();
    this.crates.clear();
    this.chains.clear();
    this.selected = null;
  }

  /** Fits the board into the canvas area (CSS pixels). */
  public layout(width: number, height: number, forceRebuild = false): void {
    this.width = width;
    this.height = height;
    const b = this.board;
    if (!b) return;
    const cell = Math.max(16, Math.floor(Math.min(width / b.cols, height / b.rows, MAX_CELL) * this.scale));
    this.cell = cell;
    this.originX = Math.round((width - cell * b.cols) / 2);
    this.originY = Math.round((height - cell * b.rows) / 2);
    this.boardRoot.position.set(this.originX, this.originY);
    this.particles.density = this.scene.particleDensity * (this.reducedMotion ? 0.5 : 1);
    if (this.atlas.build(cell, this.scene.resolution) || forceRebuild) this.rebuild();
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
          .then(() => this.land(sprite)),
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
    const move = (k: number): void => {
      sa.position.set(ax + (bx - ax) * k, ay + (by - ay) * k);
      sb.position.set(bx + (ax - bx) * k, by + (ay - by) * k);
    };
    if (ev.valid) {
      [this.grid[ia], this.grid[ib]] = [this.grid[ib], this.grid[ia]];
      await this.scene.tweens.run(150, move, { ease: Ease.outQuad });
      return;
    }
    await this.scene.tweens.run(130, move, { ease: Ease.outQuad });
    await this.scene.tweens.run(170, (k) => move(1 - k), { ease: Ease.outBack });
  }

  private async playClear(ev: ClearEvent): Promise<void> {
    const createdAt = new Map(ev.created.map((c) => [c.piece.id, c.pos]));
    let end = 0;

    for (const blast of ev.blasts) {
      const delay = blast.order * ORDER_STEP;
      this.after(delay, () => this.blastFx(blast));
      end = Math.max(end, delay + 180);
    }

    for (const rm of ev.removed) {
      const i = this.indexOf(rm.pos);
      if (this.grid[i]?.id === rm.id) this.grid[i] = null;
      const sprite = this.sprites.get(rm.id);
      if (!sprite) continue;
      this.sprites.delete(rm.id);
      const delay = rm.order * ORDER_STEP;
      const target = rm.mergeInto >= 0 ? createdAt.get(rm.mergeInto) : undefined;
      if (target) {
        const [sx, sy, tx, ty] = [sprite.x, sprite.y, this.x(target.c), this.y(target.r)];
        void this.scene.tweens
          .run(
            140,
            (k) => {
              sprite.position.set(sx + (tx - sx) * k, sy + (ty - sy) * k);
              sprite.scale.set(1 - k * 0.4);
            },
            { delay, ease: Ease.inQuad },
          )
          .then(() => sprite.destroy());
        end = Math.max(end, delay + 140);
      } else {
        this.pop(sprite, rm.color, delay);
        end = Math.max(end, delay + 170);
      }
    }

    for (const c of ev.created) {
      this.grid[this.indexOf(c.pos)] = c.piece;
      const sprite = this.addPiece(c.piece, c.pos);
      sprite.scale.set(0);
      void this.scene.tweens.run(220, (k) => sprite.scale.set(k), { delay: 140, ease: Ease.outBack });
      this.after(140, () => this.flash(this.x(c.pos.c), this.y(c.pos.r), 1.6));
      end = Math.max(end, 360);
    }

    for (const l of ev.layers) {
      const i = this.indexOf(l.pos);
      this.after(l.order * ORDER_STEP + 60, () => {
        this.setLayer('ice', this.ice, i, l.ice, FrameName.ice, ICE_TINT);
        this.setLayer('crate', this.crates, i, l.crate, FrameName.crate, CRATE_TINT);
        this.setLayer('chain', this.chains, i, l.chain, FrameName.chain, CHAIN_TINT);
      });
    }

    for (const p of ev.popups) this.after(p.order * ORDER_STEP, () => this.popup(p.r, p.c, p.value));

    await this.scene.tweens.wait(end);
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
          { ease: Ease.inQuad },
        )
        .then(() => this.land(sprite));
      end = Math.max(end, duration);
    }
    await this.scene.tweens.wait(end + 40);
  }

  private async playTransform(ev: PiecesEvent): Promise<void> {
    const jobs = ev.pieces.map((p, k) => {
      const sprite = this.sprites.get(p.piece.id);
      if (!sprite) return Promise.resolve();
      return this.scene.tweens.wait(k * 45).then(() => {
        sprite.texture = this.pieceTexture(p.piece);
        this.flash(sprite.x, sprite.y, 1.4);
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

  private blastFx(blast: Blast): void {
    const ox = this.x(blast.origin.c);
    const oy = this.y(blast.origin.r);
    const b = this.board!;
    switch (blast.kind) {
      case BlastKind.Row:
      case BlastKind.Col: {
        const vertical = blast.kind === BlastKind.Col;
        const beam = this.fxSprite(FrameName.Beam, vertical ? ox : (b.cols * this.cell) / 2, vertical ? (b.rows * this.cell) / 2 : oy);
        beam.rotation = vertical ? Math.PI / 2 : 0;
        const length = ((vertical ? b.rows : b.cols) + 1) * this.cell;
        beam.width = length;
        this.animateFx(beam, 280, (k) => {
          beam.scale.y = Math.sin(k * Math.PI) * 1.1;
          beam.alpha = 1 - k * k;
        });
        this.flash(ox, oy, 1.8);
        break;
      }
      case BlastKind.Bomb: {
        const radius = Math.max(...blast.cells.map((p) => Math.abs(p.r - blast.origin.r)), 1);
        const ring = this.fxSprite(FrameName.Ring, ox, oy);
        this.animateFx(ring, 340, (k) => {
          ring.scale.set(0.5 + k * (radius * 2 + 1) * 0.9);
          ring.alpha = 1 - k;
        });
        this.flash(ox, oy, radius * 2.6);
        this.shake(this.cell * 0.1 * radius);
        break;
      }
      case BlastKind.Prism: {
        const tint = blast.color >= 0 ? GEM_TINTS[blast.color] : WHITE;
        const ring = this.fxSprite(FrameName.Ring, ox, oy);
        ring.tint = tint;
        this.animateFx(ring, 420, (k) => {
          ring.scale.set(0.6 + k * 4);
          ring.alpha = 1 - k;
        });
        for (const p of blast.cells.slice(0, 40)) {
          const dot = this.fxSprite(FrameName.Dot, ox, oy);
          dot.tint = tint;
          dot.scale.set(0.45);
          const [tx, ty] = [this.x(p.c), this.y(p.r)];
          this.animateFx(dot, 200, (k) => {
            dot.position.set(ox + (tx - ox) * k, oy + (ty - oy) * k);
            dot.alpha = 1 - k * 0.5;
          });
        }
        this.shake(this.cell * 0.08);
        break;
      }
      case BlastKind.Spark: {
        this.flash(ox, oy, 1.4);
        const target = blast.target;
        if (!target) break;
        const star = this.fxSprite(FrameName.Star, ox, oy);
        star.scale.set(0.7);
        const [tx, ty] = [this.x(target.c), this.y(target.r)];
        const lift = this.cell * 1.2;
        this.animateFx(star, 260, (k) => {
          star.position.set(ox + (tx - ox) * k, oy + (ty - oy) * k - Math.sin(k * Math.PI) * lift);
          star.rotation = k * 6;
        });
        this.after(260, () => this.flash(tx, ty, 1.8));
        break;
      }
    }
  }

  private pop(sprite: Sprite, color: number, delay: number): void {
    this.after(delay, () => {
      const texture = this.atlas.get(FrameName.Dot);
      const tint = color === NO_COLOR ? WHITE : GEM_TINTS[color];
      this.particles.burst(sprite.x, sprite.y, texture, tint, { count: 7, speed: this.cell * 3.2, size: 0.3, life: 480 });
      this.particles.burst(sprite.x, sprite.y, this.atlas.get(FrameName.Star), WHITE, { count: 2, speed: this.cell * 2, size: 0.35, life: 420 });
    });
    void this.scene.tweens
      .run(
        170,
        (k) => {
          sprite.scale.set(k < 0.3 ? 1 + (k / 0.3) * 0.2 : 1.2 * (1 - (k - 0.3) / 0.7));
          sprite.alpha = 1 - Math.max(0, (k - 0.5) * 2);
        },
        { delay, ease: Ease.linear },
      )
      .then(() => sprite.destroy());
  }

  private flash(x: number, y: number, size: number): void {
    const glow = this.fxSprite(FrameName.Glow, x, y);
    this.animateFx(glow, 260, (k) => {
      glow.scale.set(size * (0.6 + k * 0.6));
      glow.alpha = 1 - k;
    });
  }

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

  private shake(power: number): void {
    if (this.reducedMotion) return;
    void this.scene.tweens.run(
      260,
      (k) => {
        const p = power * (1 - k);
        this.boardRoot.position.set(this.originX + (Math.random() - 0.5) * 2 * p, this.originY + (Math.random() - 0.5) * 2 * p);
        if (k >= 1) this.boardRoot.position.set(this.originX, this.originY);
      },
      { ease: Ease.linear },
    );
  }

  private land(sprite: Sprite): void {
    if (sprite.destroyed) return;
    void this.scene.tweens.run(
      130,
      (k) => {
        if (sprite.destroyed) return;
        const squash = Math.sin(k * Math.PI) * 0.14;
        sprite.scale.set(1 + squash, 1 - squash);
      },
      { ease: Ease.linear },
    );
  }

  private setLayer(
    layer: Layer,
    map: Map<number, LayerSprite>,
    i: number,
    value: number,
    frame: (v: number) => string,
    tint: number,
  ): void {
    const entry = map.get(i);
    if (!entry || entry.value === value) return;
    this.input.onLayerHit(layer);
    const { sprite } = entry;
    this.particles.burst(sprite.x, sprite.y, this.atlas.get(FrameName.Star), tint, { count: 6, speed: this.cell * 2.6, size: 0.3, life: 520 });
    if (value === 0) {
      map.delete(i);
      this.animateFx(sprite, 220, (k) => {
        sprite.scale.set(1 + k * 0.3);
        sprite.alpha = 1 - k;
      });
      return;
    }
    entry.value = value;
    sprite.texture = this.atlas.get(frame(value));
    void this.scene.tweens.run(200, (k) => sprite.scale.set(1.15 - 0.15 * k), { ease: Ease.outQuad });
  }

  // ---------- hints ----------

  /** Starts the idle timer; a possible move pulses when the player hesitates. */
  public armHint(): void {
    this.cancelHint();
    this.hintTimer = window.setTimeout(() => void this.showHint(), HINT_DELAY);
  }

  public cancelHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hintToken++;
    for (const sprite of this.hinted) if (!sprite.destroyed) sprite.scale.set(1);
    this.hinted = [];
  }

  private async showHint(): Promise<void> {
    if (!this.board || !this.inputEnabled) return;
    const moves = findMoves(this.board);
    if (moves.length === 0) return;
    const [i, j] = moves[Math.floor(Math.random() * moves.length)];
    const sprites = [this.spriteAt(i), this.spriteAt(j)].filter((s): s is Sprite => s !== undefined);
    const token = ++this.hintToken;
    this.hinted = sprites;
    while (token === this.hintToken) {
      await this.scene.tweens.run(700, (k) => {
        if (token !== this.hintToken) return;
        for (const s of sprites) if (!s.destroyed) s.scale.set(1 + Math.sin(k * Math.PI) * 0.14);
      }, { ease: Ease.linear });
      await this.scene.tweens.wait(500);
    }
  }

  // ---------- input ----------

  private onDown(e: PointerEvent): void {
    if (!this.inputEnabled) return;
    const pos = this.pointToCell(e);
    if (!pos || !this.isFree(pos)) {
      this.deselect();
      return;
    }
    this.cancelHint();
    if (this.selected && isAdjacent(this.selected, pos)) {
      const from = this.selected;
      this.deselect();
      this.swap(from, pos);
      return;
    }
    this.select(pos);
    this.drag = { pos, x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag || !this.inputEnabled) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < this.cell * 0.32) return;
    const from = this.drag.pos;
    const to = Math.abs(dx) > Math.abs(dy) ? { r: from.r, c: from.c + Math.sign(dx) } : { r: from.r + Math.sign(dy), c: from.c };
    this.drag = null;
    this.deselect();
    this.swap(from, to);
  }

  /** Both cells must still be calm: a selection or a drag may have started before a cascade reached them. */
  private swap(from: Pos, to: Pos): void {
    if (this.isFree(from) && this.isFree(to)) this.input.onSwap(from, to);
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

  private fxSprite(frame: string, x: number, y: number): Sprite {
    const s = new Sprite(this.atlas.get(frame));
    s.anchor.set(0.5);
    s.position.set(x, y);
    s.blendMode = 'add';
    this.fxLayer.addChild(s);
    return s;
  }

  private animateFx(sprite: Sprite, duration: number, update: (k: number) => void): void {
    void this.scene.tweens.run(duration, update, { ease: Ease.outQuad }).then(() => sprite.destroy());
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
