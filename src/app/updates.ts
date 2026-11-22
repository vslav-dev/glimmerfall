/** One release as the changelog tells it. */
export interface Release {
  version: string;
  /** ISO date */
  date: string;
  changes: string[];
}

/** A newer build is live: its version, and what changed since the one running here, newest first. */
export interface Update {
  version: string;
  releases: Release[];
}

/** How often a running game looks again, and the least time between two looks when it comes back to the front. */
const CHECK_EVERY_MS = 30 * 60_000;
const RECHECK_AFTER_MS = 10 * 60_000;

/**
 * Notices a new build without bothering the server: `version.json` is a static file, asked with a conditional GET
 * (a few hundred bytes, answered 304 while nothing changed), at start, every half hour while the game is open,
 * and when it returns to the front after a while. No open connection is kept. Once an update is found it stops asking.
 */
export class UpdateWatch {
  private last = 0;
  private timer = 0;
  private found = false;

  public constructor(
    private readonly current: string,
    private readonly onUpdate: (update: Update) => void,
  ) {}

  public start(): void {
    void this.check();
    this.timer = window.setInterval(() => void this.check(), CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && performance.now() - this.last > RECHECK_AFTER_MS) void this.check();
    });
  }

  private async check(): Promise<void> {
    if (this.found || document.visibilityState !== 'visible') return;
    this.last = performance.now();
    try {
      // `no-cache` revalidates: the browser sends its ETag and the server answers 304 while the file is the same.
      const response = await fetch('./version.json', { cache: 'no-cache' });
      if (!response.ok) return;
      const live = (await response.json()) as { version: string; releases: Release[] };
      if (compareVersions(live.version, this.current) <= 0) return;
      this.found = true;
      window.clearInterval(this.timer);
      this.onUpdate({ version: live.version, releases: live.releases.filter((r) => compareVersions(r.version, this.current) > 0) });
    } catch {
      // Offline or a deploy mid-way: the next look tries again.
    }
  }
}

/** Compares `major.minor.patch` versions: negative, 0 or positive like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
