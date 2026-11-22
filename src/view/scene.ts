import { autoDetectRenderer, Container, type Renderer } from 'pixi.js';
import { countDraws, perfContext, perfCount, perfFlag, recordFrame, recordIdleFrame } from '@/telemetry/perf';
import { track } from '@/telemetry/telemetry';
import { Tweens } from '@/view/tween';

/** Quality steps the scene falls back through for good when frames stay slow. */
const QUALITY = [
  { maxResolution: 2, particles: 1 },
  { maxResolution: 1.5, particles: 0.6 },
  { maxResolution: 1, particles: 0.35 },
];
/**
 * Pacing, before any quality step and undone once the phone keeps up: a high-refresh screen whose frames slip
 * (a warm, throttled phone) draws every other frame, a steady 60 fps instead of a jittery 120 at half the GPU
 * work. It is judged over blocks of drawn moving frames: a block with a few slow ones turns it on; a run of
 * clean blocks turns it off, a run twice as long after each next time it came back.
 */
const HIGH_REFRESH_MS = 12;
const PACED_FRAME_MS = 1000 / 60;
const PACE_BLOCK = 120;
const PACE_SLOW_MS = 20;
const PACE_ON_SLOW = 4;
const PACE_OFF_SLOW = 1;
const PACE_OFF_BLOCKS = 10;
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
  private last = 0;
  /** when the last frame was drawn, to keep the calm and the paced frame rates */
  private lastDrawn = 0;
  /** the shortest frame interval seen: tells a high-refresh screen */
  private fastest = Infinity;
  private paced = false;
  private pace = { frames: 0, slow: 0, clean: 0, offAfter: PACE_OFF_BLOCKS };
  private width = 1;
  private height = 1;

  private constructor(private readonly renderer: Renderer) {}

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
    const gap = calm ? CALM_FRAME_MS : this.paced ? PACED_FRAME_MS : 0;
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
      this.renderer.render(this.root);
      const rendered = performance.now();
      recordFrame({ interval, updateMs: updated - start, renderMs: rendered - updated });
    } else {
      recordIdleFrame();
    }

    if (this.tweens.active || this.stopLeft > 0 || animating || calmAnimating || this.dirty || this.animated || this.calmAnimated) {
      if (draw && !calm) {
        this.trackPace(interval);
        this.trackSpeed(dt);
      }
      this.schedule();
    } else {
      this.last = 0;
    }
  };

  private trackPace(interval: number): void {
    if (this.fastest >= HIGH_REFRESH_MS || interval === 0) return;
    const p = this.pace;
    p.frames++;
    if (interval > PACE_SLOW_MS) p.slow++;
    if (p.frames < PACE_BLOCK) return;
    if (!this.paced && p.slow >= PACE_ON_SLOW) {
      this.setPaced(true);
    } else if (this.paced) {
      p.clean = p.slow <= PACE_OFF_SLOW ? p.clean + 1 : 0;
      if (p.clean >= p.offAfter) {
        this.setPaced(false);
        p.offAfter *= 2;
      }
    }
    p.frames = 0;
    p.slow = 0;
  }

  private setPaced(on: boolean): void {
    this.paced = on;
    this.pace.clean = 0;
    perfFlag('paced', on);
    perfCount(on ? 'pace-on' : 'pace-off');
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
