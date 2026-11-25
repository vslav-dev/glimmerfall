import { type LevelDef, LevelKind, Mechanic, ObjectiveKind } from '@/core/types';

/** Level where each mechanic first appears (an easy intro level). */
const INTRODUCED_AT: Record<Mechanic, number> = {
  [Mechanic.Ice]: 4,
  [Mechanic.Crate]: 10,
  [Mechanic.Chain]: 16,
  [Mechanic.Pearl]: 20,
  [Mechanic.DoubleGoal]: 24,
};

/** Win-rate ramp inside one 6-level cycle: four rising levels, a hard one, a relief one. */
const CYCLE: { kind: LevelKind; winRate: number }[] = [
  { kind: LevelKind.Relief, winRate: 0.88 },
  { kind: LevelKind.Normal, winRate: 0.8 },
  { kind: LevelKind.Normal, winRate: 0.75 },
  { kind: LevelKind.Normal, winRate: 0.7 },
  { kind: LevelKind.Normal, winRate: 0.65 },
  { kind: LevelKind.Hard, winRate: 0.5 },
];

export interface LevelPlan {
  kind: LevelKind;
  intro: Mechanic | null;
  mechanics: Set<Mechanic>;
  /** win probability the curve wants before the player's skill is considered */
  baseWinRate: number;
}

/** Mechanics introduced before level `n`. */
export function introducedBefore(n: number): Mechanic[] {
  return (Object.entries(INTRODUCED_AT) as [Mechanic, number][]).filter(([, at]) => at < n).map(([m]) => m);
}

/** The mechanics a level shows the player: its blockers, a pearl goal, a second goal. */
export function mechanicsOf(level: LevelDef): Mechanic[] {
  const has: Record<Mechanic, boolean> = {
    [Mechanic.Ice]: level.ice.some(Boolean),
    [Mechanic.Crate]: level.crate.some(Boolean),
    [Mechanic.Chain]: level.chain.some(Boolean),
    [Mechanic.Pearl]: level.objectives.some((o) => o.kind === ObjectiveKind.Pearl),
    [Mechanic.DoubleGoal]: level.objectives.length > 1,
  };
  return (Object.keys(has) as Mechanic[]).filter((m) => has[m]);
}

export function planLevel(n: number): LevelPlan {
  const mechanics = new Set(
    (Object.entries(INTRODUCED_AT) as [Mechanic, number][]).filter(([, at]) => n >= at).map(([m]) => m),
  );
  const intro = (Object.entries(INTRODUCED_AT) as [Mechanic, number][]).find(([, at]) => at === n)?.[0] ?? null;

  if (n <= 3) return { kind: LevelKind.Relief, intro: null, mechanics, baseWinRate: 0.95 };
  if (intro) return { kind: LevelKind.Intro, intro, mechanics, baseWinRate: 0.9 };

  const step = CYCLE[n % CYCLE.length];
  // Slow long-term tightening, so level 300 is not the same as level 30.
  const drift = Math.min(0.1, n / 1000);
  const early = n < 20 && step.kind === LevelKind.Hard ? 0.1 : 0;
  return { kind: step.kind, intro: null, mechanics, baseWinRate: step.winRate - drift + early };
}
