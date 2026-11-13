import { autoDetectRenderer, Container, type Renderer } from 'pixi.js';
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

type Updater = (dt: number) => boolean;

/**
 * WebGL renderer with an on-demand loop: frames run only while something animates,
 * so an idle board costs no GPU, no battery and no heat.
 */
export class Scene {
  public readonly root = new Container();
  public readonly tweens = new Tweens(() => this.request());
  /** called after a quality downgrade, so textures can be rebuilt for the new resolution */
  public onQualityChange: (() => void) | null = null;
  private readonly updaters: Updater[] = [];
  private quality = 0;
  private slowFrames = 0;
  private scheduled = false;
  private last = 0;
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
    // Resizing wipes the canvas; drawing now keeps a blank frame off the screen.
    this.renderer.render(this.root);
    this.request();
  }

  public addUpdater(fn: Updater): void {
    this.updaters.push(fn);
  }

  public request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.scheduled = false;
    const dt = this.last ? Math.min(50, now - this.last) : 16;
    this.last = now;

    this.tweens.update(dt);
    let active = this.tweens.active;
    for (const update of this.updaters) active = update(dt) || active;
    this.renderer.render(this.root);

    if (active) {
      this.trackSpeed(dt);
      this.request();
    } else {
      this.last = 0;
    }
  };

  private trackSpeed(dt: number): void {
    this.slowFrames = dt > SLOW_FRAME_MS ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
    if (this.slowFrames < SLOW_FRAMES_TO_DOWNGRADE || this.quality === QUALITY.length - 1) return;
    this.quality++;
    this.slowFrames = 0;
    this.renderer.resize(this.width, this.height, this.resolution);
    this.onQualityChange?.();
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
