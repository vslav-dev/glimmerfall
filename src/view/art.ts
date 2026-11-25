import { MAX_COLORS, NO_COLOR, Special } from '@/core/types';

/**
 * All game art, drawn procedurally with Canvas 2D. The same painters feed the WebGL atlas
 * and the small DOM icons, so a piece looks identical everywhere and costs zero bytes of assets.
 */

interface Palette {
  base: string;
  light: string;
  dark: string;
}

/** Each color also has its own silhouette, so the game is readable without color vision. */
export const GEM_PALETTES: Palette[] = [
  { base: '#ff4f6d', light: '#ffd0d8', dark: '#9e1236' },
  { base: '#ffbe2e', light: '#fff1c4', dark: '#a8650a' },
  { base: '#35d07f', light: '#c9ffe0', dark: '#0d7a45' },
  { base: '#3f8cff', light: '#cfe3ff', dark: '#1543a8' },
  { base: '#a65cff', light: '#ead6ff', dark: '#5a1ea8' },
  { base: '#2fe0e0', light: '#d0ffff', dark: '#0a7f8a' },
];

/** Hex tint per color for particles. */
export const GEM_TINTS = GEM_PALETTES.map((p) => parseInt(p.base.slice(1), 16));

export const FrameName = {
  gem: (color: number, special: Special): string => `gem-${color}-${special}`,
  Prism: 'prism',
  Pearl: 'pearl',
  /** a glowing lip with a chevron at the bottom edge of a column: where pearls leave */
  Exit: 'exit',
  TileA: 'tile-a',
  TileB: 'tile-b',
  ice: (layers: number): string => `ice-${layers}`,
  crate: (strength: number): string => `crate-${strength}`,
  chain: (layers: number): string => `chain-${layers}`,
  /** the bit a hit knocks off a crate, leaving it at `strength` */
  crateBit: (strength: number): string => `crate-bit-${strength}`,
  /** one of the boards a crate bursts into */
  cratePiece: (k: number): string => `crate-piece-${k}`,
  /** a torn-off run of this many chain links */
  chainBit: (links: number): string => `chain-bit-${links}`,
  ChainBolt: 'chain-bolt',
  Dot: 'dot',
  Star: 'star',
  Ring: 'ring',
  Beam: 'beam',
  Glow: 'glow',
  /** soft horizontal streak, stretched along a flight */
  Streak: 'streak',
  /** the falling star booster: a golden star with a white-hot core */
  FallingStar: 'falling-star',
  /** the meteor booster: a dark rock glowing through its cracks */
  Meteor: 'meteor',
  /** a cell in a booster's aim: a soft rounded square with a bright rim, white to be tinted */
  Aim: 'aim',
  /** shockwave: a bright rim fading inward */
  Shock: 'shock',
  /** wood splinter */
  Chip: 'chip',
  /** one of SHARDS pieces a gem breaks into */
  shard: (color: number, k: number): string => `shard-${color}-${k % SHARDS}`,
  /** the piece's outline filled white: it flashes over the piece as it is hit */
  silhouette: (color: number): string => `silhouette-${color === NO_COLOR ? 'prism' : color}`,
} as const;

export const SHARDS = 4;

/** Chain per layer, bottom to top: ends (cell units) and sag. Each one hangs at its own angle. */
const CHAIN_LAYERS: { from: [number, number]; to: [number, number]; sag: number }[] = [
  { from: [0.07, 0.24], to: [0.93, 0.34], sag: 0.22 },
  { from: [0.07, 0.56], to: [0.93, 0.28], sag: 0.3 },
  { from: [0.07, 0.12], to: [0.93, 0.5], sag: 0.12 },
  { from: [0.07, 0.74], to: [0.93, 0.7], sag: 0.12 },
];

/**
 * A piece of a blocker thrown off as it breaks. Its frame is drawn centered on the piece; `x`, `y` say
 * where that center sits from the cell's center and `angle` how the frame is turned there, cell units.
 */
export interface Fragment {
  frame: string;
  x: number;
  y: number;
  angle: number;
}

type Pt = [number, number];

/**
 * Crate geometry in its unit square (the cell minus the crate's margin): the frame board width and the height
 * of each of the three planks inside it. The frame's edges in that square bound every knocked-out area.
 */
const CRATE_INSET = 0.06;
const CRATE_FRAME = 0.15;
const CRATE_PLANK = (1 - CRATE_FRAME * 2) / 3;
const CELL_LO = -CRATE_INSET / (1 - CRATE_INSET * 2);
const CELL_HI = 1 - CELL_LO;

/** The first hit knocks the top right corner off: its broken edge runs from the top board down the right one. */
const CRATE_CORNER_EDGE: Pt[] = [[0.62, CELL_LO], [0.66, 0.05], [0.75, 0.07], [0.79, 0.15], [0.88, 0.18], [0.9, 0.27], [CELL_HI, 0.33]];
const CRATE_CORNER: Pt[] = [...CRATE_CORNER_EDGE, [CELL_HI, CELL_LO]];
/** The second breaks a chunk out of the bottom plank, clear of the brace. */
const CRATE_HOLE: Pt[] = [[0.47, 0.7], [0.54, 0.64], [0.62, 0.67], [0.69, 0.62], [0.77, 0.66], [0.83, 0.63], [0.83, 0.74], [0.77, 0.8], [0.68, 0.78], [0.6, 0.82], [0.52, 0.77]];

/** A row of the crate from `x0` to `x1`, snapped at `at` along a jagged break, or whole. */
function cratePieces(y0: number, y1: number, x0: number, x1: number, at: number | null): Pt[][] {
  if (at === null) return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
  const h = y1 - y0;
  const jag: Pt[] = [[at + 0.04, y0 + h * 0.35], [at - 0.03, y0 + h * 0.7]];
  return [
    [[x0, y0], [at, y0], ...jag, [at, y1], [x0, y1]],
    [[at, y0], [x1, y0], [x1, y1], [at, y1], jag[1], jag[0]],
  ];
}

/** The last hit bursts the crate into its boards: the frame's four, the planks snapped across the grain. */
const CRATE_BURST: Pt[][] = [
  ...cratePieces(CELL_LO, CRATE_FRAME, CELL_LO, CELL_HI, 0.45),
  ...cratePieces(1 - CRATE_FRAME, CELL_HI, CELL_LO, CELL_HI, null),
  ...cratePieces(CRATE_FRAME, 1 - CRATE_FRAME, CELL_LO, CRATE_FRAME, null),
  ...cratePieces(CRATE_FRAME, 1 - CRATE_FRAME, 1 - CRATE_FRAME, CELL_HI, null),
  ...[0.38, null, 0.58].flatMap((at, k) =>
    cratePieces(CRATE_FRAME + k * CRATE_PLANK, CRATE_FRAME + (k + 1) * CRATE_PLANK, CRATE_FRAME, 1 - CRATE_FRAME, at),
  ),
];

/** Middle of a polygon in the crate's unit square, and that point from the cell's center, cell units. */
function crateCenter(points: Pt[]): { unit: Pt; cell: Pt } {
  const unit: Pt = [points.reduce((a, p) => a + p[0], 0) / points.length, points.reduce((a, p) => a + p[1], 0) / points.length];
  const k = 1 - CRATE_INSET * 2;
  return { unit, cell: [CRATE_INSET + unit[0] * k - 0.5, CRATE_INSET + unit[1] * k - 0.5] };
}

const crateFragment = (frame: string, points: Pt[]): Fragment => {
  const [x, y] = crateCenter(points).cell;
  return { frame, x, y, angle: 0 };
};

/** The bit a hit knocks off, by the strength the crate is left with. */
export const CRATE_BITS: Record<number, Fragment> = {
  2: crateFragment(FrameName.crateBit(2), CRATE_CORNER),
  1: crateFragment(FrameName.crateBit(1), CRATE_HOLE),
};
export const CRATE_PIECES: Fragment[] = CRATE_BURST.map((points, k) => crateFragment(FrameName.cratePiece(k), points));

/** Link pitch along a chain, cell units. */
const CHAIN_PITCH = 0.1;
/** Where each layer's chain tears, as shares of its length: three runs of links, so no two layers tear alike. */
const CHAIN_TEARS: [number, number][] = [
  [0.3, 0.64],
  [0.38, 0.7],
  [0.27, 0.6],
  [0.42, 0.74],
];

/** Link count of each run frame the layers tear into. */
const CHAIN_RUN_LINKS = new Map<string, number>();

/** A layer's chain torn in three runs of links, each straight from its first link to its last, and its two bolts. */
function chainFragments(spec: (typeof CHAIN_LAYERS)[number], tears: [number, number]): Fragment[] {
  const { links, ends } = chainLinks(1, spec.from, spec.to, spec.sag);
  const n = links.length;
  const bounds = [0, Math.round(tears[0] * n), Math.round(tears[1] * n), n];
  const runs = bounds.slice(1).map((end, k): Fragment => {
    const a = links[bounds[k]];
    const b = links[end - 1];
    const frame = FrameName.chainBit(end - bounds[k]);
    CHAIN_RUN_LINKS.set(frame, end - bounds[k]);
    return { frame, x: (a.x + b.x) / 2 - 0.5, y: (a.y + b.y) / 2 - 0.5, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  });
  return [...runs, ...ends.map(([x, y]): Fragment => ({ frame: FrameName.ChainBolt, x: x - 0.5, y: y - 0.5, angle: 0 }))];
}

/** What flies off as each layer's chain breaks, bottom layer first. */
export const CHAIN_BITS: Fragment[][] = CHAIN_LAYERS.map((spec, k) => chainFragments(spec, CHAIN_TEARS[k]));

type Painter = (ctx: CanvasRenderingContext2D, s: number) => void;

function buildPainters(): Map<string, Painter> {
  const painters = new Map<string, Painter>();
  const specials = [Special.None, Special.LineH, Special.LineV, Special.Bomb];
  for (let color = 0; color < MAX_COLORS; color++) {
    for (const special of specials) {
      painters.set(FrameName.gem(color, special), (ctx, s) => drawGem(ctx, s, color, special));
    }
  }
  painters.set(FrameName.Prism, drawPrism);
  painters.set(FrameName.Pearl, drawPearl);
  painters.set(FrameName.Exit, drawExit);
  painters.set(FrameName.TileA, (ctx, s) => drawTile(ctx, s, 0.075));
  painters.set(FrameName.TileB, (ctx, s) => drawTile(ctx, s, 0.12));
  painters.set(FrameName.ice(1), (ctx, s) => drawIce(ctx, s, 1));
  painters.set(FrameName.ice(2), (ctx, s) => drawIce(ctx, s, 2));
  for (const strength of [1, 2, 3]) painters.set(FrameName.crate(strength), (ctx, s) => drawCrate(ctx, s, strength));
  for (let layers = 1; layers <= CHAIN_LAYERS.length; layers++) painters.set(FrameName.chain(layers), (ctx, s) => drawChain(ctx, s, layers));
  // A bit is cut from the crate as it was before the hit; the burst, from the last crate.
  painters.set(FrameName.crateBit(2), (ctx, s) => drawCrateFragment(ctx, s, CRATE_CORNER, 3));
  painters.set(FrameName.crateBit(1), (ctx, s) => drawCrateFragment(ctx, s, CRATE_HOLE, 2));
  CRATE_BURST.forEach((points, k) => painters.set(FrameName.cratePiece(k), (ctx, s) => drawCrateFragment(ctx, s, points, 1)));
  for (const [frame, links] of CHAIN_RUN_LINKS) painters.set(frame, (ctx, s) => drawChainRun(ctx, s, links));
  painters.set(FrameName.ChainBolt, (ctx, s) => drawBolt(ctx, s, s / 2, s / 2));
  painters.set(FrameName.Dot, drawDot);
  painters.set(FrameName.Star, (ctx, s) => {
    ctx.fillStyle = '#fff';
    drawSparkle(ctx, s / 2, s / 2, s * 0.48, 1);
  });
  painters.set(FrameName.Ring, drawRing);
  painters.set(FrameName.Beam, drawBeam);
  painters.set(FrameName.Glow, drawGlow);
  painters.set(FrameName.Streak, drawStreak);
  painters.set(FrameName.Shock, drawShock);
  painters.set(FrameName.FallingStar, drawFallingStar);
  painters.set(FrameName.Meteor, drawMeteor);
  painters.set(FrameName.Aim, drawAim);
  painters.set(FrameName.Chip, drawChip);
  for (let color = 0; color < MAX_COLORS; color++) {
    for (let k = 0; k < SHARDS; k++) painters.set(FrameName.shard(color, k), (ctx, s) => drawShard(ctx, s, color, k));
    painters.set(FrameName.silhouette(color), (ctx, s) => drawSilhouette(ctx, s, SHAPES[color], 0.4));
  }
  painters.set(FrameName.silhouette(NO_COLOR), (ctx, s) => drawSilhouette(ctx, s, SHAPES[0], 0.42));
  return painters;
}

export const PAINTERS = buildPainters();

/**
 * Canvas 2D context the painters draw into. `willReadFrequently` keeps the canvas on the CPU rasterizer:
 * the GPU one is driver-dependent, and on some Mali GPUs it inflates every translucent pixel
 * (a 0.075 tile reads as ~0.46, soft shadows turn into thick black outlines). The CPU result is the same
 * on every device, and it costs nothing here: frames are painted once per cell size, then uploaded.
 */
export function paintContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext('2d', { willReadFrequently: true })!;
}

/** Small standalone image of a frame, for DOM icons. */
export function frameDataUrl(name: string, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  PAINTERS.get(name)?.(paintContext(canvas), size);
  return canvas.toDataURL();
}

// ---------- shapes ----------

type Shape = (ctx: CanvasRenderingContext2D, r: number) => void;

function polygon(ctx: CanvasRenderingContext2D, points: [number, number][], round: number): void {
  const n = points.length;
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(points[n - 1], points[0]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i];
    const [nx, ny] = mid(points[i], points[(i + 1) % n]);
    ctx.arcTo(x, y, nx, ny, round);
  }
  ctx.closePath();
}

function regular(sides: number, r: number, rotation: number, inner = 0): [number, number][] {
  const pts: [number, number][] = [];
  const count = inner > 0 ? sides * 2 : sides;
  for (let i = 0; i < count; i++) {
    const a = rotation + (i * Math.PI * 2) / count;
    const rad = inner > 0 && i % 2 === 1 ? inner : r;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  return pts;
}

const SHAPES: Shape[] = [
  (ctx, r) => {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.95, 0, Math.PI * 2);
  },
  (ctx, r) => polygon(ctx, [[0, -r * 1.05], [r * 0.85, 0], [0, r * 1.05], [-r * 0.85, 0]], r * 0.18),
  (ctx, r) => {
    // leaf / drop
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.02);
    ctx.bezierCurveTo(r * 0.75, -r * 0.35, r * 0.95, r * 0.25, 0, r * 0.98);
    ctx.bezierCurveTo(-r * 0.95, r * 0.25, -r * 0.75, -r * 0.35, 0, -r * 1.02);
    ctx.closePath();
  },
  (ctx, r) => polygon(ctx, regular(6, r * 1.0, Math.PI / 6), r * 0.2),
  (ctx, r) => polygon(ctx, regular(5, r * 1.06, -Math.PI / 2, r * 0.55), r * 0.12),
  (ctx, r) => polygon(ctx, regular(4, r * 1.12, Math.PI / 4), r * 0.3),
];

// ---------- painters ----------

function drawGem(ctx: CanvasRenderingContext2D, s: number, color: number, special: Special): void {
  const p = GEM_PALETTES[color];
  const r = s * 0.4;
  const shape = SHAPES[color];
  ctx.save();
  ctx.translate(s / 2, s / 2);

  // The shadow takes the gem's own dark color: it reads as depth, not as a black outline.
  ctx.save();
  ctx.shadowColor = `${p.dark}b3`;
  ctx.shadowBlur = s * 0.07;
  ctx.shadowOffsetY = s * 0.035;
  shape(ctx, r);
  ctx.fillStyle = p.base;
  ctx.fill();
  ctx.restore();

  const body = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.05, 0, 0, r * 1.15);
  body.addColorStop(0, p.light);
  body.addColorStop(0.45, p.base);
  body.addColorStop(1, p.dark);
  shape(ctx, r);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.lineWidth = s * 0.022;
  ctx.strokeStyle = p.dark;
  ctx.stroke();

  ctx.save();
  shape(ctx, r);
  ctx.clip();
  // Light bounced up from below: the lower edge glows in the gem's light color, so it looks lit through.
  const bounce = ctx.createRadialGradient(r * 0.2, r * 0.75, 0, r * 0.2, r * 0.75, r * 0.75);
  bounce.addColorStop(0, `${p.light}80`);
  bounce.addColorStop(1, `${p.light}00`);
  ctx.fillStyle = bounce;
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
  drawSpecialMark(ctx, r, special);
  const shine = ctx.createRadialGradient(-r * 0.3, -r * 0.5, 0, -r * 0.3, -r * 0.5, r * 0.7);
  shine.addColorStop(0, 'rgba(255,255,255,0.75)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.ellipse(-r * 0.25, -r * 0.45, r * 0.55, r * 0.32, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // Sparkle: inside the clip and close enough to the center to sit within every shape (the star's notches included).
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.32, r * 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawSpecialMark(ctx: CanvasRenderingContext2D, r: number, special: Special): void {
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = r * 0.25;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  switch (special) {
    case Special.LineH:
      for (const y of [-0.22, 0.22]) ctx.fillRect(-r * 1.2, r * (y - 0.06), r * 2.4, r * 0.12);
      break;
    case Special.LineV:
      for (const x of [-0.22, 0.22]) ctx.fillRect(r * (x - 0.06), -r * 1.2, r * 0.12, r * 2.4);
      break;
    case Special.Bomb:
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.arc(0, r * 0.05, r * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r * 0.05, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}

function drawPrism(ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.42;
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.06;
  ctx.shadowOffsetY = s * 0.035;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  const hues = ['#ff4f6d', '#ffbe2e', '#35d07f', '#2fe0e0', '#3f8cff', '#a65cff', '#ff4f6d'];
  // Conic gradients are missing only in very old WebViews; a diagonal rainbow is a fine fallback there.
  const rainbow = typeof ctx.createConicGradient === 'function' ? ctx.createConicGradient(0, 0, 0) : ctx.createLinearGradient(-r, -r, r, r);
  hues.forEach((h, i) => rainbow.addColorStop(i / (hues.length - 1), h));
  ctx.fillStyle = rainbow;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const glass = ctx.createRadialGradient(-r * 0.3, -r * 0.35, 0, 0, 0, r);
  glass.addColorStop(0, 'rgba(255,255,255,0.85)');
  glass.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  glass.addColorStop(1, 'rgba(40,0,80,0.35)');
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.lineWidth = s * 0.025;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.stroke();
  ctx.shadowColor = 'rgba(255,255,255,1)';
  ctx.shadowBlur = r * 0.3;
  ctx.fillStyle = '#fff';
  drawSparkle(ctx, 0, 0, r * 0.55, 1);
  ctx.restore();
}

/** Pearl tints: a milky white body whose sheen turns pink, lilac and mint, so it reads apart from the rainbow prism. */
const PEARL = { light: '#fffdf8', base: '#efe6f2', dark: '#a493b4', rim: '#7d6c90' };

/** A milky sphere with a soft iridescent sheen, a bright window highlight and a dark rim so it holds on any tile. */
function drawPearl(ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.37;
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.save();
  ctx.shadowColor = 'rgba(60,30,90,0.55)';
  ctx.shadowBlur = s * 0.07;
  ctx.shadowOffsetY = s * 0.035;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r * 1.05);
  body.addColorStop(0, PEARL.light);
  body.addColorStop(0.55, PEARL.base);
  body.addColorStop(1, PEARL.dark);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  // Iridescence: faint pink, lilac and mint washes swept round the lower half, where the light comes through.
  for (const [x, y, color] of [
    [r * 0.45, r * 0.35, 'rgba(255,170,205,0.45)'],
    [-r * 0.4, r * 0.45, 'rgba(170,235,215,0.4)'],
    [r * 0.05, r * 0.75, 'rgba(190,170,255,0.45)'],
  ] as [number, number, string][]) {
    const wash = ctx.createRadialGradient(x, y, 0, x, y, r * 0.75);
    wash.addColorStop(0, color);
    wash.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(-r, -r, r * 2, r * 2);
  }
  const shine = ctx.createRadialGradient(-r * 0.32, -r * 0.42, 0, -r * 0.32, -r * 0.42, r * 0.55);
  shine.addColorStop(0, 'rgba(255,255,255,0.95)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.42, r * 0.42, r * 0.28, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.lineWidth = s * 0.022;
  ctx.strokeStyle = PEARL.rim;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(-r * 0.38, -r * 0.45, r * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The bottom edge of a cell where pearls leave: a soft glowing lip and a small chevron pointing down, under the piece. */
function drawExit(ctx: CanvasRenderingContext2D, s: number): void {
  const lip = ctx.createLinearGradient(0, s * 0.72, 0, s);
  lip.addColorStop(0, 'rgba(255,240,255,0)');
  lip.addColorStop(1, 'rgba(255,240,255,0.5)');
  ctx.fillStyle = lip;
  roundRect(ctx, s * 0.1, s * 0.72, s * 0.8, s * 0.26, s * 0.1);
  ctx.fill();
  ctx.save();
  ctx.shadowColor = 'rgba(255,220,255,0.9)';
  ctx.shadowBlur = s * 0.04;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = s * 0.04;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s * 0.4, s * 0.885);
  ctx.lineTo(s * 0.5, s * 0.955);
  ctx.lineTo(s * 0.6, s * 0.885);
  ctx.stroke();
  ctx.restore();
}

/** Built on `arcTo`: `ctx.roundRect` is missing in older browsers (Safari < 16, Chrome < 99). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  polygon(ctx, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r);
}

function drawTile(ctx: CanvasRenderingContext2D, s: number, alpha: number): void {
  roundRect(ctx, s * 0.03, s * 0.03, s * 0.94, s * 0.94, s * 0.18);
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.fill();
}

function drawIce(ctx: CanvasRenderingContext2D, s: number, layers: number): void {
  const strong = layers > 1;
  roundRect(ctx, s * 0.05, s * 0.05, s * 0.9, s * 0.9, s * 0.16);
  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, strong ? 'rgba(220,245,255,0.85)' : 'rgba(210,240,255,0.6)');
  g.addColorStop(1, strong ? 'rgba(120,190,255,0.75)' : 'rgba(140,200,255,0.42)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = s * 0.03;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = s * 0.025;
  ctx.beginPath();
  ctx.moveTo(s * 0.18, s * 0.42);
  ctx.lineTo(s * 0.42, s * 0.18);
  ctx.moveTo(s * 0.18, s * 0.6);
  ctx.lineTo(s * 0.6, s * 0.18);
  if (strong) {
    ctx.moveTo(s * 0.55, s * 0.82);
    ctx.lineTo(s * 0.82, s * 0.55);
  }
  ctx.stroke();
}

/** One palette for every strength: only the damage changes, so all crates read as the same object. */
const CRATE_WOOD = {
  frameLight: '#e4ad6a',
  frameDark: '#b9783b',
  plankLight: '#bf8043',
  plankDark: '#965b29',
  raw: '#f3d39f',
  line: '#5a3114',
  hollow: '#2c170a',
};

/** Grain per plank: plank index, line height within it, and bend. */
const CRATE_GRAIN: [number, number, number][] = [
  [0, 0.35, 0.04],
  [0, 0.72, -0.03],
  [1, 0.3, -0.04],
  [1, 0.7, 0.03],
  [2, 0.38, 0.035],
  [2, 0.74, -0.025],
];

/**
 * The same crate at every strength: a frame of four boards around three planks, crossed by a brace.
 * Each lost point of strength adds damage on top of the previous one, and the wood darkens as it takes it:
 * first the top right corner is knocked off and the wood cracks, then a chunk of the bottom plank breaks out,
 * the brace snaps and a nail pops.
 */
function drawCrate(ctx: CanvasRenderingContext2D, s: number, strength: number): void {
  inCrate(ctx, s, () => drawCrateBody(ctx, s, 3 - strength));
}

/** Paints in the crate's unit square: the cell minus the crate's margin. */
function inCrate(ctx: CanvasRenderingContext2D, s: number, paint: () => void): void {
  const inset = s * CRATE_INSET;
  ctx.save();
  ctx.translate(inset, inset);
  ctx.scale(s - inset * 2, s - inset * 2);
  paint();
  ctx.restore();
}

function drawCrateBody(ctx: CanvasRenderingContext2D, s: number, damage: number): void {
  const body = (): void => roundRect(ctx, 0, 0, 1, 1, 0.12);
  // Shadow offsets are in pixels: the transform does not scale them.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.05;
  ctx.shadowOffsetY = s * 0.03;
  body();
  ctx.fillStyle = CRATE_WOOD.line;
  ctx.fill();
  ctx.restore();

  ctx.save();
  body();
  ctx.clip();
  drawCratePlanks(ctx, damage);
  drawCrateBrace(ctx, s, damage);
  drawCrateFrame(ctx, s, damage);
  ctx.fillStyle = `rgba(40,16,2,${damage * 0.12})`;
  ctx.fillRect(0, 0, 1, 1);
  ctx.restore();

  body();
  ctx.lineWidth = 0.04;
  ctx.strokeStyle = CRATE_WOOD.line;
  ctx.stroke();
  if (damage >= 1) knockOut(ctx, CRATE_CORNER_EDGE, CRATE_CORNER, body);
}

/**
 * A bit gone from the crate: the frame's own pixels erased there, so the tile shows through, and bare wood
 * along the broken edge. The erased area stays inside the cell's frame: past it lie the atlas's other frames.
 */
function knockOut(ctx: CanvasRenderingContext2D, edge: Pt[], area: Pt[], body: () => void): void {
  ctx.save();
  body();
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  path(ctx, edge, false);
  ctx.lineWidth = 0.06;
  ctx.strokeStyle = CRATE_WOOD.raw;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  path(ctx, area, true);
  ctx.fill();
  ctx.restore();
}

/**
 * A piece of the crate as it was at `strength`, drawn centered on the piece, so a sprite turns about its middle.
 * Clipped to the frame first: a centered piece must not spill into the atlas's other frames.
 */
function drawCrateFragment(ctx: CanvasRenderingContext2D, s: number, points: Pt[], strength: number): void {
  const [x, y] = crateCenter(points).cell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s, s);
  ctx.clip();
  ctx.translate(-x * s, -y * s);
  inCrate(ctx, s, () => {
    path(ctx, points, true);
    ctx.clip();
    drawCrateBody(ctx, s, 3 - strength);
  });
  ctx.restore();
}

function drawCratePlanks(ctx: CanvasRenderingContext2D, damage: number): void {
  const F = CRATE_FRAME;
  const h = CRATE_PLANK;
  for (let k = 0; k < 3; k++) {
    const y = F + k * h;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, CRATE_WOOD.plankLight);
    g.addColorStop(1, CRATE_WOOD.plankDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, 1, h);
  }

  ctx.beginPath();
  for (const [k, at, bend] of CRATE_GRAIN) {
    const y = F + (k + at) * h;
    ctx.moveTo(F, y);
    ctx.quadraticCurveTo(0.5, y + bend, 1 - F, y - bend * 0.4);
  }
  ctx.lineWidth = 0.012;
  ctx.strokeStyle = 'rgba(70,35,10,0.3)';
  ctx.stroke();

  // Seams between planks: a dark gap with a lit top edge on the plank below.
  for (const k of [1, 2]) {
    const y = F + k * h;
    ctx.fillStyle = CRATE_WOOD.line;
    ctx.fillRect(0, y - 0.013, 1, 0.026);
    ctx.fillStyle = 'rgba(255,225,180,0.3)';
    ctx.fillRect(0, y + 0.013, 1, 0.012);
  }

  if (damage >= 1) {
    crateCrack(ctx, [[0.15, 0.27], [0.23, 0.245], [0.3, 0.285], [0.38, 0.26], [0.46, 0.3]]);
  }
  if (damage >= 2) {
    crateCrack(ctx, [[0.62, 0.53], [0.7, 0.49], [0.77, 0.535], [0.86, 0.5]]);
    path(ctx, CRATE_HOLE, true);
    ctx.fillStyle = CRATE_WOOD.hollow;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.022;
    ctx.strokeStyle = CRATE_WOOD.raw;
    ctx.stroke();
    crateCrack(ctx, [[0.47, 0.7], [0.4, 0.73], [0.33, 0.7], [0.25, 0.74]]);
  }
}

/** Diagonal brace from the bottom-left corner to the top-right one; at the last strength it is snapped in two. */
function drawCrateBrace(ctx: CanvasRenderingContext2D, s: number, damage: number): void {
  const L = 0.62;
  const t = 0.075;
  const pieces: Pt[][] =
    damage >= 2
      ? [
          [[-L, -t], [0.02, -t], [0.05, -t / 2], [0, 0], [0.04, t / 2], [-0.01, t], [-L, t]],
          [[0.1, -t], [L, -t], [L, t], [0.07, t], [0.1, t / 2], [0.06, 0], [0.11, -t / 2]],
        ]
      : [[[-L, -t], [L, -t], [L, t], [-L, t]]];
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.rotate(-Math.PI / 4);
  const g = ctx.createLinearGradient(0, -t, 0, t);
  g.addColorStop(0, CRATE_WOOD.frameLight);
  g.addColorStop(1, CRATE_WOOD.frameDark);
  for (const piece of pieces) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = s * 0.03;
    ctx.shadowOffsetY = s * 0.02;
    path(ctx, piece, true);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.022;
    ctx.strokeStyle = CRATE_WOOD.line;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrateFrame(ctx: CanvasRenderingContext2D, s: number, damage: number): void {
  const F = CRATE_FRAME;
  const G = 1 - F;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = s * 0.03;
  ctx.shadowOffsetY = s * 0.015;
  ctx.beginPath();
  ctx.rect(0, 0, 1, 1);
  ctx.rect(F, F, 1 - F * 2, 1 - F * 2);
  const g = ctx.createLinearGradient(0, 0, 0, 1);
  g.addColorStop(0, CRATE_WOOD.frameLight);
  g.addColorStop(1, CRATE_WOOD.frameDark);
  ctx.fillStyle = g;
  ctx.fill('evenodd');
  ctx.restore();

  // Grain along each board, then the lit outer edges.
  ctx.beginPath();
  ctx.moveTo(0.08, F * 0.55);
  ctx.quadraticCurveTo(0.5, F * 0.3, 0.92, F * 0.6);
  ctx.moveTo(0.08, G + F * 0.5);
  ctx.quadraticCurveTo(0.5, G + F * 0.7, 0.92, G + F * 0.45);
  ctx.moveTo(F * 0.5, F + 0.05);
  ctx.quadraticCurveTo(F * 0.7, 0.5, F * 0.45, G - 0.05);
  ctx.moveTo(G + F * 0.5, F + 0.05);
  ctx.quadraticCurveTo(G + F * 0.3, 0.5, G + F * 0.55, G - 0.05);
  ctx.lineWidth = 0.012;
  ctx.strokeStyle = 'rgba(90,45,15,0.3)';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0.06, 0.035);
  ctx.lineTo(0.94, 0.035);
  ctx.moveTo(0.035, F + 0.02);
  ctx.lineTo(0.035, G - 0.02);
  ctx.moveTo(F + 0.02, G + 0.03);
  ctx.lineTo(G - 0.02, G + 0.03);
  ctx.lineWidth = 0.014;
  ctx.strokeStyle = 'rgba(255,238,205,0.5)';
  ctx.stroke();

  // Inner edge and the joints: top and bottom boards run the full width, the side boards sit between them.
  ctx.beginPath();
  ctx.rect(F, F, 1 - F * 2, 1 - F * 2);
  for (const y of [F, G]) {
    ctx.moveTo(0, y);
    ctx.lineTo(F, y);
    ctx.moveTo(G, y);
    ctx.lineTo(1, y);
  }
  ctx.lineWidth = 0.022;
  ctx.strokeStyle = CRATE_WOOD.line;
  ctx.stroke();

  if (damage >= 1) {
    crateChip(ctx, [[0.2, -0.01], [0.25, 0.075], [0.33, 0.05], [0.39, -0.01]]);
    crateCrack(ctx, [[0.61, 0.09], [0.55, 0.06], [0.49, 0.1], [0.43, 0.08]]);
  }
  if (damage >= 2) {
    crateChip(ctx, [[1.01, 0.72], [0.92, 0.79], [0.95, 0.87], [1.01, 0.9]]);
    crateCrack(ctx, [[0.075, 0.36], [0.095, 0.45], [0.06, 0.53], [0.085, 0.62]]);
  }

  const nails: Pt[] = [[F / 2, F / 2], [G + F / 2, F / 2], [F / 2, G + F / 2], [G + F / 2, G + F / 2]];
  nails.forEach(([x, y], k) => {
    ctx.beginPath();
    // The bottom-left nail pops out on the last strength, leaving its hole (the top-right one went with the corner).
    if (damage >= 2 && k === 2) {
      ctx.arc(x, y, 0.017, 0, Math.PI * 2);
      ctx.fillStyle = CRATE_WOOD.hollow;
      ctx.fill();
      return;
    }
    ctx.arc(x, y, 0.03, 0, Math.PI * 2);
    ctx.fillStyle = '#4a2a12';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 0.009, y - 0.009, 0.012, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,232,195,0.65)';
    ctx.fill();
  });
}

function path(ctx: CanvasRenderingContext2D, points: Pt[], close: boolean): void {
  ctx.beginPath();
  points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  if (close) ctx.closePath();
}

/** A dark split with a lit lower lip, so it reads as cut into the wood. */
function crateCrack(ctx: CanvasRenderingContext2D, points: Pt[]): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.translate(0, 0.014);
  path(ctx, points, false);
  ctx.lineWidth = 0.014;
  ctx.strokeStyle = 'rgba(255,225,180,0.4)';
  ctx.stroke();
  ctx.translate(0, -0.014);
  path(ctx, points, false);
  ctx.lineWidth = 0.026;
  ctx.strokeStyle = CRATE_WOOD.hollow;
  ctx.stroke();
  ctx.restore();
}

/** A splinter knocked off an edge: bare light wood with a dark broken rim. */
function crateChip(ctx: CanvasRenderingContext2D, points: Pt[]): void {
  path(ctx, points, true);
  ctx.fillStyle = CRATE_WOOD.raw;
  ctx.fill();
  path(ctx, points.slice(1, -1), false);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.018;
  ctx.strokeStyle = CRATE_WOOD.line;
  ctx.stroke();
}

/** One sagging chain per layer, each laid over the previous; breaking a layer removes the top chain. */
function drawChain(ctx: CanvasRenderingContext2D, s: number, layers: number): void {
  for (const spec of CHAIN_LAYERS.slice(0, layers)) {
    const { links, ends } = chainLinks(s, spec.from, spec.to, spec.sag);
    drawLinks(ctx, s, links);
    for (const [x, y] of ends) drawBolt(ctx, s, x, y);
  }
}

interface Link {
  x: number;
  y: number;
  angle: number;
}

/** A chain hanging from `from` to `to` (cell units) in a cell of `s` px: its links, evenly spaced, and its bolts. */
function chainLinks(s: number, from: Pt, to: Pt, sag: number): { links: Link[]; ends: Pt[] } {
  // Quadratic curve whose middle dips `sag` below the straight line between the anchors.
  const [x0, y0] = [from[0] * s, from[1] * s];
  const [x2, y2] = [to[0] * s, to[1] * s];
  const [x1, y1] = [(x0 + x2) / 2, (y0 + y2) / 2 + sag * s * 2];
  const at = (t: number): Pt => {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2];
  };

  // Walk the curve by arc length so links sit at an even pitch.
  const pitch = s * CHAIN_PITCH;
  const links: Link[] = [];
  let [px, py] = at(0);
  let travelled = pitch / 2;
  for (let k = 1; k <= 200; k++) {
    const [x, y] = at(k / 200);
    const step = Math.hypot(x - px, y - py);
    while (travelled <= step) {
      const f = travelled / step;
      links.push({ x: px + (x - px) * f, y: py + (y - py) * f, angle: Math.atan2(y - py, x - px) });
      travelled += pitch;
    }
    travelled -= step;
    [px, py] = [x, y];
  }
  return { links, ends: [[x0, y0], [x2, y2]] };
}

/** A torn-off run of links, straight along the frame's middle. */
function drawChainRun(ctx: CanvasRenderingContext2D, s: number, count: number): void {
  const links = Array.from({ length: count }, (_, k): Link => ({ x: s / 2 + (k - (count - 1) / 2) * s * CHAIN_PITCH, y: s / 2, angle: 0 }));
  drawLinks(ctx, s, links);
}

function drawLinks(ctx: CanvasRenderingContext2D, s: number, links: Link[]): void {
  // Links alternate: an open oval facing us, then one seen edge-on as a short bar.
  const shape = (k: number): void => {
    ctx.beginPath();
    if (k % 2 === 0) ctx.ellipse(0, 0, s * 0.072, s * 0.046, 0, 0, Math.PI * 2);
    else {
      ctx.moveTo(-s * 0.07, 0);
      ctx.lineTo(s * 0.07, 0);
    }
  };
  const pass = (width: number, style: string, shadow: boolean): void => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    if (shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = s * 0.03;
      ctx.shadowOffsetY = s * 0.02;
    }
    links.forEach((l, k) => {
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.angle);
      shape(k);
      ctx.stroke();
      ctx.restore();
    });
    ctx.restore();
  };
  pass(s * 0.05, '#1f232b', true);
  pass(s * 0.03, '#a9b3c3', false);
  pass(s * 0.011, 'rgba(255,255,255,0.75)', false);
}

/** A bolt a chain hangs from. */
function drawBolt(ctx: CanvasRenderingContext2D, s: number, bx: number, by: number): void {
  const g = ctx.createRadialGradient(bx - s * 0.015, by - s * 0.015, 0, bx, by, s * 0.05);
  g.addColorStop(0, '#f2f5fa');
  g.addColorStop(1, '#5d6676');
  ctx.beginPath();
  ctx.arc(bx, by, s * 0.042, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = s * 0.014;
  ctx.strokeStyle = '#1f232b';
  ctx.stroke();
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r * 0.12, -r * 0.12, r, 0);
  ctx.quadraticCurveTo(r * 0.12, r * 0.12, 0, r);
  ctx.quadraticCurveTo(-r * 0.12, r * 0.12, -r, 0);
  ctx.quadraticCurveTo(-r * 0.12, -r * 0.12, 0, -r);
  ctx.fill();
  ctx.restore();
}

function drawDot(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

function drawRing(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = s * 0.06;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = s * 0.06;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2);
  ctx.stroke();
}

function drawBeam(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

function drawGlow(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

/** Soft streak along x with a hot core: a trail when stretched along a flight. */
function drawStreak(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.scale(1, 0.28);
  ctx.translate(-s / 2, -s / 2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ctx.restore();
}

/** Ring with a bright rim that fades inward: an expanding shockwave. */
function drawShock(ctx: CanvasRenderingContext2D, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.08)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

/** A five-pointed star, gold to white-hot at its heart, with a soft halo. */
function drawFallingStar(ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.36;
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.shadowColor = 'rgba(255,214,110,0.95)';
  ctx.shadowBlur = s * 0.12;
  polygon(ctx, regular(5, r, -Math.PI / 2, r * 0.48), r * 0.08);
  const body = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.35, '#fff1b8');
  body.addColorStop(0.75, '#ffd25e');
  body.addColorStop(1, '#f0a020');
  ctx.fillStyle = body;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = s * 0.018;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.restore();
}

/** A lumpy dark rock lit from the hot side, molten cracks across it and an ember rim. */
function drawMeteor(ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.34;
  const lumps = [1, 0.9, 1.04, 0.88, 0.98, 0.92, 1.02, 0.86, 0.97];
  const rock: [number, number][] = lumps.map((k, i) => {
    const a = (i / lumps.length) * Math.PI * 2;
    return [Math.cos(a) * r * k, Math.sin(a) * r * k];
  });
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.shadowColor = 'rgba(255,110,30,0.9)';
  ctx.shadowBlur = s * 0.14;
  polygon(ctx, rock, r * 0.25);
  const body = ctx.createRadialGradient(r * 0.35, r * 0.35, r * 0.1, 0, 0, r * 1.1);
  body.addColorStop(0, '#ffb347');
  body.addColorStop(0.3, '#c2451e');
  body.addColorStop(0.7, '#4a2117');
  body.addColorStop(1, '#22100c');
  ctx.fillStyle = body;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = '#ffcf6a';
  ctx.lineCap = 'round';
  ctx.shadowColor = '#ff7a1a';
  ctx.shadowBlur = s * 0.05;
  for (const [pts, width] of [
    [[[-0.5, -0.3], [-0.1, -0.05], [0.15, -0.35]], 0.035],
    [[[-0.1, -0.05], [0.05, 0.3], [0.45, 0.42]], 0.03],
    [[[0.05, 0.3], [-0.35, 0.45]], 0.022],
  ] as [[number, number][], number][]) {
    ctx.lineWidth = s * width;
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x * r, y * r) : ctx.lineTo(x * r, y * r)));
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineWidth = s * 0.02;
  ctx.strokeStyle = 'rgba(255,170,80,0.7)';
  polygon(ctx, rock, r * 0.25);
  ctx.stroke();
  ctx.restore();
}

function drawAim(ctx: CanvasRenderingContext2D, s: number): void {
  roundRect(ctx, s * 0.06, s * 0.06, s * 0.88, s * 0.88, s * 0.2);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.62);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(255,255,255,0.4)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = s * 0.05;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke();
}

/** Thin wood splinter, white to be tinted. */
function drawChip(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#fff';
  polygon(ctx, [[s * 0.2, s * 0.46], [s * 0.82, s * 0.42], [s * 0.86, s * 0.52], [s * 0.24, s * 0.58]], s * 0.02);
  ctx.fill();
}

/** A wedge of the plain gem, cut from its center: the gem breaks into SHARDS of these. */
function drawShard(ctx: CanvasRenderingContext2D, s: number, color: number, k: number): void {
  const from = (k / SHARDS) * Math.PI * 2 - Math.PI / 3;
  const to = ((k + 1) / SHARDS) * Math.PI * 2 - Math.PI / 3;
  const mid = (from + to) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(s / 2, s / 2);
  // A jagged break: the outer edge bulges at an uneven point.
  ctx.lineTo(s / 2 + Math.cos(from) * s, s / 2 + Math.sin(from) * s);
  ctx.lineTo(s / 2 + Math.cos(mid + 0.15) * s * 0.9, s / 2 + Math.sin(mid + 0.15) * s * 0.9);
  ctx.lineTo(s / 2 + Math.cos(to) * s, s / 2 + Math.sin(to) * s);
  ctx.closePath();
  ctx.clip();
  drawGem(ctx, s, color, Special.None);
  ctx.restore();
}

/** The piece's shape filled white with a soft edge, at the piece's own size. */
function drawSilhouette(ctx: CanvasRenderingContext2D, s: number, shape: Shape, size: number): void {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = s * 0.08;
  ctx.fillStyle = '#fff';
  shape(ctx, s * size);
  ctx.fill();
  ctx.restore();
}
