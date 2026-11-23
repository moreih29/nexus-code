const FRAME_MS = 16;
const MAX_PACE_MS = 1000;

export function previewUpdateDelay(lastUpdateAt: number, lastCostMs: number, now: number): number {
  const wait = lastUpdateAt + Math.min(MAX_PACE_MS, lastCostMs * 3) - now;
  return wait > FRAME_MS ? wait : 0;
}
