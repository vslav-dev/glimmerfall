import { type Container, Sprite, type Texture } from 'pixi.js';

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  spin: number;
  life: number;
  maxLife: number;
  scale: number;
  gravity: number;
}

export interface BurstOptions {
  count: number;
  speed: number;
  /** sprite scale relative to the frame (a frame is one cell) */
  size: number;
  life: number;
  gravity?: number;
}

const MAX_PARTICLES = 260;

/** Pooled sprite particles. No allocation per frame; the pool only grows up to the cap. Bursts wake the render loop. */
export class Particles {
  public density = 1;
  private readonly pool: Sprite[] = [];
  private live: Particle[] = [];

  public constructor(
    private readonly layer: Container,
    private readonly onStart: () => void,
  ) {}

  public burst(x: number, y: number, texture: Texture, tint: number, o: BurstOptions): void {
    const count = Math.round(o.count * this.density);
    for (let i = 0; i < count && this.live.length < MAX_PARTICLES; i++) {
      const sprite = this.pool.pop() ?? new Sprite();
      sprite.texture = texture;
      sprite.anchor.set(0.5);
      sprite.tint = tint;
      sprite.blendMode = 'add';
      sprite.position.set(x, y);
      sprite.alpha = 1;
      sprite.visible = true;
      this.layer.addChild(sprite);
      const angle = Math.random() * Math.PI * 2;
      const speed = o.speed * (0.4 + Math.random() * 0.8);
      const scale = o.size * (0.6 + Math.random() * 0.6);
      sprite.scale.set(scale);
      this.live.push({
        sprite,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - o.speed * 0.3,
        spin: (Math.random() - 0.5) * 8,
        life: 0,
        maxLife: o.life * (0.7 + Math.random() * 0.6),
        scale,
        gravity: o.gravity ?? 600,
      });
    }
    if (count > 0) this.onStart();
  }

  /** Returns whether particles are still alive. */
  public update(dt: number): boolean {
    if (this.live.length === 0) return false;
    const s = dt / 1000;
    let write = 0;
    for (const p of this.live) {
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.release(p.sprite);
        continue;
      }
      const k = p.life / p.maxLife;
      p.vy += p.gravity * s;
      p.sprite.x += p.vx * s;
      p.sprite.y += p.vy * s;
      p.sprite.rotation += p.spin * s;
      p.sprite.alpha = 1 - k * k;
      p.sprite.scale.set(p.scale * (1 - k * 0.5));
      this.live[write++] = p;
    }
    this.live.length = write;
    return write > 0;
  }

  public clear(): void {
    for (const p of this.live) this.release(p.sprite);
    this.live = [];
  }

  private release(sprite: Sprite): void {
    sprite.visible = false;
    this.layer.removeChild(sprite);
    this.pool.push(sprite);
  }
}
