import { draftLevel, type DraftRequest } from '@/gen/generator';

/** Level drafting runs here: bot calibration takes up to a few hundred ms and must not block the UI. */
self.onmessage = (e: MessageEvent<DraftRequest & { id: number }>) => {
  const { id, ...req } = e.data;
  self.postMessage({ id, draft: draftLevel(req) });
};
