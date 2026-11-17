/**
 * How often a live preview follows text that keeps changing (typing in a
 * split, an agent writing the file). A preview renders the whole document,
 * so a heavy one redrawn every frame would leave nothing for the typing.
 */

const FRAME_MS = 16;
/** The longest a heavy preview waits between updates while its text keeps changing. */
const MAX_PACE_MS = 1000;

/**
 * How long a preview waits before showing changed text, 0 for the next
 * frame: an update that cost `lastCostMs` leaves twice that free before the
 * next, so a light preview follows every frame and a heavy one leaves the
 * main thread to the typing.
 */
export function previewUpdateDelay(lastUpdateAt: number, lastCostMs: number, now: number): number {
  const wait = lastUpdateAt + Math.min(MAX_PACE_MS, lastCostMs * 3) - now;
  return wait > FRAME_MS ? wait : 0;
}
