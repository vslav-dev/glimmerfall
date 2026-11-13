import { draftLevel, type DraftRequest } from '@/gen/generator';

/** Level drafting runs here: bot calibration takes up to a few hundred ms and must not block the UI. */
self.onmessage = (e: MessageEvent<DraftRequest & { id: number }>) => {
  const { id, ...req } = e.data;
  const started = performance.now();
  try {
    self.postMessage({ id, draft: draftLevel(req), ms: Math.round(performance.now() - started) });
  } catch (error) {
    // Worker errors never reach the page's error listener: hand them over explicitly.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    self.postMessage({ id, error: message, stack: error instanceof Error ? error.stack : undefined });
  }
};
