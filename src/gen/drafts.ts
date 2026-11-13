import type { DraftRequest, LevelDraft } from '@/gen/generator';
import { debug } from '@/telemetry/telemetry';

/** Assist below 3 does not change the draft, so requests are normalized to share cache entries. */
const ASSIST_DRAFT = 3;
const CACHE_SIZE = 4;

interface WorkerReply {
  id: number;
  draft?: LevelDraft;
  ms?: number;
  error?: string;
  stack?: string;
}

/** Main-thread side of the generation worker, with a small cache so the next level can be prefetched. */
export class LevelDrafts {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly cache = new Map<string, Promise<LevelDraft>>();
  private readonly pending = new Map<number, (draft: LevelDraft) => void>();
  private nextId = 1;

  public constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id, draft, ms, error, stack } = e.data;
      debug('draft-reply', { id, ms, error, stack: stack?.slice(0, 1500), known: this.pending.has(id) });
      if (draft) this.pending.get(id)?.(draft);
      this.pending.delete(id);
    };
    this.worker.onerror = (e) => {
      debug('worker-error', { message: e.message, file: e.filename, line: e.lineno, pending: [...this.pending.keys()] });
    };
    this.worker.onmessageerror = () => debug('worker-messageerror', { pending: [...this.pending.keys()] });
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
      debug('draft-request', { id, key, pending: [...this.pending.keys()] });
    } else {
      debug('draft-cached', { key, pending: [...this.pending.keys()] });
    }
    return draft;
  }
}
