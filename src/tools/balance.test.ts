/**
 * Balance study (plans/09): builds levels across the curve for the average twin, plays them with it, and reports
 *  - the moves each level gets, the twin's win rate against the target, and 3-star wins: the rules changed (squares
 *    make bombs, no spark), calibration should keep the curve;
 *  - specials made per move, by kind;
 *  - moves left at wins: what charges the star; the stars of wins: what charge the meteor;
 *  - how often a booster turns a lost run into a win, aimed greedily two moves before the end.
 * Runs only with GF_BALANCE=1. GF_GOAL=<goal kind> (e.g. `pearl`, plans/13) studies only levels with that goal:
 * each level number takes the first player seed from GF_SEED on whose level it is.
 */
import { describe, it } from 'vitest';
import { EARN, winGain } from '@/app/boosters';
import { pickMove } from '@/bot/bot';
import { goalsOf, moveOptions } from '@/bot/features';
import { posOf } from '@/core/board';
import { advance, createGame, playMove, startFinale, starsFor, strike } from '@/core/game';
import { strikeCells } from '@/core/resolve';
import { Booster, type GameState, type LevelDef, ObjectiveKind, Special } from '@/core/types';
import { draftLevel, finalizeLevel, type LevelDraft } from '@/gen/generator';
import { planLevel } from '@/gen/plan';
import { Difficulty, targetWinRate } from '@/player/difficulty';
import { newModel, type TwinStyle, twinOf } from '@/player/model';

const AVERAGE: TwinStyle = { ...twinOf(newModel()), strength: 0.3 };
const LEVELS = [6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 23, 26, 29, 33, 38, 41, 45, 50, 57];
const RUNS = 40;
/** player seeds tried per level number for a level with the studied goal */
const GOAL_SEEDS = 40;
/** the booster goes off this many moves before the end */
const BOOST_AT = 2;

interface Run {
  won: boolean;
  left: number;
  stars: number;
  made: number[];
  moves: number;
}

/** The twin's game from this seed; `boost` fires a booster `BOOST_AT` moves before the end, at its best cell. */
function play(level: LevelDef, seed: number, boost: Booster | null): Run {
  const game = createGame(level, seed);
  const rng = { rng: seed ^ 0x5bd1e995 };
  const made = [0, 0, 0, 0, 0];
  let last = -1;
  let boosted = false;
  while (game.status === 'playing') {
    if (boost && !boosted && game.movesLeft === BOOST_AT) {
      boosted = true;
      strike(game, boost, posOf(game.board, bestCell(game, boost)));
      while (advance(game)) continue;
      if (game.status !== 'playing') break;
    }
    const options = moveOptions(game.board, goalsOf(game), last);
    if (options.moves.length === 0) break;
    const [i, j] = options.moves[pickMove(options, AVERAGE, rng)];
    const before = new Set(game.board.cells.flatMap((c) => (c.piece && c.piece.special !== Special.None ? [c.piece.id] : [])));
    playMove(game, posOf(game.board, i), posOf(game.board, j));
    for (const c of game.board.cells) if (c.piece && c.piece.special !== Special.None && !before.has(c.piece.id)) made[c.piece.special]++;
    last = j;
  }
  const won = game.status === 'won';
  const left = game.movesLeft;
  if (won) {
    startFinale(game);
    while (advance(game)) continue;
  }
  return { won, left, stars: starsFor(game), made, moves: game.movesMade };
}

/** The level number's draft for the average twin; with GF_GOAL, the first one from GF_SEED on with that goal, or null. */
function draftFor(n: number): LevelDraft | null {
  const seed = Number(process.env.GF_SEED ?? 777);
  const goal = process.env.GF_GOAL;
  for (let k = 0; k < (goal ? GOAL_SEEDS : 1); k++) {
    const draft = draftLevel({ seed: seed + k, number: n, style: AVERAGE, pace: 1 });
    if (!goal || draft.level.objectives.some((o) => o.kind === goal)) return draft;
  }
  return null;
}

/** The cell whose strike takes the most of what the open goals still need. */
function bestCell(game: GameState, booster: Booster): number {
  const b = game.board;
  // A strike under the pearl lowers it by every cell it clears there.
  const pearl = b.cells.findIndex((c) => c.piece?.pearl);
  const value = (i: number): number => {
    const cell = b.cells[i];
    let v = 0;
    game.level.objectives.forEach((o, k) => {
      if (game.progress[k] >= o.target) return;
      if (o.kind === ObjectiveKind.Collect && cell.piece?.color === o.color) v += 1;
      if (o.kind === ObjectiveKind.Ice) v += booster === Booster.Meteor ? Math.min(1, cell.ice) : cell.ice > 0 ? 1 : 0;
      if (o.kind === ObjectiveKind.Crate) v += booster === Booster.Meteor ? Math.min(1, cell.crate) : cell.crate > 0 ? 1 : 0;
      if (o.kind === ObjectiveKind.Score) v += 1;
      if (o.kind === ObjectiveKind.Pearl && pearl >= 0 && i > pearl && i % b.cols === pearl % b.cols) v += 1;
    });
    return v + (cell.chain > 0 ? 0.2 : 0);
  };
  let best = 0;
  let bestValue = -1;
  b.cells.forEach((cell, i) => {
    if (!cell.exists) return;
    const v = strikeCells(b, booster, i).reduce((sum, j) => sum + value(j), 0);
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  });
  return best;
}

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

describe.runIf(process.env.GF_BALANCE)('balance', () => {
  it('reports the curve, the specials, the charges and what boosters rescue', () => {
    let wins = 0;
    let runs = 0;
    let three = 0;
    /** meteor charge the wins earned */
    let meteor = 0;
    const leftAtWin: number[] = [];
    const made = [0, 0, 0, 0, 0];
    let movesMade = 0;
    const twin: number[] = [];
    const granted: number[] = [];
    const rescue = { [Booster.Star]: [0, 0], [Booster.Meteor]: [0, 0] };
    for (const n of LEVELS) {
      const target = targetWinRate(planLevel(n).baseWinRate, Difficulty.Normal, 0);
      const draft = draftFor(n);
      if (!draft) continue;
      const level = finalizeLevel(draft, target);
      twin.push(level.targetWinRate);
      granted.push(level.moves);
      let w = 0;
      let t = 0;
      const left: number[] = [];
      for (let k = 0; k < RUNS; k++) {
        const seed = 5000 + n * 131 + k;
        const run = play(level, seed, null);
        runs++;
        movesMade += run.moves;
        run.made.forEach((m, s) => (made[s] += m));
        if (run.won) {
          w++;
          left.push(run.left);
          if (run.stars === 3) t++;
          meteor += winGain(run.left, run.stars)[Booster.Meteor];
          continue;
        }
        for (const booster of Object.values(Booster)) {
          rescue[booster][1]++;
          if (play(level, seed, booster).won) rescue[booster][0]++;
        }
      }
      wins += w;
      three += t;
      leftAtWin.push(...left);
      const goals = level.objectives.map((o) => `${o.kind}${o.kind === ObjectiveKind.Collect ? o.color : ''}:${o.target}`).join(',');
      console.log(`📊 L${n} ${level.kind} moves=${level.moves} target=${round(target)} twin=${round(level.targetWinRate)} won=${round(w / RUNS)} 3★/win=${round(t / Math.max(1, w))} left=${round(mean(left), 1)} ${goals}`);
    }
    const perWin = mean(leftAtWin);
    console.log(`🎯 win rate ${round(wins / runs)} (twin predicts ${round(mean(twin))}, moves ${round(mean(granted), 1)}) | 3★ per win ${round(three / wins)} | moves left per win ${round(perWin, 1)} (median ${[...leftAtWin].sort((a, b) => a - b)[Math.floor(leftAtWin.length / 2)]})`);
    console.log(`💎 specials per 100 moves: line ${round((100 * (made[Special.LineH] + made[Special.LineV])) / movesMade, 1)} bomb ${round((100 * made[Special.Bomb]) / movesMade, 1)} prism ${round((100 * made[Special.Prism]) / movesMade, 1)}`);
    console.log(`⭐ wins per star: ${round(EARN.star.unit / perWin, 1)} | ☄️ wins per meteor: ${round(EARN.meteor.unit / (meteor / wins), 1)}`);
    for (const booster of Object.values(Booster)) {
      const [saved, lost] = rescue[booster];
      console.log(`🛟 ${booster} turns ${saved}/${lost} lost runs into wins (${round(saved / Math.max(1, lost))})`);
    }
  }, 1_800_000);
});
