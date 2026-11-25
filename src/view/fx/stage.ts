import type { Container, Sprite, Texture } from 'pixi.js';
import { type Blast, BlastKind, NO_COLOR, type Pos } from '@/core/types';
import { CHAIN_BITS, CRATE_BITS, CRATE_PIECES, type Fragment, FrameName } from '@/view/art';
import { Burst } from '@/view/fx/bursts';
import type { Camera } from '@/view/fx/camera';
import { bombRadius } from '@/view/fx/impact';
import type { SpritePool } from '@/view/fx/pool';
import { Fx } from '@/view/fx/switches';
import { Timing } from '@/view/fx/timeline';
import type { Particles } from '@/view/particles';
import { Ease, type EaseFn, type Tweens } from '@/view/tween';

export const WHITE = 0xffffff;
/** the pearly light of a pearl arriving and leaving */
export const PEARL_GLOW = 0xffe4ff;
/** a pearl leaving through the bottom takes this long */
export const SINK_MS = 340;

export type Layer = 'ice' | 'crate' | 'chain';

const LAYER_TINTS: Record<Layer, number> = { ice: 0xbfe8ff, crate: 0xc98a4b, chain: 0xd7dde8 };
const DUST_TINTS: Record<Layer, number> = { ice: 0xe6f6ff, crate: 0xd9b48a, chain: 0xaab2bf };

/** a beam fades out this long once it reached the edge */
const BEAM_FADE = 220;
/** a beam's head and a falling booster leave a trail puff every this many cells */
const TRAIL_STEP = 0.35;
const STAR_GOLD = 0xffd25e;
const FIRE = 0xff7a2a;
const EMBER = 0xffc061;
const SOOT = 0x3a2a26;
/** a prism throws at most this many rays: a whole-board wipe would otherwise draw a hedgehog */
const MAX_BOLTS = 36;
/** a hit piece swells, then breaks: particles fly at the break */
const POP_MS = 140;
const POP_BREAK = 0.3;

/**
 * How broken bits fly: kicked out at `kick` cells/s (each one 0.6–1.4 of it), up at `lift`, tumbling at up to
 * `spin` rad/s either way, falling at `gravity` cells/s² for about `ms`, fading over the last share `fade`.
 */
interface Flight {
  kick: number;
  lift: number;
  spin: number;
  gravity: number;
  ms: number;
  fade: number;
}

const CHAIN_FLIGHT: Flight = { kick: 2.6, lift: 1.6, spin: 7, gravity: 16, ms: 700, fade: 0.4 };
const CRATE_BIT_FLIGHT: Flight = { kick: 2.8, lift: 2.4, spin: 9, gravity: 18, ms: 620, fade: 0.4 };
const CRATE_FLIGHT: Flight = { kick: 2.2, lift: 2.6, spin: 6, gravity: 17, ms: 760, fade: 0.35 };

/** What an effect may use of the board: coordinates, frames, layers and the tools that animate them. */
export interface FxKit {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  x(c: number): number;
  y(r: number): number;
  texture(name: string): Texture;
  /** additive layer over the pieces */
  readonly light: Container;
  /** layer over the pieces for what covers: debris */
  readonly matter: Container;
  readonly pool: SpritePool;
  readonly particles: Particles;
  readonly camera: Camera;
  readonly tweens: Tweens;
  on(fx: Fx): boolean;
  /** delayed call, dropped when the board is replaced meanwhile */
  after(ms: number, fn: () => void): void;
  /** the piece the player sees in a cell */
  pieceAt(pos: Pos): Sprite | undefined;
}

// ---------- blasts ----------

/**
 * The look of a blast going off now. `tint` is the color of the special that went off;
 * `delay` tells when its wave reaches a cell, from now, so rays and rings arrive with the pops.
 */
export function blastFx(kit: FxKit, b: Blast, tint: number, power: number, delay: (p: Pos) => number): void {
  switch (b.kind) {
    case BlastKind.Row:
    case BlastKind.Col:
      lineFx(kit, b, tint);
      break;
    case BlastKind.Bomb:
      bombFx(kit, b, tint, power);
      break;
    case BlastKind.Prism:
      prismFx(kit, b, b.color === NO_COLOR ? WHITE : tint, delay);
      break;
    case BlastKind.Star:
      starFx(kit, b);
      break;
    case BlastKind.Meteor:
      meteorFx(kit, b, power);
      break;
  }
}

/** Two beams run from the special to both edges, a colored glow around a white core, each with a bright head. */
function lineFx(kit: FxKit, b: Blast, tint: number): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  flash(kit, ox, oy, 1.8, WHITE);
  if (!kit.on(Fx.Line)) return;
  const vertical = b.kind === BlastKind.Col;
  const along = vertical ? b.origin.r : b.origin.c;
  const count = vertical ? kit.rows : kit.cols;
  for (const dir of [-1, 1]) {
    const cells = dir < 0 ? along + 0.5 : count - along - 0.5;
    const travel = kit.on(Fx.Wave) ? cells * Timing.line : 60;
    const rotation = vertical ? (dir * Math.PI) / 2 : dir < 0 ? Math.PI : 0;
    const [ux, uy] = [Math.cos(rotation), Math.sin(rotation)];
    beam(kit, ox, oy, rotation, cells, travel, 0.95, tint, 0.7);
    beam(kit, ox, oy, rotation, cells, travel, 0.34, WHITE, 1);
    let trailed = 0;
    light(kit, FrameName.Glow, ox, oy, tint, travel, (s, k) => {
      const reach = cells * k;
      s.position.set(ox + ux * reach * kit.cell, oy + uy * reach * kit.cell);
      s.scale.set(1.1);
      s.alpha = 1 - k * 0.3;
      for (; trailed + TRAIL_STEP <= reach; trailed += TRAIL_STEP) {
        kit.particles.emit(Burst.trail, s.x, s.y, { color: NO_COLOR, tint });
      }
    }, Ease.linear);
  }
}

/** One half of a line: grows to `cells` long over `travel` ms, then thins out. */
function beam(kit: FxKit, x: number, y: number, rotation: number, cells: number, travel: number, thick: number, tint: number, alpha: number): void {
  const total = travel + BEAM_FADE;
  light(kit, FrameName.Beam, x, y, tint, total, (s, k) => {
    const t = k * total;
    const fade = t < travel ? 1 : 1 - (t - travel) / BEAM_FADE;
    s.anchor.set(0, 0.5);
    s.rotation = rotation;
    s.scale.set(cells * Math.min(1, t / travel), thick * fade * Math.min(1, t / 40));
    s.alpha = alpha * fade;
  }, Ease.linear);
}

/** A flash, a shockwave that rings out as far as the blast took, sparks, and the pieces around pushed back. */
function bombFx(kit: FxKit, b: Blast, tint: number, power: number): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  const r = bombRadius(b);
  flash(kit, ox, oy, (r * 2 + 1) * 0.9, WHITE);
  if (!kit.on(Fx.Bomb)) return;
  const ring = kit.on(Fx.Wave) ? r * Timing.bomb : 0;
  const size = (r * 2 + 1) * 1.2;
  light(kit, FrameName.Shock, ox, oy, tint, ring + 260, (s, k) => {
    s.scale.set(0.3 + k * size);
    s.alpha = 1 - k * k;
  }, Ease.outCubic);
  light(kit, FrameName.Glow, ox, oy, tint, 320, (s, k) => {
    s.scale.set(size * 0.7 * (0.5 + 0.5 * k));
    s.alpha = 0.8 * (1 - k);
  });
  if (kit.on(Fx.Sparks)) kit.particles.emit(Burst.sparks, ox, oy, { color: NO_COLOR, tint, amount: 1.5 + r });
  if (kit.on(Fx.Recoil)) recoil(kit, b.origin, r, power, ring);
}

/** The pieces just outside the blast jump away from it and spring back as the ring passes them. */
function recoil(kit: FxKit, origin: Pos, radius: number, power: number, ring: number): void {
  const reach = radius + 1;
  const push = kit.cell * 0.16 * Math.min(1, power * 1.6);
  kit.after(ring + (kit.on(Fx.Wave) ? Timing.bomb : 0), () => {
    for (let dr = -reach; dr <= reach; dr++) {
      for (let dc = -reach; dc <= reach; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== reach) continue;
        const s = kit.pieceAt({ r: origin.r + dr, c: origin.c + dc });
        if (!s) continue;
        const d = Math.hypot(dr, dc);
        nudge(kit, s, (dc / d) * push, (dr / d) * push);
      }
    }
  });
}

/**
 * Shifts a piece by (dx, dy) and back through its pivot: position belongs to the moves (swap, fall)
 * and scale to the pops, so a nudge never fights them.
 */
function nudge(kit: FxKit, s: Sprite, dx: number, dy: number): void {
  void kit.tweens.run(280, (k) => {
    if (s.destroyed) return;
    const f = Math.sin(Math.PI * k) * (1 - k);
    s.pivot.set((-dx * f) / s.scale.x, (-dy * f) / s.scale.y);
  }, { ease: Ease.linear });
}

/** A colored ring, then a ray to every piece of the color, each as the wave gets there. */
function prismFx(kit: FxKit, b: Blast, tint: number, delay: (p: Pos) => number): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  flash(kit, ox, oy, 2.2, tint);
  if (!kit.on(Fx.Prism)) return;
  light(kit, FrameName.Ring, ox, oy, tint, 420, (s, k) => {
    s.scale.set(0.6 + k * 4);
    s.alpha = 1 - k;
  });
  const step = Math.ceil(b.cells.length / MAX_BOLTS);
  b.cells.forEach((p, k) => {
    if (k % step !== 0) return;
    kit.after(delay(p), () => {
      ray(kit, ox, oy, kit.x(p.c), kit.y(p.r), tint, 0);
      flash(kit, kit.x(p.c), kit.y(p.r), 0.9, tint);
    });
  });
}

/**
 * A ray from a prism to a piece: a tinted glow round a white core that shoots out over `travel` ms
 * behind a bright head (0: there at once), then thins out.
 */
export function ray(kit: FxKit, ox: number, oy: number, tx: number, ty: number, tint: number, travel: number): void {
  const length = Math.hypot(tx - ox, ty - oy) / kit.cell;
  const rotation = Math.atan2(ty - oy, tx - ox);
  const run = Math.max(1, travel);
  beam(kit, ox, oy, rotation, length, run, 0.8, tint, 0.75);
  beam(kit, ox, oy, rotation, length, run, 0.28, WHITE, 1);
  if (travel <= 0) return;
  light(kit, FrameName.Glow, ox, oy, tint, travel, (s, k) => {
    s.position.set(ox + (tx - ox) * k, oy + (ty - oy) * k);
    s.scale.set(1);
  }, Ease.linear);
}

// ---------- boosters ----------

/**
 * A booster falls from the sky onto the cell it was aimed at, for `ms`, speeding up as it comes, along an arc
 * from a random side at a random slant, so no two falls look alike: the star small and quick, trailing gold;
 * the meteor from farther up, swelling as it nears, trailing fire, the crater it is about to open glowing ever brighter under it.
 */
export function strikeFall(kit: FxKit, b: Blast, ms: number): void {
  const meteor = b.kind === BlastKind.Meteor;
  const tx = kit.x(b.origin.c);
  const ty = kit.y(b.origin.r);
  // Far enough to start above the board, coming in at a steep slant: 15–40° off the vertical, from either side.
  const side = Math.random() < 0.5 ? -1 : 1;
  const rise = ty + kit.cell * (meteor ? 5 : 3);
  const sx = tx + side * rise * Math.tan(((15 + 25 * Math.random()) * Math.PI) / 180);
  const sy = ty - rise;
  // The arc: a quadratic curve whose middle bows off the straight line by 10–25 % of its length, either way.
  const bend = (Math.random() < 0.5 ? -1 : 1) * (0.1 + 0.15 * Math.random());
  const mx = (sx + tx) / 2 + (ty - sy) * bend;
  const my = (sy + ty) / 2 - (tx - sx) * bend;
  const trail = kit.on(Fx.Strike);
  const tint = meteor ? FIRE : STAR_GOLD;
  const at = (k: number): [number, number] => {
    const [a, m, c] = [(1 - k) * (1 - k), 2 * k * (1 - k), k * k];
    return [a * sx + m * mx + c * tx, a * sy + m * my + c * ty];
  };
  // The direction of flight at k: the curve's tangent.
  const heading = (k: number): number => Math.atan2((1 - k) * (my - sy) + k * (ty - my), (1 - k) * (mx - sx) + k * (tx - mx));
  if (meteor) {
    for (const p of b.cells) {
      light(kit, FrameName.Aim, kit.x(p.c), kit.y(p.r), FIRE, ms, (s, k) => {
        s.alpha = 0.5 * k * k;
        s.scale.set(1);
      }, Ease.linear);
    }
  }
  // A long tail behind the head: a streak stretched back along the fall.
  light(kit, FrameName.Streak, sx, sy, tint, ms, (s, k) => {
    const [x, y] = at(k);
    const length = (meteor ? 4.5 : 3.2) * Math.min(1, k * 3);
    s.anchor.set(1, 0.5);
    s.position.set(x, y);
    s.rotation = heading(k);
    s.scale.set(length, meteor ? 1.3 : 0.7);
    s.alpha = 0.9;
  }, Ease.inQuad);
  light(kit, FrameName.Glow, sx, sy, tint, ms, (s, k) => {
    const [x, y] = at(k);
    s.position.set(x, y);
    s.scale.set(meteor ? 1.4 + 1.4 * k : 1.3);
    s.alpha = 0.85;
  }, Ease.inQuad);
  // Puffs every TRAIL_STEP cells along the arc: each frame's stretch of it is near enough straight.
  let next = TRAIL_STEP;
  let last = 0;
  let [lx, ly] = [sx, sy];
  const head = kit.pool.acquire(kit.light, kit.texture(meteor ? FrameName.Meteor : FrameName.FallingStar), 'normal');
  const step = (k: number): void => {
    const [x, y] = at(k);
    head.position.set(x, y);
    head.rotation = meteor ? side * (1.2 - k * 1.6) : side * k * 7;
    head.scale.set(meteor ? 0.7 + 0.9 * k : 0.75 + 0.15 * k);
    if (!trail) return;
    const span = Math.hypot(x - lx, y - ly) / kit.cell;
    for (; next <= span; next += TRAIL_STEP) {
      const [px, py] = at(last + (k - last) * (next / span));
      if (meteor) {
        kit.particles.emit(Burst.fire, px, py, { color: NO_COLOR, tint: FIRE });
        if (Math.random() < 0.35) kit.particles.emit(Burst.sparks, px, py, { color: NO_COLOR, tint: EMBER, amount: 0.4 });
      } else {
        kit.particles.emit(Burst.trail, px, py, { color: NO_COLOR, tint: STAR_GOLD });
        if (Math.random() < 0.3) kit.particles.emit(Burst.glitter, px, py, { color: NO_COLOR, tint: WHITE, amount: 0.5 });
      }
    }
    next -= span;
    last = k;
    [lx, ly] = [x, y];
  };
  head.tint = WHITE;
  step(0);
  void kit.tweens.run(ms, step, { ease: Ease.inQuad }).then(() => kit.pool.release(head));
}

/** The star lands: a golden flash and ring, sparks and glitter thrown out of the cell. */
function starFx(kit: FxKit, b: Blast): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  flash(kit, ox, oy, 2.6, WHITE);
  flash(kit, ox, oy, 3.4, STAR_GOLD);
  light(kit, FrameName.Shock, ox, oy, STAR_GOLD, 340, (s, k) => {
    s.scale.set(0.4 + k * 3.4);
    s.alpha = 1 - k;
  }, Ease.outCubic);
  if (kit.on(Fx.Sparks)) kit.particles.emit(Burst.sparks, ox, oy, { color: NO_COLOR, tint: STAR_GOLD, amount: 2.2 });
  kit.particles.emit(Burst.glitter, ox, oy, { color: NO_COLOR, tint: WHITE, amount: 3 });
}

/**
 * The meteor hits: a blinding flash, two shockwaves out past the crater, fire and rock thrown out,
 * soot hanging over it, and the pieces around pushed back.
 */
function meteorFx(kit: FxKit, b: Blast, power: number): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  flash(kit, ox, oy, 7, WHITE);
  flash(kit, ox, oy, 9, FIRE);
  if (!kit.on(Fx.Bomb)) return;
  const ring = kit.on(Fx.Wave) ? 2.5 * Timing.crater : 0;
  for (const [delay, tint, size, ms] of [
    [0, EMBER, 7.5, 420],
    [90, WHITE, 9.5, 520],
  ] as const) {
    kit.after(delay, () =>
      light(kit, FrameName.Shock, ox, oy, tint, ring + ms, (s, k) => {
        s.scale.set(0.5 + k * size);
        s.alpha = 1 - k * k;
      }, Ease.outCubic),
    );
  }
  light(kit, FrameName.Glow, ox, oy, FIRE, 620, (s, k) => {
    s.scale.set(5.5 * (0.6 + 0.4 * k));
    s.alpha = 0.9 * (1 - k);
  });
  if (kit.on(Fx.Sparks)) {
    kit.particles.emit(Burst.sparks, ox, oy, { color: NO_COLOR, tint: EMBER, amount: 5 });
    kit.particles.emit(Burst.fire, ox, oy, { color: NO_COLOR, tint: FIRE, amount: 8, radius: 1.5 });
  }
  if (kit.on(Fx.Debris)) {
    kit.particles.emit(Burst.rubble, ox, oy, { color: NO_COLOR, tint: SOOT, amount: 2 });
    kit.particles.emit(Burst.dust, ox, oy, { color: NO_COLOR, tint: SOOT, amount: 4, radius: 2 });
  }
  if (kit.on(Fx.Recoil)) recoil(kit, b.origin, 2, power, ring);
}

// ---------- pieces ----------

/**
 * A hit piece: flashes white, swells and breaks into shards, sparks and glitter; the sprite is destroyed after.
 * `amount` scales the particles: deeper cascades throw more, a crowded clear less each.
 */
export function popPiece(kit: FxKit, sprite: Sprite, color: number, tint: number, amount: number): void {
  // The board was rebuilt while the piece waited for its wave: it is gone already.
  if (sprite.destroyed) return;
  const base = sprite.scale.x;
  if (kit.on(Fx.Flash)) {
    light(kit, FrameName.silhouette(color), sprite.x, sprite.y, WHITE, POP_MS * 0.8, (s, k) => {
      if (!sprite.destroyed) s.scale.copyFrom(sprite.scale);
      s.alpha = 0.9 * (1 - k);
    }, Ease.linear);
  }
  const { x, y } = sprite;
  kit.after(POP_MS * POP_BREAK, () => {
    if (kit.on(Fx.Sparks)) kit.particles.emit(Burst.sparks, x, y, { color, tint, amount });
    if (kit.on(Fx.Shards) && color !== NO_COLOR) kit.particles.emit(Burst.shards, x, y, { color, tint: WHITE, amount });
    if (kit.on(Fx.Glitter)) kit.particles.emit(Burst.glitter, x, y, { color, tint: WHITE, amount: amount * 0.5 });
  });
  void kit.tweens
    .run(POP_MS, (k) => {
      if (k < POP_BREAK) {
        sprite.scale.set(base * (1 + 0.18 * (k / POP_BREAK)));
        return;
      }
      const q = (k - POP_BREAK) / (1 - POP_BREAK);
      sprite.scale.set(base * 1.18 * (1 - 0.55 * q));
      sprite.alpha = 1 - q;
    }, { ease: Ease.linear })
    .then(() => sprite.destroy());
}

/**
 * A pearl leaves through the bottom of its column: a pearly flash and ring open on the edge, and the pearl dips
 * through it, shrinking and fading; the sprite is destroyed after.
 */
export function sinkPearl(kit: FxKit, sprite: Sprite): void {
  if (sprite.destroyed) return;
  const { x, y } = sprite;
  const edge = y + kit.cell / 2;
  flash(kit, x, edge, 1.5, PEARL_GLOW);
  light(kit, FrameName.Shock, x, edge, PEARL_GLOW, 380, (s, k) => {
    s.scale.set(0.3 + 1.2 * k);
    s.alpha = 1 - k;
  }, Ease.outCubic);
  if (kit.on(Fx.Glitter)) kit.particles.emit(Burst.glitter, x, edge, { color: NO_COLOR, tint: WHITE, amount: 1.5 });
  void kit.tweens
    .run(SINK_MS, (k) => {
      if (sprite.destroyed) return;
      sprite.position.set(x, y + kit.cell * 0.6 * k);
      sprite.scale.set(1 - 0.55 * k);
      sprite.alpha = 1 - k;
    }, { ease: Ease.inQuad })
    .then(() => sprite.destroy());
}

/** A special is born: a flash, and a small shockwave with glitter. */
export function createFx(kit: FxKit, x: number, y: number, tint: number): void {
  flash(kit, x, y, 1.6, WHITE);
  if (!kit.on(Fx.Create)) return;
  light(kit, FrameName.Shock, x, y, tint, 300, (s, k) => {
    s.scale.set(0.4 + 1.4 * k);
    s.alpha = 1 - k;
  }, Ease.outCubic);
  kit.particles.emit(Burst.glitter, x, y, { color: NO_COLOR, tint: WHITE, amount: 1.5 });
}

/** A blocker layer cracks: ice crumbs, wood splinters and dust, or chain sparks. */
export function layerFx(kit: FxKit, layer: Layer, x: number, y: number): void {
  const tint = LAYER_TINTS[layer];
  if (!kit.on(Fx.Debris)) {
    kit.particles.emit(Burst.glitter, x, y, { color: NO_COLOR, tint, amount: 2 });
    return;
  }
  const dust = { color: NO_COLOR, tint: DUST_TINTS[layer] };
  switch (layer) {
    case 'ice':
      kit.particles.emit(Burst.frost, x, y, { color: NO_COLOR, tint });
      kit.particles.emit(Burst.glitter, x, y, { color: NO_COLOR, tint: WHITE });
      break;
    case 'crate':
      kit.particles.emit(Burst.chips, x, y, { color: NO_COLOR, tint });
      kit.particles.emit(Burst.dust, x, y, dust);
      break;
    case 'chain':
      kit.particles.emit(Burst.sparks, x, y, { color: NO_COLOR, tint, amount: 0.7 });
      kit.particles.emit(Burst.dust, x, y, { ...dust, amount: 0.5 });
      break;
  }
}

/** A crate or chain comes apart as it goes from `from` layers down to `to`: what each lost layer was flies off and falls. */
export function breakLayer(kit: FxKit, layer: 'crate' | 'chain', x: number, y: number, from: number, to: number): void {
  for (let k = from; k > to; k--) {
    if (layer === 'chain') shatter(kit, CHAIN_BITS[k - 1], x, y, CHAIN_FLIGHT);
    else if (k > 1) shatter(kit, [CRATE_BITS[k - 1]], x, y, CRATE_BIT_FLIGHT);
    else shatter(kit, CRATE_PIECES, x, y, CRATE_FLIGHT);
  }
}

/**
 * Bits fly apart from the cell's center at (`x`, `y`) and fall: each is kicked out along the line from the center
 * to itself, turned at random a little, and lifted, then gravity bends its flight into a parabola (a quadratic
 * Bézier) as it tumbles and fades. The kick, lift, spin and length are drawn anew for every bit, every time.
 */
function shatter(kit: FxKit, fragments: readonly Fragment[], x: number, y: number, f: Flight): void {
  const cell = kit.cell;
  for (const bit of fragments) {
    const s = kit.pool.acquire(kit.matter, kit.texture(bit.frame), 'normal');
    const [x0, y0] = [x + bit.x * cell, y + bit.y * cell];
    // A bit at the very center has no line of its own: it goes any way.
    const out = Math.hypot(bit.x, bit.y) > 0.05 ? Math.atan2(bit.y, bit.x) : Math.random() * Math.PI * 2;
    const dir = out + (Math.random() - 0.5) * 1.1;
    const speed = f.kick * (0.6 + 0.8 * Math.random());
    const vx = Math.cos(dir) * speed;
    const vy = Math.sin(dir) * speed * 0.6 - f.lift * (0.5 + Math.random());
    const spin = (Math.random() - 0.5) * 2 * f.spin;
    const ms = f.ms * (0.85 + 0.3 * Math.random());
    const update = (k: number): void => {
      const t = (k * ms) / 1000;
      s.position.set(x0 + vx * t * cell, y0 + (vy * t + (f.gravity * t * t) / 2) * cell);
      s.rotation = bit.angle + spin * t;
      s.scale.set(1 - 0.2 * k);
      s.alpha = k < 1 - f.fade ? 1 : (1 - k) / f.fade;
    };
    update(0);
    void kit.tweens.run(ms, update, { ease: Ease.linear }).then(() => kit.pool.release(s));
  }
}

/** A hit crate jolts: it swells, then rocks to one side and back, settling as the bit it lost flies off. */
export function knock(kit: FxKit, sprite: Sprite): void {
  const side = Math.random() < 0.5 ? -1 : 1;
  void kit.tweens.run(360, (k) => {
    if (sprite.destroyed) return;
    const d = (1 - k) ** 2;
    sprite.rotation = side * 0.18 * Math.sin(k * Math.PI * 3) * d;
    sprite.scale.set(1 + 0.14 * d);
  }, { ease: Ease.linear });
}

/** A combo gathers its power: light and sparkles pulled into its center, the two specials drawn together. */
export function comboCharge(kit: FxKit, center: Pos, pieces: Sprite[], ms: number): void {
  const cx = kit.x(center.c);
  const cy = kit.y(center.r);
  light(kit, FrameName.Glow, cx, cy, WHITE, ms + 60, (s, k) => {
    s.scale.set(0.4 + 1.8 * k);
    s.alpha = 0.3 + 0.7 * k;
  }, Ease.inQuad);
  kit.particles.emit(Burst.gather, cx, cy, { color: NO_COLOR, tint: WHITE, radius: 1.8, inward: true });
  for (const s of pieces) {
    const [sx, sy] = [s.x, s.y];
    void kit.tweens.run(ms, (k) => {
      if (s.destroyed) return;
      s.position.set(sx + (cx - sx) * k * 0.6, sy + (cy - sy) * k * 0.6);
      s.scale.set(1 + 0.25 * k);
    }, { ease: Ease.inQuad });
  }
}

/**
 * A piece lands: squashes, and after a fall of a few cells hops a little and settles.
 * The hop goes through the pivot, like a nudge, so the next fall can take the position at once.
 */
export function land(kit: FxKit, sprite: Sprite, cells: number): void {
  if (sprite.destroyed) return;
  const drop = Math.min(1, 0.4 + cells / 4);
  const hop = kit.on(Fx.Bounce) ? kit.cell * 0.07 * drop : 0;
  const squashMs = 90;
  const total = hop > 0 ? 230 : 130;
  void kit.tweens.run(total, (k) => {
    if (sprite.destroyed) return;
    const t = k * total;
    if (hop === 0 || t < squashMs) {
      const q = Math.sin(Math.PI * Math.min(1, t / (hop > 0 ? squashMs : total))) * 0.14 * (hop > 0 ? drop + 0.15 : 1);
      sprite.scale.set(1 + q, 1 - q);
      return;
    }
    const u = Math.sin(Math.PI * ((t - squashMs) / (total - squashMs)));
    sprite.scale.set(1 - 0.03 * u, 1 + 0.04 * u);
    sprite.pivot.y = (hop * u) / sprite.scale.y;
  }, { ease: Ease.linear });
}

// ---------- helpers ----------

/** A glow that swells and fades. */
export function flash(kit: FxKit, x: number, y: number, size: number, tint: number): void {
  light(kit, FrameName.Glow, x, y, tint, 260, (s, k) => {
    s.scale.set(size * (0.6 + k * 0.6));
    s.alpha = 1 - k;
  });
}

/** A pooled additive sprite driven by `update(sprite, k)` for `ms`, then given back. */
function light(
  kit: FxKit,
  frame: string,
  x: number,
  y: number,
  tint: number,
  ms: number,
  update: (s: Sprite, k: number) => void,
  ease: EaseFn = Ease.outQuad,
): void {
  const s = kit.pool.acquire(kit.light, kit.texture(frame), 'add');
  s.position.set(x, y);
  s.tint = tint;
  update(s, 0);
  void kit.tweens.run(ms, (k) => update(s, k), { ease }).then(() => kit.pool.release(s));
}
