import { autoDetectRenderer, Container, type Renderer, Sprite } from 'pixi.js';
import { countDraws, perfContext, perfFlag, recordFrame, recordGpuLag, recordIdleFrame } from '@/telemetry/perf';
import { track } from '@/telemetry/telemetry';
import { Tweens } from '@/view/tween';

/**
 * Quality steps the scene falls back through when frames get slow. `frameMs` is the least time between drawn
 * frames: a 120 Hz screen that cannot keep up first draws every other frame (a steady 60 fps), keeping the
 * resolution sharp; only then does the resolution drop. A screen of 60 Hz or less skips that step.
 */
const QUALITY = [
  { maxResolution: 2, particles: 1, frameMs: 0 },
  { maxResolution: 2, particles: 1, frameMs: 1000 / 60 },
  { maxResolution: 1.5, particles: 0.6, frameMs: 1000 / 60 },
  { maxResolution: 1, particles: 0.35, frameMs: 1000 / 60 },
];
/** A screen whose frames come faster than this is a high-refresh one, worth the 60 fps step. */
const HIGH_REFRESH_MS = 12;
/**
 * Slow, calm motion alone on screen (a hinted move breathing, the aim pulsing) is drawn at ~30 fps:
 * it looks the same, and the GPU and the compositor rest while the player thinks.
 */
const CALM_FRAME_MS = 1000 / 30;
/** vsync jitter allowed when a frame is due: one at 16.4 ms still counts as the 60 fps one */
const FRAME_SLACK_MS = 3;
const SLOW_FRAME_MS = 24;
const SLOW_FRAMES_TO_DOWNGRADE = 40;
/** game time runs this fast during a hitstop */
const HITSTOP_SPEED = 0.06;

/** Called every frame with the elapsed ms; returns whether it still animates. */
type Updater = (dt: number) => boolean;

interface UpdaterOptions {
  /** game-time updaters slow down in a hitstop; real-time ones (the camera) keep going */
  realTime?: boolean;
  /** slow, calm motion (a pulse): drawn at the calm frame rate while nothing else moves */
  calm?: boolean;
}

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
  private readonly updaters: ({ fn: Updater } & UpdaterOptions)[] = [];
  /** real ms of hitstop left */
  private stopLeft = 0;
  private quality = 0;
  private slowFrames = 0;
  private scheduled = false;
  /** the picture changed outside the tweens (or right after some finished): draw the next frame */
  private dirty = true;
  /** an updater animated in the previous frame (a calm one, apart): its last change still needs drawing */
  private animated = false;
  private calmAnimated = false;
  /** WebGL2 only: a fence after a drawn frame, to see how many frames behind the GPU runs */
  private readonly gl2: WebGL2RenderingContext | null;
  private fence: { sync: WebGLSync; frame: number } | null = null;
  private drawn = 0;
  private last = 0;
  /** when the last frame was drawn, to keep the calm and the paced frame rates */
  private lastDrawn = 0;
  /** the shortest frame interval seen: tells a high-refresh screen */
  private fastest = Infinity;
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

  public addUpdater(fn: Updater, options: UpdaterOptions = {}): void {
    this.updaters.push({ fn, ...options });
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
    if (interval > 0) this.fastest = Math.min(this.fastest, interval);
    const finished = this.tweens.update(gameDt);
    let animating = false;
    let calmAnimating = false;
    for (const { fn, realTime, calm } of this.updaters) {
      if (!fn(realTime ? dt : gameDt)) continue;
      if (calm) calmAnimating = true;
      else animating = true;
    }
    const moving = this.dirty || finished > 0 || animating || this.animated || this.tweens.moving;
    const changed = moving || calmAnimating || this.calmAnimated || this.tweens.visual;
    const calm = changed && !moving;
    const gap = calm ? CALM_FRAME_MS : QUALITY[this.quality].frameMs;
    const draw = changed && now - this.lastDrawn >= gap - FRAME_SLACK_MS;
    if (draw) {
      // What awaited the finished tweens runs after this frame: whatever it changes is drawn in the next one.
      this.dirty = finished > 0;
      this.animated = animating;
      this.calmAnimated = calmAnimating;
    } else {
      // A change held back to keep the frame rate is drawn in the next due frame.
      this.dirty ||= finished > 0;
      this.animated ||= animating;
      this.calmAnimated ||= calmAnimating;
    }
    const updated = performance.now();
    if (draw) {
      this.lastDrawn = now;
      perfFlag('calm', calm);
      this.renderer.render(this.root);
      const rendered = performance.now();
      this.watchGpu();
      recordFrame({ interval, updateMs: updated - start, renderMs: rendered - updated, lateMs: Math.max(0, start - now), ...coverage(this.root, this.width * this.height) });
    } else {
      recordIdleFrame();
    }

    if (this.tweens.active || this.stopLeft > 0 || animating || calmAnimating || this.dirty || this.animated || this.calmAnimated) {
      if (draw && !calm) this.trackSpeed(dt);
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
    if (this.quality === 1 && this.fastest >= HIGH_REFRESH_MS) this.quality++;
    this.slowFrames = 0;
    this.renderer.resize(this.width, this.height, this.resolution);
    this.reportSize();
    track('perf', { kind: 'quality', quality: this.quality, res: this.resolution, frameMs: QUALITY[this.quality].frameMs, t: Math.round(performance.now() / 1000) });
    this.onQualityChange?.();
  }

  /** CSS size, device pixel ratio and the backing size actually rendered (pixels per frame to fill). */
  private reportSize(): void {
    const res = this.resolution;
    perfContext({
      quality: this.quality,
      frameMs: Math.round(QUALITY[this.quality].frameMs),
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
