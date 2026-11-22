import type { Container, Sprite, Texture } from 'pixi.js';
import { type Blast, BlastKind, NO_COLOR, type Pos } from '@/core/types';
import { FrameName } from '@/view/art';
import { Burst } from '@/view/fx/bursts';
import type { Camera } from '@/view/fx/camera';
import { bombRadius } from '@/view/fx/impact';
import type { SpritePool } from '@/view/fx/pool';
import { Fx } from '@/view/fx/switches';
import { Timing } from '@/view/fx/timeline';
import type { Particles } from '@/view/particles';
import { Ease, type EaseFn, type Tweens } from '@/view/tween';

export const WHITE = 0xffffff;

export type Layer = 'ice' | 'crate' | 'chain';

const LAYER_TINTS: Record<Layer, number> = { ice: 0xbfe8ff, crate: 0xc98a4b, chain: 0xd7dde8 };
const DUST_TINTS: Record<Layer, number> = { ice: 0xe6f6ff, crate: 0xd9b48a, chain: 0xaab2bf };

/** a beam fades out this long once it reached the edge */
const BEAM_FADE = 220;
/** a beam's head and a flying star leave a trail puff every this many cells */
const TRAIL_STEP = 0.35;
/** a prism throws at most this many bolts: a whole-board wipe would otherwise draw a hedgehog */
const MAX_BOLTS = 36;
/** a hit piece swells, then breaks: particles fly at the break */
const POP_MS = 140;
const POP_BREAK = 0.3;

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
 * `delay` tells when its wave reaches a cell, from now, so bolts and rings arrive with the pops.
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
    case BlastKind.Spark:
      sparkFx(kit, b, tint);
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

/** A colored ring, then a bolt to every piece of the color, each as the wave gets there. */
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
    if (k % step === 0) kit.after(delay(p), () => bolt(kit, ox, oy, kit.x(p.c), kit.y(p.r), tint));
  });
}

function bolt(kit: FxKit, ox: number, oy: number, tx: number, ty: number, tint: number): void {
  const length = Math.hypot(tx - ox, ty - oy) / kit.cell;
  const rotation = Math.atan2(ty - oy, tx - ox);
  light(kit, FrameName.Beam, ox, oy, tint, 170, (s, k) => {
    s.anchor.set(0, 0.5);
    s.rotation = rotation;
    s.scale.set(length, 0.3 * (1 - k));
    s.alpha = 1 - k;
  });
  flash(kit, tx, ty, 0.9, tint);
}

/** A star arcs to the target with a trail and bursts there. */
function sparkFx(kit: FxKit, b: Blast, tint: number): void {
  const ox = kit.x(b.origin.c);
  const oy = kit.y(b.origin.r);
  flash(kit, ox, oy, 1.4, WHITE);
  if (!b.target) return;
  const tx = kit.x(b.target.c);
  const ty = kit.y(b.target.r);
  const lift = kit.cell * 1.2;
  const trail = kit.on(Fx.Spark);
  let last = { x: ox, y: oy };
  light(kit, FrameName.Star, ox, oy, WHITE, Timing.sparkFlight, (s, k) => {
    s.position.set(ox + (tx - ox) * k, oy + (ty - oy) * k - Math.sin(k * Math.PI) * lift);
    s.rotation = k * 6;
    s.scale.set(0.7);
    if (trail && Math.hypot(s.x - last.x, s.y - last.y) >= TRAIL_STEP * kit.cell) {
      last = { x: s.x, y: s.y };
      kit.particles.emit(Burst.trail, s.x, s.y, { color: NO_COLOR, tint });
    }
  });
  kit.after(Timing.sparkFlight, () => {
    flash(kit, tx, ty, 1.8, WHITE);
    if (trail) kit.particles.emit(Burst.sparks, tx, ty, { color: NO_COLOR, tint });
  });
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
