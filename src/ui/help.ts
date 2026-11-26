import { NO_COLOR, Special } from '@/core/types';
import { S } from '@/ui/strings';
import { FrameName } from '@/view/art';

/**
 * «How to play»: every rule shown on little boards of the game's own pieces, looping, with as few words as it takes.
 * A demo is a script of keyframes built by a `Scene` (pure data, testable) and played by Web Animations
 * (transform and opacity only); demos scrolled out of sight pause.
 */

/** Every demo board is this wide; the rows vary. */
const COLS = 5;
const LOOP = 4000;
/** the pieces fade out and back in round the loop's seam, so the jump back to the start is never seen */
const SEAM_MS = 300;
/** a blast reaches cells this much later per cell of distance: the wave of the game */
const WAVE_MS = 45;
const RAY_MS = 120;
const FALL_EASE = 'cubic-bezier(0.55, 0, 1, 0.75)';

/** The usual demo beat: the finger swipes, the pieces swap, the match goes. */
const SWIPE = 900;
const MATCH = SWIPE + 250;
const FALL = MATCH + 450;

export type Cell = readonly [number, number];

interface State {
  r: number;
  c: number;
  s: number;
  sx: number;
  sy: number;
  o: number;
  rot: number;
}

interface Key extends Partial<State> {
  t: number;
  e?: string;
}

const Z = { Tile: 0, Ice: 1, Crate: 2, Gem: 3, Chain: 4, Fx: 5, Finger: 6 } as const;

/** One thing on a demo board: a frame, or a styled box when `look` starts with a dot; w×h cells. */
export class Actor {
  public readonly keys: Key[] = [];
  /** where the actor is after the keys so far: scripts are written in time order */
  public r: number;
  public c: number;

  public constructor(
    public readonly look: string,
    public readonly start: State,
    public readonly z: number,
    public readonly w = 1,
    public readonly h = 1,
    public readonly text = '',
  ) {
    this.r = start.r;
    this.c = start.c;
  }

  /** Holds until `t`, then eases to `to` over `ms`. */
  public tween(t: number, ms: number, to: Partial<State>, e = 'ease-out'): this {
    this.keys.push({ t }, { t: t + ms, ...to, e });
    this.r = to.r ?? this.r;
    this.c = to.c ?? this.c;
    return this;
  }
}

interface Gem {
  a: Actor;
  color: number;
  special: Special;
  /** nothing breaks a pearl: it only falls, and leaves through the bottom */
  pearl?: boolean;
}

interface Layer {
  a: Actor;
  n: number;
}

const SPECIALS: Record<string, Special> = { h: Special.LineH, v: Special.LineV, b: Special.Bomb };

const state = (r: number, c: number, more: Partial<State> = {}): State => ({ r, c, s: 1, sx: 1, sy: 1, o: 1, rot: 0, ...more });
const distance = (a: Cell, b: Cell): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const steps = (a: Cell, b: Cell): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
/** Row-major: the topmost, then leftmost first, the order lit specials go off in. */
const topFirst = (a: Cell, b: Cell): number => a[0] - b[0] || a[1] - b[1];

/**
 * A demo board and its script. The layout is a row per string, a token per cell: a color digit, with `h`, `v` or `b`
 * for a line or bomb special; `P` a prism; `O` a pearl; `x` an empty cell; `_` no cell at all (a row of them is a strip for labels).
 * The builders follow the game's rules (what a match, a blast or a strike does to each layer) and chain.
 */
export class Scene {
  public readonly actors: Actor[] = [];
  public readonly rows: number;
  private readonly gems: (Gem | null)[][];
  private readonly ice = new Map<number, Layer>();
  private readonly crates = new Map<number, Layer>();
  private readonly chains = new Map<number, Actor>();
  /** first board row under the label strip */
  private readonly top: number;
  private spawned = 0;

  public constructor(
    public readonly layout: readonly string[],
    public readonly ms = LOOP,
  ) {
    this.rows = layout.length;
    this.top = layout.findIndex((line) => !line.split(' ').every((t) => t === '_'));
    this.gems = layout.map((line, r) => line.split(' ').map((token, c) => this.parse(token, r, c)));
  }

  // ---------- layers ----------

  public withIce(r: number, c: number, n: number): this {
    this.ice.set(this.key([r, c]), { a: this.add(FrameName.ice(n), state(r, c), Z.Ice), n });
    return this;
  }

  public withCrate(r: number, c: number, n: number): this {
    this.crates.set(this.key([r, c]), { a: this.add(FrameName.crate(n), state(r, c), Z.Crate), n });
    return this;
  }

  public withChain(r: number, c: number): this {
    this.chains.set(this.key([r, c]), this.add(FrameName.chain(1), state(r, c), Z.Chain));
    return this;
  }

  /** The bottom of the pearl's column `c` is marked: the pearl leaves there. */
  public withExit(c: number): this {
    this.add(FrameName.Exit, state(this.rows - 1, c), Z.Ice);
    return this;
  }

  // ---------- the player's hand ----------

  /** The finger drags `a` onto `b`; the pieces swap and land at `t + 60`. */
  public swipe(a: Cell, b: Cell, t: number): this {
    this.finger(a, b, t, 1);
    const x = this.at(a)!;
    const y = this.at(b)!;
    x.a.tween(t - 200, 260, { r: b[0], c: b[1] }, 'ease-in-out');
    y.a.tween(t - 200, 260, { r: a[0], c: a[1] }, 'ease-in-out');
    this.put(a, y);
    this.put(b, x);
    return this;
  }

  /** A swap that makes no match: the pieces go and come back. */
  public refuse(a: Cell, b: Cell, t: number): this {
    this.finger(a, b, t, 1);
    const x = this.at(a)!.a;
    const y = this.at(b)!.a;
    x.tween(t - 200, 260, { r: b[0], c: b[1] }, 'ease-in-out').tween(t + 160, 260, { r: a[0], c: a[1] }, 'ease-in-out');
    y.tween(t - 200, 260, { r: a[0], c: a[1] }, 'ease-in-out').tween(t + 160, 260, { r: b[0], c: b[1] }, 'ease-in-out');
    return this;
  }

  /** A chained piece will not move: it only shakes under the finger. */
  public stuck(a: Cell, b: Cell, t: number): this {
    this.finger(a, b, t, 0.35);
    const shake = (x: Actor): void => {
      for (const [k, dc] of [0.1, -0.1, 0.07, -0.05, 0].entries()) x.tween(t - 150 + k * 60, 60, { c: a[1] + dc }, 'ease-in-out');
    };
    shake(this.at(a)!.a);
    const chain = this.chains.get(this.key(a));
    if (chain) shake(chain);
    return this;
  }

  // ---------- matches ----------

  /**
   * A match clears its cells: a chained piece only loses its chain, any other piece goes (melting a layer of ice)
   * and every crate beside the match cracks once. With `made`, the pieces gather into the special born there.
   */
  public match(cells: Cell[], t: number, made?: { at: Cell; special: Special }): this {
    const color = made ? (made.special === Special.Prism ? NO_COLOR : this.at(made.at)!.color) : NO_COLOR;
    for (const cell of cells) {
      const chain = this.chains.get(this.key(cell));
      if (chain) {
        this.breakChain(cell, t);
        continue;
      }
      if (made) this.merge(cell, made.at, t);
      else this.pop(cell, t);
    }
    const crates = new Set(cells.flatMap((cell) => this.around(cell)).filter((k) => this.crates.has(k)));
    for (const k of crates) this.hitCrate(k, t);
    if (made) this.born(made.at, color, made.special, t + 180);
    return this;
  }

  /** A special goes off: it leaves, and its blast takes its area. */
  public fire(cell: Cell, t: number): this {
    const special = this.at(cell)!.special;
    this.pop(cell, t);
    if (special === Special.LineH) this.rowBlast(cell[0], cell, t);
    if (special === Special.LineV) this.colBlast(cell[1], cell, t);
    if (special === Special.Bomb) this.boom(cell, 1, t);
    return this;
  }

  /** Two swapped specials meet where the finger started and go off together. */
  public gather(center: Cell, other: Cell, t: number): this {
    this.at(other)!.a.tween(t, 160, { r: center[0], c: center[1], s: 0.7 }, 'ease-in').tween(t + 160, 100, { s: 0, o: 0 });
    this.at(center)!.a.tween(t, 160, { s: 1.35 }).tween(t + 160, 100, { s: 0, o: 0 });
    this.put(other, null);
    this.put(center, null);
    this.glow(center, t + 160, 1.4);
    return this;
  }

  // ---------- blasts ----------

  public rowBlast(r: number, origin: Cell, t: number): this {
    this.fx('.fx-beam', state(r, 0, { o: 0, sx: 0 }), COLS, 1)
      .tween(t, 140, { o: 1, sx: 1 })
      .tween(t + 140, 360, { o: 0, sy: 0.3 });
    return this.blast(this.cells().filter(([y]) => y === r), origin, t);
  }

  public colBlast(c: number, origin: Cell, t: number): this {
    this.fx('.fx-beam.v', state(this.top, c, { o: 0, sy: 0 }), 1, this.rows - this.top)
      .tween(t, 140, { o: 1, sy: 1 })
      .tween(t + 140, 360, { o: 0, sx: 0.3 });
    return this.blast(this.cells().filter(([, x]) => x === c), origin, t);
  }

  /** A bomb's square of `radius` round the cell. */
  public boom(cell: Cell, radius: number, t: number): this {
    const side = radius * 2 + 1;
    this.fx('.fx-zone', state(cell[0] - radius, cell[1] - radius, { o: 0, s: 0.3 }), side, side)
      .tween(t, 160, { o: 1, s: 1 })
      .tween(t + 160, 380, { o: 0, s: 1.1 });
    this.shock(cell, t, side);
    return this.blast(this.cells().filter((x) => Math.max(Math.abs(x[0] - cell[0]), Math.abs(x[1] - cell[1])) <= radius), cell, t);
  }

  /** A prism with a plain piece: a ray to every piece of that color, nearest first, and each goes. */
  public wipe(origin: Cell, color: number, t: number): this {
    this.pop(origin, t);
    this.glow(origin, t, 1.2);
    this.targets(origin, color).forEach((cell, k) => {
      const land = this.ray(origin, cell, t + k * 60);
      this.pop(cell, land);
      this.glow(cell, land, 0.8);
    });
    return this;
  }

  /**
   * A prism with a special: rays turn every piece of the special's color into one like it, nearest first,
   * and right after the last turn they go off one by one, the topmost first.
   */
  public spread(origin: Cell, color: number, special: Special, t: number, gap = 300): this {
    this.pop(origin, t);
    this.glow(origin, t, 1.2);
    const targets = this.targets(origin, color);
    let end = t;
    targets.forEach((cell, k) => {
      const land = this.ray(origin, cell, t + k * 90);
      if (this.at(cell)!.special === Special.None) this.turn(cell, special, land);
      end = land + 200;
    });
    [...targets].sort(topFirst).forEach((cell, k) => this.fire(cell, end + k * gap));
    return this;
  }

  /** Two prisms: the whole board goes in one wave. */
  public flood(origin: Cell, t: number): this {
    this.fx('.fx-zone', state(this.top, 0, { o: 0, s: 0.2 }), COLS, this.rows - this.top)
      .tween(t, 300, { o: 1, s: 1 })
      .tween(t + 300, 500, { o: 0, s: 1.05 });
    this.shock(origin, t, COLS * 1.6);
    return this.blast(this.cells(), origin, t + 80);
  }

  /** A booster falls on the cell and breaks every layer in `cells` at once. */
  public strike(frame: string, at: Cell, cells: Cell[], t: number): this {
    this.fx(frame, state(at[0] - 3.5, at[1] + 2.5, { o: 0, s: 1.5 }), 1, 1)
      .tween(t - 450, 100, { o: 1 })
      .tween(t - 350, 350, { r: at[0], c: at[1] }, 'ease-in')
      .tween(t, 160, { o: 0, s: 2.6 });
    this.shock(at, t, 4);
    for (const cell of cells) this.smash(cell, t + steps(cell, at) * WAVE_MS);
    return this;
  }

  // ---------- the board moving ----------

  /** Pieces fall into the gaps; new ones drop in from above where the column is open to the sky. */
  public fall(t: number): this {
    const open: number[] = [];
    for (let c = 0; c < COLS; c++) {
      let write = this.rows - 1;
      for (let r = this.rows - 1; r >= this.top; r--) {
        const gem = this.gems[r][c];
        if (this.fixed([r, c])) write = r - 1;
        else if (gem) {
          if (r !== write) this.drop(gem, r, write, t);
          write--;
        }
      }
      open.push(write);
    }
    open.forEach((last, c) => {
      const n = last - this.top + 1;
      for (let r = last; r >= this.top; r--) {
        const gem = this.addGem(r - n, c, this.spawnColor(r, c), Special.None);
        this.drop(gem, r - n, r, t);
      }
    });
    return this;
  }

  /** Out of moves: every piece flies to a new place. */
  public shuffle(t: number): this {
    const cells = this.cells().filter((cell) => this.at(cell));
    const gems = cells.map((cell) => this.at(cell)!);
    cells.forEach((cell, k) => {
      const gem = gems[(k * 7 + 3) % gems.length];
      gem.a.tween(t, 200, { s: 0.65 }).tween(t + 200, 450, { r: cell[0], c: cell[1] }, 'ease-in-out').tween(t + 650, 200, { s: 1 });
      this.put(cell, gem);
    });
    return this;
  }

  /** A pearl at the bottom leaves through it: it dips through the edge, shrinking and fading, in a glow. */
  public sink(cell: Cell, t: number): this {
    this.at(cell)!.a.tween(t, 300, { r: cell[0] + 0.5, s: 0.45, o: 0 }, 'ease-in');
    this.put(cell, null);
    this.glow([cell[0] + 0.5, cell[1]], t, 1);
    return this;
  }

  /** The piece turns into a special in place. */
  public turn(cell: Cell, special: Special, t: number): this {
    const gem = this.at(cell)!;
    gem.a.tween(t, 120, { o: 0 });
    this.born(cell, gem.color, special, t);
    return this;
  }

  /** A special lights up: it will go off. */
  public light(cell: Cell, t: number): this {
    this.at(cell)!.a.tween(t, 140, { s: 1.25 }).tween(t + 140, 220, { s: 1 });
    this.glow(cell, t, 1.1);
    return this;
  }

  // ---------- words ----------

  /** A word or number pops up over the board and drifts away. */
  public text(cell: Cell, text: string, t: number, w = 1): this {
    this.fx('.fx-text', state(cell[0], cell[1], { o: 0, s: 0.5 }), w, 1, text)
      .tween(t, 160, { o: 1, s: 1.15 })
      .tween(t + 160, 120, { s: 1 })
      .tween(t + 280, 600, { r: cell[0] - 0.4 })
      .tween(t + 880, 200, { o: 0 });
    return this;
  }

  /** A label in the strip, shown from `from` until `to`: a moves counter ticking down is a row of them. */
  public label(cell: Cell, w: number, text: string, from: number, to = Infinity): this {
    const a = this.fx('.fx-chip', state(cell[0], cell[1], { o: from > 0 ? 0 : 1 }), w, 1, text);
    if (from > 0) a.tween(from, 1, { o: 1 });
    if (to < this.ms) a.tween(to, 1, { o: 0 });
    return this;
  }

  // ---------- areas ----------

  public cross(cell: Cell): Cell[] {
    return this.cells().filter((x) => steps(x, cell) <= 1);
  }

  /** The meteor's crater: the 5×5 square without its corners. */
  public crater(cell: Cell): Cell[] {
    return this.cells().filter((x) => Math.max(Math.abs(x[0] - cell[0]), Math.abs(x[1] - cell[1])) <= 2 && steps(x, cell) < 4);
  }

  // ---------- internals ----------

  private parse(token: string, r: number, c: number): Gem | null {
    if (token === '_') return null;
    this.add((r + c) % 2 === 0 ? FrameName.TileA : FrameName.TileB, state(r, c), Z.Tile);
    if (token === 'x') return null;
    if (token === 'P') return this.addGem(r, c, NO_COLOR, Special.Prism);
    if (token === 'O') return { a: this.add(FrameName.Pearl, state(r, c), Z.Gem), color: NO_COLOR, special: Special.None, pearl: true };
    return this.addGem(r, c, Number(token[0]), SPECIALS[token[1]] ?? Special.None);
  }

  private addGem(r: number, c: number, color: number, special: Special, more: Partial<State> = {}): Gem {
    const frame = special === Special.Prism ? FrameName.Prism : FrameName.gem(color, special);
    return { a: this.add(frame, state(r, c, more), Z.Gem), color, special };
  }

  private add(look: string, start: State, z: number, w = 1, h = 1, text = ''): Actor {
    const a = new Actor(look, start, z, w, h, text);
    this.actors.push(a);
    return a;
  }

  private fx(look: string, start: State, w: number, h: number, text = ''): Actor {
    return this.add(look, start, Z.Fx, w, h, text);
  }

  private finger(a: Cell, b: Cell, t: number, reach: number): void {
    const to: Cell = [a[0] + (b[0] - a[0]) * reach, a[1] + (b[1] - a[1]) * reach];
    this.add('.fx-finger', state(a[0], a[1], { o: 0, s: 1.4 }), Z.Finger)
      .tween(t - 520, 180, { o: 1, s: 1 })
      .tween(t - 240, 300, { r: to[0], c: to[1] }, 'ease-in-out')
      .tween(t + 120, 220, { o: 0, s: 1.3 });
  }

  private born(cell: Cell, color: number, special: Special, t: number): void {
    const gem = this.addGem(cell[0], cell[1], color, special, { o: 0, s: 0 });
    gem.a.tween(t, 200, { o: 1, s: 1.3 }).tween(t + 200, 160, { s: 1 });
    this.glow(cell, t, 1.3);
    this.put(cell, gem);
  }

  /** The piece leaves the board; a layer of ice under it melts. */
  private pop(cell: Cell, t: number): void {
    const gem = this.at(cell);
    if (!gem) return;
    gem.a.tween(t, 90, { s: 1.22 }).tween(t + 90, 180, { s: 0, o: 0 }, 'ease-in');
    this.put(cell, null);
    this.melt(cell, t, 1);
  }

  /** The piece slides into the special being made there. */
  private merge(cell: Cell, into: Cell, t: number): void {
    const gem = this.at(cell);
    if (!gem) return;
    gem.a.tween(t, 200, { r: into[0], c: into[1], s: 0.6, o: 0 }, 'ease-in');
    this.put(cell, null);
    this.melt(cell, t, 1);
  }

  /** What a blast does to a cell: a chain breaks, a plain piece goes, a crate cracks; a special waits its own turn. */
  private blast(cells: Cell[], origin: Cell, t: number): this {
    for (const cell of cells) {
      const at = t + steps(cell, origin) * WAVE_MS;
      const gem = this.at(cell);
      if (this.chains.has(this.key(cell))) this.breakChain(cell, at);
      else if (gem && gem.special === Special.None && !gem.pearl) this.pop(cell, at);
      else if (this.crates.has(this.key(cell))) this.hitCrate(this.key(cell), at);
    }
    return this;
  }

  /** A booster's hit: every layer goes at once, chain, crate, piece and all its ice. */
  private smash(cell: Cell, t: number): void {
    const k = this.key(cell);
    if (this.chains.has(k)) this.breakChain(cell, t, false);
    const crate = this.crates.get(k);
    if (crate) this.crack(k, crate, 0, t);
    this.melt(cell, t, Infinity);
    if (!this.at(cell)?.pearl) this.pop(cell, t);
  }

  /** The chain flies off; the piece it held stays, with a little bump unless it goes too. */
  private breakChain(cell: Cell, t: number, bump = true): void {
    const k = this.key(cell);
    this.chains.get(k)!.tween(t, 100, { s: 1.25 }).tween(t + 100, 220, { s: 1.6, o: 0 });
    this.chains.delete(k);
    if (bump) this.at(cell)?.a.tween(t, 120, { s: 1.15 }).tween(t + 120, 160, { s: 1 });
  }

  private hitCrate(k: number, t: number): void {
    const crate = this.crates.get(k)!;
    this.crack(k, crate, crate.n - 1, t);
  }

  /** The crate drops to `n` layers: the old look goes, a weaker one (or nothing) is left. */
  private crack(k: number, crate: Layer, n: number, t: number): void {
    crate.a.tween(t, 80, { s: 1.12 }).tween(t + 80, 200, { s: n > 0 ? 1 : 1.3, o: 0 });
    this.crates.delete(k);
    if (n === 0) return;
    const [r, c] = this.cellOf(k);
    const a = this.add(FrameName.crate(n), state(r, c, { o: 0 }), Z.Crate).tween(t + 60, 160, { o: 1 });
    this.crates.set(k, { a, n });
  }

  private melt(cell: Cell, t: number, layers: number): void {
    const k = this.key(cell);
    const ice = this.ice.get(k);
    if (!ice) return;
    const n = Math.max(0, ice.n - layers);
    ice.a.tween(t, 260, { o: 0, s: n > 0 ? 1 : 1.2 });
    this.ice.delete(k);
    if (n > 0) this.ice.set(k, { a: this.add(FrameName.ice(n), state(cell[0], cell[1], { o: 0 }), Z.Ice).tween(t, 260, { o: 1 }), n });
  }

  private glow(cell: Cell, t: number, size: number): void {
    this.fx(FrameName.Glow, state(cell[0], cell[1], { o: 0, s: 0.5 }), 1, 1)
      .tween(t, 150, { o: 1, s: size * 1.6 })
      .tween(t + 150, 350, { o: 0, s: size * 2.2 });
  }

  private shock(cell: Cell, t: number, size: number): void {
    this.fx(FrameName.Shock, state(cell[0], cell[1], { o: 0, s: 0.4 }), 1, 1)
      .tween(t, 60, { o: 1 })
      .tween(t + 60, 420, { o: 0, s: size * 1.2 });
  }

  /** A ray from the prism to the cell; returns when it lands. */
  private ray(from: Cell, to: Cell, t: number): number {
    const rot = (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI;
    this.fx('.fx-ray', state(from[0], from[1], { o: 0, sx: 0.02, rot }), 1, 1)
      .tween(t, RAY_MS, { o: 1, sx: distance(from, to) * 2 })
      .tween(t + RAY_MS, 260, { o: 0 });
    return t + RAY_MS;
  }

  /** Cells holding a piece of the color, nearest to the origin first. */
  private targets(origin: Cell, color: number): Cell[] {
    return this.cells()
      .filter((cell) => this.at(cell)?.color === color)
      .sort((a, b) => distance(a, origin) - distance(b, origin));
  }

  private drop(gem: Gem, from: number, to: number, t: number): void {
    const c = gem.a.c;
    const ms = 180 + 45 * (to - from);
    gem.a.tween(t, ms, { r: to }, FALL_EASE).tween(t + ms, 120, { sy: 0.88 }).tween(t + ms + 120, 140, { sy: 1 });
    if (from >= this.top) this.put([from, c], null);
    this.put([to, c], gem);
  }

  /** A color that lines up with nothing below or to the left: a refill makes no false matches. */
  private spawnColor(r: number, c: number): number {
    const color = (x: number, y: number): number => this.gems[x]?.[y]?.color ?? -2;
    for (let k = 0; k < 5; k++) {
      const pick = (this.spawned + k) % 5;
      const left = color(r, c - 1) === pick && color(r, c - 2) === pick;
      const sides = color(r, c - 1) === pick && color(r, c + 1) === pick;
      const below = color(r + 1, c) === pick && color(r + 2, c) === pick;
      if (!left && !sides && !below) {
        this.spawned = pick + 2;
        return pick;
      }
    }
    return 0;
  }

  /** A crate or a chained piece holds its cell: nothing falls through it. */
  private fixed(cell: Cell): boolean {
    const k = this.key(cell);
    return this.crates.has(k) || this.chains.has(k);
  }

  private around(cell: Cell): number[] {
    return this.cells()
      .filter((x) => steps(x, cell) === 1)
      .map((x) => this.key(x));
  }

  /** Every board cell, row by row. */
  private cells(): Cell[] {
    const cells: Cell[] = [];
    for (let r = this.top; r < this.rows; r++) for (let c = 0; c < COLS; c++) if (this.layout[r].split(' ')[c] !== '_') cells.push([r, c]);
    return cells;
  }

  private at(cell: Cell): Gem | null {
    return this.gems[cell[0]]?.[cell[1]] ?? null;
  }

  private put(cell: Cell, gem: Gem | null): void {
    this.gems[cell[0]][cell[1]] = gem;
  }

  private key(cell: Cell): number {
    return cell[0] * COLS + cell[1];
  }

  private cellOf(k: number): Cell {
    return [Math.floor(k / COLS), k % COLS];
  }
}

// ---------- the guide ----------

interface Demo {
  caption: string;
  note?: string;
  scene: () => Scene;
}

interface Section {
  title: string;
  hint?: string;
  demos: Demo[];
}

const H = S.help;

export const SECTIONS: Section[] = [
  {
    title: H.move,
    demos: [
      {
        caption: H.swap,
        scene: () => new Scene(['3 2 1 4 0', '1 1 0 3 2', '4 0 3 2 1', '2 3 4 0 3']).swipe([0, 2], [1, 2], SWIPE).match([[1, 0], [1, 1], [1, 2]], MATCH).fall(FALL),
      },
      {
        caption: H.refuse,
        scene: () => new Scene(['2 4 1 3 0', '0 3 2 4 1', '4 1 0 2 3', '3 0 4 1 2']).refuse([1, 1], [1, 2], SWIPE).text([1, 1.5], '✕', SWIPE + 120),
      },
    ],
  },
  {
    title: H.make,
    demos: [
      {
        caption: H.four,
        scene: () =>
          new Scene(['3 0 2 4 1', '2 2 4 2 3', '1 4 3 0 2', '0 3 1 4 0'])
            .swipe([0, 2], [1, 2], SWIPE)
            .match([[1, 0], [1, 1], [1, 2], [1, 3]], MATCH, { at: [1, 2], special: Special.LineV })
            .fall(FALL),
      },
      {
        caption: H.corner,
        scene: () =>
          new Scene(['4 1 3 2 0', '2 4 4 3 1', '4 3 0 1 2', '4 0 1 0 3'])
            .swipe([0, 0], [1, 0], SWIPE)
            .match([[1, 0], [1, 1], [1, 2], [2, 0], [3, 0]], MATCH, { at: [1, 0], special: Special.Bomb })
            .fall(FALL),
      },
      {
        caption: H.square,
        scene: () =>
          new Scene(['2 0 3 5 4', '1 5 5 0 2', '3 5 5 1 0', '0 2 1 4 3'])
            .swipe([0, 3], [1, 3], SWIPE)
            .match([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]], MATCH, { at: [1, 3], special: Special.Bomb })
            .fall(FALL),
      },
      {
        caption: H.five,
        scene: () =>
          new Scene(['0 4 3 1 2', '3 3 1 3 3', '2 1 4 0 4', '4 0 2 1 0'])
            .swipe([0, 2], [1, 2], SWIPE)
            .match([[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]], MATCH, { at: [1, 2], special: Special.Prism })
            .fall(FALL),
      },
    ],
  },
  {
    title: H.use,
    demos: [
      {
        caption: H.lineH,
        scene: () =>
          new Scene(['3 0 4 1 2', '1 4 2h 0 3', '0 1 2 3 4', '4 3 1 2 0'])
            .swipe([3, 3], [3, 2], SWIPE)
            .match([[2, 2], [3, 2]], MATCH)
            .fire([1, 2], MATCH)
            .fall(FALL + 250),
      },
      {
        caption: H.lineV,
        scene: () =>
          new Scene(['2 4 0 3 1', '3 0 4 1 2', '4 1 1v 0 3', '0 3 2 4 1'])
            .swipe([1, 3], [2, 3], SWIPE)
            .match([[2, 1], [2, 3]], MATCH)
            .fire([2, 2], MATCH)
            .fall(FALL + 250),
      },
      {
        caption: H.bomb,
        scene: () =>
          new Scene(['1 3 0 2 4', '2 0 4 1 3', '4 1 3b 0 2', '0 2 3 4 1', '1 4 2 3 0'])
            .swipe([4, 3], [4, 2], SWIPE)
            .match([[3, 2], [4, 2]], MATCH)
            .fire([2, 2], MATCH)
            .fall(FALL + 250),
      },
      {
        caption: H.prism,
        scene: () =>
          new Scene(['2 0 1 4 3', '0 3 P 0 0', '1 0 2 3 1', '3 4 0 2 4'])
            .swipe([1, 2], [1, 3], SWIPE)
            .wipe([1, 3], 0, MATCH)
            .fall(MATCH + 900),
      },
    ],
  },
  {
    title: H.combos,
    hint: H.combosHint,
    demos: [
      {
        caption: H.lineLine,
        scene: () =>
          new Scene(['1 3 0 2 4', '2 0 4 1 3', '4 1h 3v 0 2', '0 2 1 4 1', '3 4 2 3 0'])
            .swipe([2, 2], [2, 1], SWIPE)
            .gather([2, 2], [2, 1], MATCH - 100)
            .rowBlast(2, [2, 2], MATCH + 100)
            .colBlast(2, [2, 2], MATCH + 100)
            .fall(FALL + 300),
      },
      {
        caption: H.lineBomb,
        scene: () => {
          const scene = new Scene(['1 3 0 2 4', '2 0 4 1 3', '4 1b 3h 0 2', '0 2 1 4 1', '3 4 2 3 0'])
            .swipe([2, 2], [2, 1], SWIPE)
            .gather([2, 2], [2, 1], MATCH - 100);
          for (const k of [1, 2, 3]) scene.rowBlast(k, [2, 2], MATCH + 100).colBlast(k, [2, 2], MATCH + 100);
          return scene.fall(FALL + 350);
        },
      },
      {
        caption: H.bombBomb,
        scene: () =>
          new Scene(['1 3 0 2 4', '2 0 4 1 3', '4 1b 3b 0 2', '0 2 1 4 1', '3 4 2 3 0'])
            .swipe([2, 1], [2, 2], SWIPE)
            .gather([2, 1], [2, 2], MATCH - 100)
            .boom([2, 1], 2, MATCH + 100)
            .fall(FALL + 350),
      },
      {
        caption: H.prismSpecial,
        scene: () =>
          new Scene(['1 0 3 4 2', '3 4 0 2 1', '0 2 P 1b 3', '4 1 3 0 4', '2 3 4 1 0'], 5600)
            .swipe([2, 2], [2, 3], SWIPE)
            .spread([2, 3], 1, Special.Bomb, MATCH)
            .fall(4200),
      },
      {
        caption: H.prismPrism,
        scene: () =>
          new Scene(['2 0 1 4 3', '0 3 P P 0', '1 0 2 3 1', '3 4 0 2 4'])
            .swipe([1, 2], [1, 3], SWIPE)
            .gather([1, 2], [1, 3], MATCH - 100)
            .flood([1, 2], MATCH + 100)
            .fall(FALL + 450),
      },
    ],
  },
  {
    title: H.blockers,
    demos: [
      {
        caption: H.ice,
        scene: () =>
          new Scene(['3 0 4 2 1', '2 4 0 1 3', '0 1 1 3 4', '4 3 2 0 1'])
            .withIce(2, 1, 1)
            .withIce(2, 2, 2)
            .withIce(2, 3, 1)
            .swipe([1, 3], [2, 3], SWIPE)
            .match([[2, 1], [2, 2], [2, 3]], MATCH)
            .fall(FALL),
      },
      {
        caption: H.crate,
        scene: () =>
          new Scene(['3 0 4 2 1', '2 4 0 1 3', '0 1 1 3 4', '4 x x x 1'])
            .withCrate(3, 1, 1)
            .withCrate(3, 2, 2)
            .withCrate(3, 3, 3)
            .swipe([1, 3], [2, 3], SWIPE)
            .match([[2, 1], [2, 2], [2, 3]], MATCH)
            .fall(FALL),
      },
      {
        caption: H.chain,
        scene: () =>
          new Scene(['3 0 4 2 1', '2 4 0 1 3', '0 1 1 3 4', '4 3 2 0 1'], 4600)
            .withChain(2, 2)
            .stuck([2, 2], [3, 2], 800)
            .swipe([1, 3], [2, 3], 2100)
            .match([[2, 1], [2, 2], [2, 3]], 2350)
            .fall(2800),
      },
    ],
  },
  {
    title: H.pearls,
    hint: H.pearlsHint,
    demos: [
      {
        caption: H.pearl,
        scene: () =>
          new Scene(['3 0 O 2 1', '2 4 1 0 3', '0 3 4 1 4', '4 0 1 3 2'])
            .withExit(2)
            .swipe([2, 3], [2, 2], SWIPE)
            .match([[1, 2], [2, 2], [3, 2]], MATCH)
            .fall(FALL)
            .sink([3, 2], FALL + 650)
            .fall(FALL + 950),
      },
    ],
  },
  {
    title: H.boosters,
    hint: H.boostersHint,
    demos: [
      {
        caption: S.boosterNames.star,
        note: S.boosterHint.star,
        scene: () => {
          const scene = new Scene(['3 0 4 2 1', '2 4 x 1 3', '0 1 2 3 4', '4 3 1 0 1']).withCrate(1, 2, 3).withChain(2, 3);
          return scene.strike(FrameName.FallingStar, [2, 2], scene.cross([2, 2]), 1100).fall(1700);
        },
      },
      {
        caption: S.boosterNames.meteor,
        note: S.boosterHint.meteor,
        scene: () => {
          const scene = new Scene(['1 3 0 2 4', '2 0 x 1 3', '4 1 3 0 2', '0 2 1 4 1', '3 4 2 3 0'])
            .withCrate(1, 2, 3)
            .withChain(2, 1)
            .withIce(3, 2, 2);
          return scene.strike(FrameName.Meteor, [2, 2], scene.crater([2, 2]), 1100).fall(1800);
        },
      },
    ],
  },
  {
    title: H.more,
    demos: [
      {
        caption: H.cascade,
        scene: () =>
          new Scene(['2 3 0 1 3', '0 4 4 2 1', '1 1 0 4 3', '3 2 1 0 2'])
            .swipe([3, 2], [2, 2], SWIPE)
            .match([[2, 0], [2, 1], [2, 2]], MATCH)
            .fall(FALL)
            .match([[2, 1], [2, 2], [2, 3]], FALL + 550)
            .text([2, 2], '×2', FALL + 550)
            .fall(FALL + 1000),
      },
      {
        caption: H.finale,
        scene: () => {
          const scene = new Scene(['_ _ _ _ _', '3 0 4 2 1', '2 4 0 1 3', '0 1 2 3 4', '4 3 1 0 2'], 4400);
          [3, 2, 1, 0].forEach((n, k) => scene.label([0, 1], 3, `${S.moves} ${n}`, k === 0 ? 0 : 400 + k * 350, k === 3 ? Infinity : 750 + k * 350));
          return scene
            .turn([2, 1], Special.LineH, 750)
            .turn([4, 3], Special.LineV, 1100)
            .turn([1, 4], Special.LineH, 1450)
            .fire([1, 4], 2000)
            .fire([2, 1], 2350)
            .fire([4, 3], 2700);
        },
      },
      {
        caption: H.lastChance,
        scene: () =>
          new Scene(['_ _ _ _ _', '3 0 4 2 1', '2 4b 0 1 3', '0 1 2 3v 4', '4 3 1 0 2'])
            .label([0, 1], 3, `${S.moves} 0`, 0)
            .light([2, 1], 800)
            .light([3, 3], 800)
            .fire([2, 1], 1400)
            .fire([3, 3], 1800),
      },
      {
        caption: H.shuffle,
        scene: () => new Scene(['2 4 1 3 0', '0 3 2 4 1', '4 1 0 2 3']).shuffle(1100).text([1, 1.5], '⟳', 900, 2),
      },
    ],
  },
];

// ---------- playback ----------

type Icon = (frame: string) => string;

/** The guide's sections; each demo is an empty figure until `playHelp` fills it. */
export function helpHtml(icon: Icon): string {
  const goal = (img: string, word: string): string => `<div class="help-goal">${img}<span>${word}</span></div>`;
  const goals =
    goal(`<img src="${icon(FrameName.gem(3, Special.None))}" alt="">`, H.goalWords.collect) +
    goal(`<img src="${icon(FrameName.ice(1))}" alt="">`, H.goalWords.ice) +
    goal(`<img src="${icon(FrameName.crate(3))}" alt="">`, H.goalWords.crate) +
    goal(`<img src="${icon(FrameName.Pearl)}" alt="">`, H.goalWords.pearl) +
    goal('<b class="score-icon">★</b>', H.goalWords.score);
  const sections = SECTIONS.map(
    (s, k) =>
      `<h3>${s.title}</h3>${s.hint ? `<p class="hint">${s.hint}</p>` : ''}<div class="help-grid">${s.demos
        .map((d, j) => `<figure class="demo" data-demo="${k}-${j}"><figcaption>${d.caption}${d.note ? `<small>${d.note}</small>` : ''}</figcaption></figure>`)
        .join('')}</div>`,
  ).join('');
  return `<h3>${H.goals}</h3><div class="help-goals">${goals}</div><p class="hint">${H.goalsHint}</p>${sections}`;
}

/** Fills every demo figure under `root` and plays those in sight. Returns a stop. */
export function playHelp(root: HTMLElement, icon: Icon): () => void {
  const playing = new Map<Element, Animation[]>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        for (const anim of playing.get(entry.target) ?? []) {
          if (entry.isIntersecting) anim.play();
          else anim.pause();
        }
      }
    },
    { root },
  );
  for (const figure of root.querySelectorAll<HTMLElement>('.demo')) {
    const [k, j] = figure.dataset.demo!.split('-').map(Number);
    playing.set(figure, mount(figure, SECTIONS[k].demos[j].scene(), icon));
    observer.observe(figure);
  }
  return () => observer.disconnect();
}

function mount(figure: HTMLElement, scene: Scene, icon: Icon): Animation[] {
  const stage = document.createElement('div');
  stage.className = 'demo-stage';
  stage.style.setProperty('--rows', String(scene.rows));
  const layer = document.createElement('div');
  layer.className = 'demo-layer';
  const anims: Animation[] = [];
  for (const a of [...scene.actors].sort((x, y) => x.z - y.z)) {
    const el = a.look.startsWith('.') ? document.createElement('div') : document.createElement('img');
    if (el instanceof HTMLImageElement) {
      el.src = icon(a.look);
      el.alt = '';
    } else {
      el.className = a.look.slice(1).replaceAll('.', ' ');
      el.textContent = a.text;
    }
    el.style.width = `${(a.w * 100) / COLS}%`;
    el.style.height = `${(a.h * 100) / scene.rows}%`;
    if (a.keys.length === 0) {
      el.style.transform = transform(a, a.start);
      el.style.opacity = String(a.start.o);
    } else {
      anims.push(el.animate(keyframes(a, scene.ms), { duration: scene.ms, iterations: Infinity }));
    }
    (a.z === Z.Tile ? stage : layer).append(el);
  }
  const seam = SEAM_MS / scene.ms;
  anims.push(layer.animate([{ opacity: 0 }, { offset: seam, opacity: 1 }, { offset: 1 - seam, opacity: 1 }, { opacity: 0 }], { duration: scene.ms, iterations: Infinity }));
  stage.append(layer);
  figure.prepend(stage);
  for (const anim of anims) anim.pause();
  return anims;
}

/** Keys in time order, each carrying what it does not change over from the one before. */
function keyframes(a: Actor, ms: number): Keyframe[] {
  let s = a.start;
  const frames: Keyframe[] = [frame(a, s, 0)];
  for (const key of [...a.keys].sort((x, y) => x.t - y.t)) {
    const { t, e, ...to } = key;
    frames[frames.length - 1].easing = e ?? 'linear';
    s = { ...s, ...to };
    frames.push(frame(a, s, Math.min(1, t / ms)));
  }
  frames.push(frame(a, s, 1));
  return frames;
}

function frame(a: Actor, s: State, offset: number): Keyframe {
  return { offset, opacity: s.o, transform: transform(a, s) };
}

function transform(a: Actor, s: State): string {
  return `translate(${(s.c / a.w) * 100}%, ${(s.r / a.h) * 100}%) rotate(${s.rot}deg) scale(${s.s * s.sx}, ${s.s * s.sy})`;
}
