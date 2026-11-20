/**
 * Offline step 1 of the move analysis (see tools/analyze.sh): replays `attempt` telemetry events on the code
 * that played them and dumps every move made on a calm board, with the board as the player saw it.
 * Runs only with GF_IN (events of one generator version, JSON array) and GF_OUT (dump path) set.
 * Uses only APIs every generator version has, because analyze.sh copies it into older checkouts.
 */
import fs from 'node:fs';
import { describe, it } from 'vitest';
import { indexOf, posOf } from '@/core/board';
import { advance, createGame, makeMove, startFinale } from '@/core/game';
import { hasAnyMatch } from '@/core/moves';
import { draftLevel, finalizeLevel } from '@/gen/generator';

/** right, down, left, up: the packing of the attempt record */
const DIRECTIONS = [
  { r: 0, c: 1 },
  { r: 1, c: 0 },
  { r: 0, c: -1 },
  { r: -1, c: 0 },
];

interface Event {
  seed: number;
  n: number;
  p: number;
  /** generator that built the level, and game code that played it (since generator 7); a replay needs both equal */
  gen: number;
  rules?: number;
  /** exact finalize inputs, sent since generator 7; older events only had the rounded `p` */
  target?: number;
  threeStars?: number;
  moves: number;
  board: number;
  end: string;
  score: number;
  rec: string | null;
  /** swaps that matched nothing, packed like moves (see AttemptRecord.misses); since 0.20.0 */
  misses?: string | null;
  /** the request style, in whatever shape that version sent it */
  style: unknown;
  pace?: number;
}

function decode(text: string): number[] {
  const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  return [...new Uint32Array(bytes.buffer)];
}

/** The request as the version that sent the event built it: older versions sent the style as an array. */
function requestOf(e: Event): never {
  const old = e.style as number[];
  const style = Array.isArray(e.style) ? { precision: old[0], bonus: old[1], craft: old[2] } : e.style;
  return { seed: e.seed, number: e.n, style, pace: e.pace ?? 1 } as never;
}

describe.skipIf(!process.env.GF_IN)('replay dump', () => {
  it('dumps calm-board moves', () => {
    const events = JSON.parse(fs.readFileSync(process.env.GF_IN!, 'utf8')) as Event[];
    const drafts = new Map<number, ReturnType<typeof draftLevel>>();
    const out: unknown[] = [];
    for (const e of events) {
      if (!e.rec || (e.rules !== undefined && e.rules !== e.gen)) continue;
      let draft = drafts.get(e.n);
      if (!draft) drafts.set(e.n, (draft = draftLevel(requestOf(e))));
      // Older events only had a rounded win rate: nudge it until the move count matches.
      let level = e.target !== undefined ? finalizeLevel(draft, e.target, e.threeStars) : finalizeLevel(draft, e.p);
      for (const d of [-0.005, -0.0025, 0.0025, 0.005]) {
        if (level.moves === e.moves || e.target !== undefined) break;
        level = finalizeLevel(draft, e.p + d);
      }
      const game = createGame(level, e.board);
      const moves: unknown[] = [];
      let last = -1;
      for (const packed of decode(e.rec)) {
        const steps = (packed >>> 10) & 255;
        for (let k = 0; k < steps; k++) advance(game);
        const a = posOf(game.board, packed & 127);
        const d = DIRECTIONS[(packed >>> 7) & 3];
        const b = { r: a.r + d.r, c: a.c + d.c };
        const to = indexOf(game.board, b.r, b.c);
        const calm = game.status === 'playing' && game.pending === null && (game.fuse?.length ?? 0) === 0 && !hasAnyMatch(game.board);
        if (calm) {
          moves.push({
            board: structuredClone(game.board),
            progress: [...game.progress],
            movesLeft: game.movesLeft,
            from: indexOf(game.board, a.r, a.c),
            to,
            last,
            hint: (packed >>> 9) & 1,
            think: ((packed >>> 18) & 255) / 10,
            // sent since 0.20.0; zero in older events
            drag: (packed >>> 26) & 1,
            repicks: (packed >>> 27) & 3,
          });
        }
        makeMove(game, a, b);
        last = to;
      }
      while (advance(game)) continue;
      // The app runs the finale only with moves left over.
      if (game.status === 'won' && game.movesLeft > 0) {
        startFinale(game);
        while (advance(game)) continue;
      }
      const end = game.status === 'playing' ? 'restart' : game.status;
      const reproduced = level.moves === e.moves && game.score === e.score && (end === e.end || e.end === 'restart');
      out.push({ event: e, level, reproduced, moves });
    }
    fs.writeFileSync(process.env.GF_OUT!, JSON.stringify(out));
  }, 1_200_000);
});
