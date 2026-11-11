import { MAX_COLORS, Special } from '@/core/types';

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
  TileA: 'tile-a',
  TileB: 'tile-b',
  ice: (layers: number): string => `ice-${layers}`,
  crate: (strength: number): string => `crate-${strength}`,
  chain: (layers: number): string => `chain-${layers}`,
  Dot: 'dot',
  Star: 'star',
  Ring: 'ring',
  Beam: 'beam',
  Glow: 'glow',
} as const;

type Painter = (ctx: CanvasRenderingContext2D, s: number) => void;

function buildPainters(): Map<string, Painter> {
  const painters = new Map<string, Painter>();
  const specials = [Special.None, Special.LineH, Special.LineV, Special.Bomb, Special.Spark];
  for (let color = 0; color < MAX_COLORS; color++) {
    for (const special of specials) {
      painters.set(FrameName.gem(color, special), (ctx, s) => drawGem(ctx, s, color, special));
    }
  }
  painters.set(FrameName.Prism, drawPrism);
  painters.set(FrameName.TileA, (ctx, s) => drawTile(ctx, s, 0.075));
  painters.set(FrameName.TileB, (ctx, s) => drawTile(ctx, s, 0.12));
  painters.set(FrameName.ice(1), (ctx, s) => drawIce(ctx, s, 1));
  painters.set(FrameName.ice(2), (ctx, s) => drawIce(ctx, s, 2));
  for (const strength of [1, 2, 3]) painters.set(FrameName.crate(strength), (ctx, s) => drawCrate(ctx, s, strength));
  painters.set(FrameName.chain(1), (ctx, s) => drawChain(ctx, s, 1));
  painters.set(FrameName.chain(2), (ctx, s) => drawChain(ctx, s, 2));
  painters.set(FrameName.Dot, drawDot);
  painters.set(FrameName.Star, (ctx, s) => {
    ctx.fillStyle = '#fff';
    drawSparkle(ctx, s / 2, s / 2, s * 0.48, 1);
  });
  painters.set(FrameName.Ring, drawRing);
  painters.set(FrameName.Beam, drawBeam);
  painters.set(FrameName.Glow, drawGlow);
  return painters;
}

export const PAINTERS = buildPainters();

/** Small standalone image of a frame, for DOM icons. */
export function frameDataUrl(name: string, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  PAINTERS.get(name)?.(canvas.getContext('2d')!, size);
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

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.06;
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
    case Special.Spark:
      drawSparkle(ctx, 0, r * 0.05, r * 0.62, 0.95);
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
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

function drawCrate(ctx: CanvasRenderingContext2D, s: number, strength: number): void {
  const x = s * 0.06;
  const w = s * 0.88;
  const tones = [
    ['#d8a066', '#a8682f', '#6b3e17'],
    ['#b98a5a', '#87582b', '#4f2e12'],
    ['#9a8f8a', '#6b625e', '#3a3331'],
  ][strength - 1];
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.05;
  ctx.shadowOffsetY = s * 0.03;
  roundRect(ctx, x, x, w, w, s * 0.12);
  const g = ctx.createLinearGradient(0, x, 0, x + w);
  g.addColorStop(0, tones[0]);
  g.addColorStop(1, tones[1]);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = s * 0.035;
  ctx.strokeStyle = tones[2];
  ctx.stroke();
  ctx.beginPath();
  for (const k of [1, 2]) {
    ctx.moveTo(x + s * 0.06, x + (w * k) / 3);
    ctx.lineTo(x + w - s * 0.06, x + (w * k) / 3);
  }
  ctx.lineWidth = s * 0.025;
  ctx.stroke();
  if (strength >= 2) {
    ctx.fillStyle = 'rgba(40,30,30,0.55)';
    for (const bx of [0.22, 0.7]) ctx.fillRect(x + w * bx, x, w * 0.08, w);
  }
  if (strength >= 3) {
    ctx.fillStyle = '#d9d4cf';
    for (const [px, py] of [
      [0.16, 0.16],
      [0.84, 0.16],
      [0.16, 0.84],
      [0.84, 0.84],
    ]) {
      ctx.beginPath();
      ctx.arc(s * px, s * py, s * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawChain(ctx: CanvasRenderingContext2D, s: number, layers: number): void {
  const link = (cx: number, cy: number, angle: number): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.11, s * 0.065, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  const lines: [number, number, number][] = [
    [1, 1, Math.PI / 4],
    [1, -1, -Math.PI / 4],
  ];
  if (layers > 1) lines.push([1, 0, 0]);
  for (const pass of [0, 1]) {
    ctx.lineWidth = pass === 0 ? s * 0.06 : s * 0.035;
    ctx.strokeStyle = pass === 0 ? '#2d313b' : '#d7dde8';
    for (const [dx, dy, angle] of lines) {
      for (let k = -2; k <= 2; k++) {
        const t = k * 0.17;
        link(s / 2 + t * s * dx, s / 2 + t * s * dy, angle);
      }
    }
  }
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
