import { Booster } from '@/core/types';
import { perfFlagFor } from '@/telemetry/perf';

/** How each booster's sparks fly: ms in the air, px out of the source, px the dive into the target starts above it, size. */
const FLIGHTS: Record<Booster, { ms: Range; out: Range; dive: Range; size: Range; twinkle: number }> = {
  // stars drift out wide and float down, twinkling
  [Booster.Star]: { ms: [900, 1250], out: [60, 130], dive: [90, 200], size: [0.75, 1.15], twinkle: 0.15 },
  // meteors pop out short and fall steep and fast
  [Booster.Meteor]: { ms: [700, 950], out: [35, 80], dive: [150, 280], size: [0.85, 1.2], twinkle: 0 },
};
/** the sparks of one gain take off one after another, this far apart, all within SPREAD_MS */
const GAP_MS = 60;
const SPREAD_MS = 650;
/** points sampled along a flight path: the compositor moves the spark straight between them */
const SAMPLES = 16;
/** the path's control points keep this far inside the screen: a Bézier curve never leaves their hull */
const MARGIN = 10;

type Range = [number, number];
type Point = { x: number; y: number };

/**
 * A win's gain flies into the boosters as sparks: little stars off the moves orb, little meteors off the score
 * bar's star marks. Each spark is an element flown by one Web Animation of transform and opacity along a curve
 * sampled once at take-off: the compositor runs the flight, so no frame of it costs the main thread anything,
 * and nothing repaints or lays out. The sparks of a gain go into the page in one append and leave in one pass.
 */
export class Sparks {
  public constructor(
    private readonly layer: HTMLElement,
    /** whether the effect is on (the effects menu can switch it off) */
    private readonly on: () => boolean,
  ) {}

  /**
   * Sends `count` sparks of booster `b` from one element into another. `onLand` runs as each one lands, with the one
   * unit of charge it carries; with no flight to show (the effect off, no source) it runs once, right after this call,
   * with all `count`. Resolves once every spark has landed.
   */
  public fly(b: Booster, from: Element | undefined, to: Element, count: number, onLand: (units: number) => void): Promise<void> {
    if (count <= 0) return Promise.resolve();
    if (!from || !this.on()) return Promise.resolve().then(() => onLand(count));
    const a = center(from);
    const z = center(to);
    const flight = FLIGHTS[b];
    const gap = Math.min(GAP_MS, SPREAD_MS / count);
    const sparks: HTMLElement[] = [];
    const fragment = document.createDocumentFragment();
    for (let k = 0; k < count; k++) {
      const el = document.createElement('i');
      el.className = `spark ${b}`;
      el.append(document.createElement('b'));
      fragment.append(el);
      sparks.push(el);
    }
    this.layer.append(fragment);
    let longest = 0;
    const landings = sparks.map((el, k) => {
      const duration = within(flight.ms);
      const delay = k * gap;
      longest = Math.max(longest, delay + duration);
      // `backwards`: a spark waiting for its turn sits invisible at its take-off point
      const anim = el.animate(path(a, z, flight), { duration, delay, fill: 'backwards' });
      return anim.finished.then(() => onLand(1));
    });
    perfFlagFor('hud', longest);
    return Promise.all(landings).then(() => {
      for (const el of sparks) el.remove();
    });
  }
}

/**
 * A cubic Bézier from `a` to `z`: the spark shoots out to one side of the straight line, then dives into the target
 * from above. It turns along its path, so its tail trails behind; it pops in at take-off and shrinks into the target.
 */
function path(a: Point, z: Point, flight: (typeof FLIGHTS)[Booster]): Keyframe[] {
  const chord = Math.atan2(z.y - a.y, z.x - a.x);
  const turn = chord + (Math.random() < 0.5 ? -1 : 1) * within([0.9, 2.3]);
  const out = within(flight.out);
  const p1 = onScreen({ x: a.x + Math.cos(turn) * out, y: a.y + Math.sin(turn) * out });
  const p2 = onScreen({ x: z.x + within([-90, 90]), y: z.y - within(flight.dive) });
  const size = within(flight.size);
  const frames: Keyframe[] = [];
  let angle = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const v = 1 - u;
    const x = v * v * v * a.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * z.x;
    const y = v * v * v * a.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * z.y;
    const dx = 3 * v * v * (p1.x - a.x) + 6 * v * u * (p2.x - p1.x) + 3 * u * u * (z.x - p2.x);
    const dy = 3 * v * v * (p1.y - a.y) + 6 * v * u * (p2.y - p1.y) + 3 * u * u * (z.y - p2.y);
    // unwrapped, so a turn past ±180° does not spin the spark the long way round
    const heading = (Math.atan2(dy, dx) * 180) / Math.PI;
    angle = i === 0 ? heading : angle + ((((heading - angle) % 360) + 540) % 360) - 180;
    const scale = i === 0 ? 0.3 : i === 1 ? 1.25 : i === SAMPLES ? 0.4 : 1 - flight.twinkle * (i % 2);
    frames.push({
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle.toFixed(1)}deg) scale(${(scale * size).toFixed(2)})`,
      opacity: i === 0 || i === SAMPLES ? 0 : 1,
    });
  }
  return frames;
}

function center(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The layer covers the viewport, so its size is the window's: no layout is read for it. */
function onScreen(p: Point): Point {
  const clamp = (v: number, max: number): number => Math.min(max - MARGIN, Math.max(MARGIN, v));
  return { x: clamp(p.x, innerWidth), y: clamp(p.y, innerHeight) };
}

function within([min, max]: Range): number {
  return min + Math.random() * (max - min);
}
