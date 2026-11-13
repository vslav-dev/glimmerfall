import { track } from '@/telemetry/telemetry';

/**
 * Performance telemetry: answers "is the game smooth on this device, and if not, where does the time go"
 * with few events. Every rendered frame lands in one aggregate that is sent as a single `perf` window event
 * when a level starts, the menu opens or the app hides. Besides windows: one `boot` event per session
 * and one `quality` event per automatic downgrade.
 *
 * A frame splits into the JS update (tweens, particles), the Pixi render submit (CPU) and the rest
 * of the interval (GPU, compositor, other main-thread work). Long frames and slow taps come from
 * the browser's own timing APIs (Chromium only); `ops` time the known heavy operations.
 */

type Data = Record<string, unknown>;

/** Frame intervals above these (ms) are counted: ~1.2, 2, 3 and 6 frames at 60 Hz. */
const SLOW_INTERVALS = [20, 33, 50, 100];
/** A window with less play than this carries over into the next one instead of being sent. */
const MIN_FRAMES = 30;
/** Taps that take longer than this to show their result are reported (the API rounds to 8 ms). */
const SLOW_INPUT_MS = 40;

interface LoafScript {
  invoker: string;
  sourceFunctionName: string;
  duration: number;
}

/** Long Animation Frame entry (Chromium 123+), not in the DOM typings yet. */
interface Loaf extends PerformanceEntry {
  blockingDuration: number;
  styleAndLayoutStart: number;
  scripts: LoafScript[];
}

/** Fixed-bin histogram: percentiles without keeping every sample. */
class Histogram {
  public count = 0;
  public sum = 0;
  public max = 0;
  private readonly bins: Uint32Array;

  public constructor(
    private readonly step: number,
    limit: number,
  ) {
    this.bins = new Uint32Array(Math.ceil(limit / step) + 1);
  }

  public add(value: number): void {
    this.bins[Math.min(this.bins.length - 1, Math.floor(value / this.step))]++;
    this.count++;
    this.sum += value;
    this.max = Math.max(this.max, value);
  }

  /** Upper edge of the bin holding the p-th sample; the overflow bin answers with the maximum. */
  public percentile(p: number): number {
    const target = Math.ceil(p * this.count);
    let seen = 0;
    for (let i = 0; i < this.bins.length - 1; i++) {
      seen += this.bins[i];
      if (seen >= target) return round((i + 1) * this.step);
    }
    return round(this.max);
  }

  public summary(): Data {
    return { avg: round(this.count ? this.sum / this.count : 0), p95: this.percentile(0.95), max: round(this.max) };
  }
}

function newWindow() {
  return {
    start: performance.now(),
    interval: new Histogram(0.5, 250),
    update: new Histogram(0.25, 50),
    render: new Histogram(0.25, 50),
    slow: SLOW_INTERVALS.map(() => 0),
    draws: 0,
    drawsMax: 0,
    loaf: { n: 0, ms: 0, blockMs: 0, layoutMs: 0, maxMs: 0, worst: '' },
    input: { n: 0, maxMs: 0, worst: null as Data | null },
    ops: new Map<string, { n: number; ms: number; max: number }>(),
  };
}

let win = newWindow();
/** what the window ran under: level, cell size, resolution, settings; kept up to date by their owners */
const context: Data = { level: null };
let frameDraws = 0;
let scriptAt = 0;
let loafSupported = false;
let eventsSupported = false;

/** Call first thing at startup. Hiding the app sends the open window. */
export function startPerf(): void {
  scriptAt = performance.now();
  loafSupported = observe('long-animation-frame', (list) => list.getEntries().forEach((e) => onLoaf(e as Loaf)));
  eventsSupported = observe('event', (list) => list.getEntries().forEach((e) => onInput(e as PerformanceEventTiming)), {
    durationThreshold: SLOW_INPUT_MS,
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPerf('hidden');
  });
}

/** Startup timeline, ms since navigation start. */
export function trackBoot(sceneAt: number): void {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  track('perf', {
    kind: 'boot',
    ttfb: nav ? round(nav.responseStart) : null,
    dom: nav ? round(nav.domContentLoadedEventEnd) : null,
    script: round(scriptAt),
    scene: round(sceneAt),
    ready: round(performance.now()),
    loaf: loafSupported,
    events: eventsSupported,
    heapMb: heapMb(),
  });
}

export function perfContext(data: Data): void {
  Object.assign(context, data);
}

/** `interval` is 0 for the first frame after idle: there is no previous frame to measure from. */
export function recordFrame(interval: number, updateMs: number, renderMs: number): void {
  if (interval > 0) {
    win.interval.add(interval);
    SLOW_INTERVALS.forEach((limit, k) => {
      if (interval > limit) win.slow[k]++;
    });
  }
  win.update.add(updateMs);
  win.render.add(renderMs);
  win.draws += frameDraws;
  win.drawsMax = Math.max(win.drawsMax, frameDraws);
  frameDraws = 0;
}

/** Times `fn`; a returned promise is timed until it settles. */
export function timed<T>(name: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const done = (): void => op(name, performance.now() - start);
  if (result instanceof Promise) result.then(done, done);
  else done();
  return result;
}

/** Counts WebGL draw calls per frame: one per batch, so it shows how well the board batches. */
export function countDraws(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  const target = gl as unknown as Record<string, unknown>;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = (...args: unknown[]): unknown => {
      frameDraws++;
      return (original as (...a: unknown[]) => unknown).apply(gl, args);
    };
  }
}

/** Sends the open window; `reason` names what ended it. */
export function flushPerf(reason: string): void {
  const w = win;
  if (w.update.count < MIN_FRAMES && w.loaf.n === 0 && w.input.n === 0) return;
  const now = performance.now();
  const i = w.interval;
  track('perf', {
    kind: 'window',
    reason,
    ...context,
    t: Math.round(now / 1000),
    sec: Math.round((now - w.start) / 1000),
    frames: w.update.count,
    activeMs: Math.round(i.sum),
    dt: { p10: i.percentile(0.1), p50: i.percentile(0.5), p95: i.percentile(0.95), p99: i.percentile(0.99), max: round(i.max) },
    slow: Object.fromEntries(SLOW_INTERVALS.map((limit, k) => [`>${limit}`, w.slow[k]])),
    update: w.update.summary(),
    render: w.render.summary(),
    draws: { avg: round(w.update.count ? w.draws / w.update.count : 0), max: w.drawsMax },
    loaf: loafSupported ? { ...w.loaf, ms: Math.round(w.loaf.ms), blockMs: Math.round(w.loaf.blockMs), layoutMs: Math.round(w.loaf.layoutMs) } : null,
    input: eventsSupported ? w.input : null,
    ops: Object.fromEntries([...w.ops].map(([name, o]) => [name, { n: o.n, ms: round(o.ms), max: round(o.max) }])),
    heapMb: heapMb(),
  });
  win = newWindow();
}

function op(name: string, ms: number): void {
  const o = win.ops.get(name) ?? { n: 0, ms: 0, max: 0 };
  o.n++;
  o.ms += ms;
  o.max = Math.max(o.max, ms);
  win.ops.set(name, o);
}

/** A frame that took over 50 ms; the worst one names its longest script. */
function onLoaf(e: Loaf): void {
  const l = win.loaf;
  l.n++;
  l.ms += e.duration;
  l.blockMs += e.blockingDuration;
  // From style and layout to the end of the frame: DOM rendering work, not script.
  if (e.styleAndLayoutStart > 0) l.layoutMs += e.startTime + e.duration - e.styleAndLayoutStart;
  if (e.duration <= l.maxMs) return;
  l.maxMs = Math.round(e.duration);
  const script = [...e.scripts].sort((a, b) => b.duration - a.duration)[0];
  l.worst = script ? `${script.invoker} ${script.sourceFunctionName} ${Math.round(script.duration)}ms`.replace(/\s+/g, ' ') : 'no script';
}

/** A slow input event, split into waiting for the main thread, handlers, and painting the result. */
function onInput(e: PerformanceEventTiming): void {
  if (!e.interactionId) return;
  const i = win.input;
  i.n++;
  if (e.duration <= i.maxMs) return;
  i.maxMs = e.duration;
  i.worst = {
    type: e.name,
    delay: round(e.processingStart - e.startTime),
    handlers: round(e.processingEnd - e.processingStart),
    paint: round(e.startTime + e.duration - e.processingEnd),
  };
}

function observe(type: string, callback: PerformanceObserverCallback, options: Data = {}): boolean {
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return false;
  try {
    new PerformanceObserver(callback).observe({ type, ...options });
    return true;
  } catch {
    return false;
  }
}

/** Chromium only. */
function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 2 ** 20) : null;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
