import { type Blast, BlastKind, type GameEvent, type LayerChange, type Pos, type ScorePopup } from '@/core/types';

type ClearEvent = Extract<GameEvent, { type: 'clear' }>;

/** Playback timing of a clear step, ms. */
export const Timing = {
  /** between playback orders that nothing on the board links */
  orderStep: 70,
  /** a special reached by a wave goes off this long after */
  fuse: 40,
  /** wave speeds, ms per cell */
  line: 16,
  bomb: 45,
  prism: 22,
  splash: 30,
  /** a prism wave spans at most this long, whatever the board */
  prismMax: 240,
  /** the spark's star flies this long to its target */
  sparkFlight: 260,
  /** a combo gathers its power this long before it goes off */
  comboCharge: 150,
  /** a layer next to a reached cell cracks this long after it */
  layerLag: 40,
} as const;

export interface ClearPlan {
  /** the beat before anything goes off: a combo's charge, else 0 */
  lead: number;
  /** start of each blast, in the order of the event's blasts */
  blasts: number[];
  /** when a piece hit in playback order `order` at `pos` is reached */
  at(pos: Pos, order: number): number;
  layer(change: LayerChange): number;
  popup(popup: ScorePopup): number;
}

/**
 * When everything in a clear step happens. A blast's wave runs out from its origin, so each piece goes
 * the moment the beam, ring or bolt reaches it; a special hit by a wave goes off once the wave got to it;
 * a spark's target goes when the star lands. Without the wave a whole blast lands at once; without the
 * charge a combo goes off at once.
 */
export function planClear(ev: ClearEvent, { wave, charge }: { wave: boolean; charge: boolean }): ClearPlan {
  const lead = ev.combo && charge ? Timing.comboCharge : 0;
  const base = (order: number): number => lead + order * Timing.orderStep;
  const hits = new Map<string, number>();
  const arrivals = new Map<string, number>();
  const note = (map: Map<string, number>, k: string, t: number): void => {
    const prev = map.get(k);
    if (prev === undefined || t < prev) map.set(k, t);
  };

  const blasts = ev.blasts.map(() => 0);
  const byOrder = ev.blasts.map((_, i) => i).sort((a, b) => ev.blasts[a].order - ev.blasts[b].order);
  for (const i of byOrder) {
    const b = ev.blasts[i];
    const landed = arrivals.get(key(b.order, b.origin));
    const reached = hits.get(key(b.order - 1, b.origin));
    const start = landed ?? (reached === undefined ? base(b.order) : reached + Timing.fuse);
    blasts[i] = start;
    for (const p of b.cells) note(hits, key(b.order, p), start + (wave ? waveDelay(b, p) : 0));
    if (b.kind === BlastKind.Spark && b.target) note(arrivals, key(b.order + 1, b.target), start + Timing.sparkFlight);
  }

  const reachedAt = (pos: Pos, order: number): number | undefined => hits.get(key(order, pos)) ?? arrivals.get(key(order, pos));

  return {
    lead,
    blasts,
    at: (pos, order) => reachedAt(pos, order) ?? base(order),
    layer: ({ pos, order }) => {
      const own = reachedAt(pos, order);
      if (own !== undefined) return own;
      // Crates crack from a hit next door: as the wave passes the neighbor.
      const near = NEIGHBORS.map(([dr, dc]) => reachedAt({ r: pos.r + dr, c: pos.c + dc }, order)).filter((t) => t !== undefined);
      return near.length > 0 ? Math.min(...near) + Timing.layerLag : base(order) + Timing.layerLag;
    },
    popup: (p) => {
      const k = ev.blasts.findIndex((b) => b.order === p.order && b.origin.r === p.r && b.origin.c === p.c);
      return k === -1 ? base(p.order) : blasts[k];
    },
  };
}

const NEIGHBORS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function key(order: number, p: Pos): string {
  return `${order}:${p.r}:${p.c}`;
}

function waveDelay(b: Blast, p: Pos): number {
  const dr = Math.abs(p.r - b.origin.r);
  const dc = Math.abs(p.c - b.origin.c);
  switch (b.kind) {
    case BlastKind.Row:
      return dc * Timing.line;
    case BlastKind.Col:
      return dr * Timing.line;
    case BlastKind.Bomb:
      return Math.max(dr, dc) * Timing.bomb;
    case BlastKind.Prism:
      return Math.min(Math.hypot(dr, dc) * Timing.prism, Timing.prismMax);
    case BlastKind.Spark:
      return Timing.splash;
  }
}
