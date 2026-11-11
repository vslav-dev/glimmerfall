import type { DraftRequest, LevelDraft } from '@/gen/generator';

/** Assist below 3 does not change the draft, so requests are normalized to share cache entries. */
const ASSIST_DRAFT = 3;
const CACHE_SIZE = 4;

/** Main-thread side of the generation worker, with a small cache so the next level can be prefetched. */
export class LevelDrafts {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly cache = new Map<string, Promise<LevelDraft>>();
  private readonly pending = new Map<number, (draft: LevelDraft) => void>();
  private nextId = 1;

  public constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; draft: LevelDraft }>) => {
      this.pending.get(e.data.id)?.(e.data.draft);
      this.pending.delete(e.data.id);
    };
  }

  public get(req: DraftRequest): Promise<LevelDraft> {
    const normalized = { number: req.number, assist: req.assist >= ASSIST_DRAFT ? ASSIST_DRAFT : 0 };
    const key = `${normalized.number}:${normalized.assist}`;
    let draft = this.cache.get(key);
    if (!draft) {
      const id = this.nextId++;
      draft = new Promise<LevelDraft>((resolve) => this.pending.set(id, resolve));
      this.worker.postMessage({ id, ...normalized });
      this.cache.set(key, draft);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    return draft;
  }
}
