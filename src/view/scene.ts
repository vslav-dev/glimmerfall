import { autoDetectRenderer, Container, type Renderer, Sprite } from 'pixi.js';
import { countDraws, perfContext, recordFrame, recordGpuLag, recordIdleFrame } from '@/telemetry/perf';
import { track } from '@/telemetry/telemetry';
import { Tweens } from '@/view/tween';

/** Quality steps the scene falls back through when frames get slow. */
const QUALITY = [
  { maxResolution: 2, particles: 1 },
  { maxResolution: 1.5, particles: 0.6 },
  { maxResolution: 1, particles: 0.35 },
];
const SLOW_FRAME_MS = 24;
const SLOW_FRAMES_TO_DOWNGRADE = 40;
/** game time runs this fast during a hitstop */
const HITSTOP_SPEED = 0.06;

/** Called every frame with the elapsed ms; returns whether it still animates. */
type Updater = (dt: number) => boolean;

/**
 * WebGL renderer with an on-demand loop: frames run only while something animates,
 * so an idle board costs no GPU, no battery and no heat. A frame where only pauses run (nothing on screen
 * moves) keeps the clock going but is not drawn.
 */
export class Scene {
  public readonly root = new Container();
  public readonly tweens = new Tweens(() => this.request());
  /** called after a quality downgrade, so textures can be rebuilt for the new resolution */
  public onQualityChange: (() => void) | null = null;
  /** game-time updaters slow down in a hitstop; real-time ones (the camera) keep going */
  private readonly updaters: { fn: Updater; realTime: boolean }[] = [];
  /** real ms of hitstop left */
  private stopLeft = 0;
  private quality = 0;
  private slowFrames = 0;
  private scheduled = false;
  /** the picture changed outside the tweens (or right after some finished): draw the next frame */
  private dirty = true;
  /** an updater animated in the previous frame: its last change still needs drawing */
  private animated = false;
  /** WebGL2 only: a fence after a drawn frame, to see how many frames behind the GPU runs */
  private readonly gl2: WebGL2RenderingContext | null;
  private fence: { sync: WebGLSync; frame: number } | null = null;
  private drawn = 0;
  private last = 0;
  private width = 1;
  private height = 1;

  private constructor(private readonly renderer: Renderer) {
    this.gl2 = 'gl' in renderer && renderer.context.webGLVersion === 2 ? renderer.gl : null;
  }

  public static async create(canvas: HTMLCanvasElement): Promise<Scene> {
    const renderer = await autoDetectRenderer({
      preference: 'webgl',
      canvas,
      width: 1,
      height: 1,
      resolution: 1,
      autoDensity: true,
      backgroundAlpha: 0,
      antialias: false,
      powerPreference: 'low-power',
      // Interaction is plain DOM pointer events; Pixi's event and accessibility systems are not needed.
      skipExtensionImports: true,
    });
    track('gl', glInfo(renderer));
    if ('gl' in renderer) countDraws(renderer.gl);
    canvas.addEventListener('webglcontextlost', () => track('gl', { event: 'contextlost' }));
    canvas.addEventListener('webglcontextrestored', () => track('gl', { event: 'contextrestored' }));
    return new Scene(renderer);
  }

  public get resolution(): number {
    return Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].maxResolution);
  }

  public get particleDensity(): number {
    return QUALITY[this.quality].particles;
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.resize(width, height, this.resolution);
    this.reportSize();
    // Resizing wipes the canvas; drawing now keeps a blank frame off the screen.
    this.renderer.render(this.root);
    this.request();
  }

  public addUpdater(fn: Updater, realTime = false): void {
    this.updaters.push({ fn, realTime });
  }

  /** Big hits freeze the game for a moment: everything but the camera nearly stops, so the hit lands. */
  public hitstop(ms: number): void {
    this.stopLeft = Math.max(this.stopLeft, ms);
    this.request();
  }

  /** Something on screen changed: the next frame is drawn. */
  public request(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    const start = performance.now();
    this.scheduled = false;
    const interval = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(50, interval) : 16;
    this.last = now;

    const gameDt = this.stopLeft > 0 ? dt * HITSTOP_SPEED : dt;
    this.stopLeft = Math.max(0, this.stopLeft - dt);
    const finished = this.tweens.update(gameDt);
    let animating = false;
    for (const { fn, realTime } of this.updaters) animating = fn(realTime ? dt : gameDt) || animating;
    const draw = this.dirty || finished > 0 || animating || this.animated || this.tweens.visual;
    // What awaited the finished tweens runs after this frame: whatever it changes is drawn in the next one.
    this.dirty = finished > 0;
    this.animated = animating;
    const updated = performance.now();
    if (draw) {
      this.renderer.render(this.root);
      const rendered = performance.now();
      this.watchGpu();
      recordFrame({ interval, updateMs: updated - start, renderMs: rendered - updated, lateMs: Math.max(0, start - now), ...coverage(this.root, this.width * this.height) });
    } else {
      recordIdleFrame();
    }

    if (this.tweens.active || this.stopLeft > 0 || animating || this.dirty) {
      if (draw) this.trackSpeed(dt);
      this.schedule();
    } else {
      this.last = 0;
      this.dropFence();
    }
  };

  /** After each drawn frame: how many drawn frames ago did the GPU finish the fenced one. */
  private watchGpu(): void {
    const gl = this.gl2;
    if (!gl) return;
    this.drawn++;
    if (this.fence) {
      if (gl.getSyncParameter(this.fence.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      recordGpuLag(this.drawn - this.fence.frame - 1);
      this.dropFence();
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) this.fence = { sync, frame: this.drawn };
  }

  /** A fence left over a pause would read as a long lag: it is dropped when the loop stops. */
  private dropFence(): void {
    if (this.fence) this.gl2?.deleteSync(this.fence.sync);
    this.fence = null;
  }

  private trackSpeed(dt: number): void {
    this.slowFrames = dt > SLOW_FRAME_MS ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
    if (this.slowFrames < SLOW_FRAMES_TO_DOWNGRADE || this.quality === QUALITY.length - 1) return;
    this.quality++;
    this.slowFrames = 0;
    this.renderer.resize(this.width, this.height, this.resolution);
    this.reportSize();
    track('perf', { kind: 'quality', quality: this.quality, res: this.resolution, t: Math.round(performance.now() / 1000) });
    this.onQualityChange?.();
  }

  /** CSS size, device pixel ratio and the backing size actually rendered (pixels per frame to fill). */
  private reportSize(): void {
    const res = this.resolution;
    perfContext({
      quality: this.quality,
      dpr: window.devicePixelRatio,
      res,
      css: [Math.round(this.width), Math.round(this.height)],
      px: [Math.round(this.width * res), Math.round(this.height * res)],
    });
  }
}

/** Pixels the frame fills, in canvases (every visible sprite, plus the clear), and the sprites drawn. */
function coverage(root: Container, canvasArea: number): { fill: number; sprites: number } {
  let area = 0;
  let sprites = 0;
  const visit = (node: Container): void => {
    if (!node.visible || node.alpha <= 0) return;
    if (node instanceof Sprite) {
      const t = node.worldTransform;
      const frame = node.texture.frame;
      area += Math.abs(t.a * t.d - t.b * t.c) * frame.width * frame.height;
      sprites++;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return { fill: 1 + area / Math.max(1, canvasArea), sprites };
}

function glInfo(renderer: Renderer): Record<string, unknown> {
  if (!('gl' in renderer)) return { renderer: renderer.name };
  const gl = renderer.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: renderer.name,
    webgl: renderer.context.webGLVersion,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string : null,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
  };
}
