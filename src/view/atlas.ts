import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { debug } from '@/telemetry/telemetry';
import { PAINTERS } from '@/view/art';

const PAD = 2;

/**
 * One texture with every frame of the game, painted for the exact cell size and pixel density.
 * One texture means the whole board is drawn in one or two batches.
 */
export class Atlas {
  private source: CanvasSource | null = null;
  private readonly frames = new Map<string, Texture>();
  private key = '';

  /** Repaints when the cell size or resolution changed. Returns true when textures were replaced. */
  public build(cell: number, resolution: number): boolean {
    const key = `${cell}@${resolution}`;
    if (key === this.key) return false;

    const started = performance.now();
    const px = Math.ceil(cell * resolution);
    const slot = px + PAD * 2;
    const names = [...PAINTERS.keys()];
    const perRow = Math.ceil(Math.sqrt(names.length));
    const canvas = document.createElement('canvas');
    canvas.width = perRow * slot;
    canvas.height = Math.ceil(names.length / perRow) * slot;
    const ctx = canvas.getContext('2d')!;

    const places = names.map((name, k) => {
      const x = (k % perRow) * slot + PAD;
      const y = Math.floor(k / perRow) * slot + PAD;
      ctx.save();
      ctx.translate(x, y);
      PAINTERS.get(name)!(ctx, px);
      ctx.restore();
      return { name, x, y };
    });

    // The first frame is a gem: its center must come out opaque, or 2D painting itself failed.
    const centerAlpha = ctx.getImageData(places[0].x + (px >> 1), places[0].y + (px >> 1), 1, 1).data[3];
    debug('atlas', { key, size: [canvas.width, canvas.height], centerAlpha, ms: Math.round(performance.now() - started) });

    for (const texture of this.frames.values()) texture.destroy(false);
    this.frames.clear();
    this.source?.destroy();
    this.source = new CanvasSource({ resource: canvas, resolution });
    for (const { name, x, y } of places) {
      const frame = new Rectangle(x / resolution, y / resolution, px / resolution, px / resolution);
      this.frames.set(name, new Texture({ source: this.source, frame }));
    }
    // Set last: a failed paint must be retried next time, not leave the board with empty frames.
    this.key = key;
    return true;
  }

  public get(name: string): Texture {
    return this.frames.get(name) ?? Texture.EMPTY;
  }
}
