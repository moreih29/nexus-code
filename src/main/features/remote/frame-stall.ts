const FRAME_STALL_MS = 5_000;
const TIMER_SLIP_MS = 1_000;

/** Restarts the wait if the main event loop ran the timer late. */
export function responsiveTimeout(waitMs: number, expire: (elapsedMs: number) => void): () => void {
  const started = performance.now();
  let due = started + waitMs;
  const check = () => {
    const now = performance.now();
    if (now - due >= TIMER_SLIP_MS) {
      due = now + waitMs;
      timer = setTimeout(check, waitMs);
      return;
    }
    expire(now - started);
  };
  let timer = setTimeout(check, waitMs);
  return () => clearTimeout(timer);
}

export function frameStallDeadline(onStall: (elapsedMs: number) => void) {
  let cancel = () => {};
  const expiry = new Promise<null>((resolve) => {
    cancel = responsiveTimeout(FRAME_STALL_MS, (elapsed) => {
      resolve(null);
      onStall(elapsed);
    });
  });
  return { expiry, cancel };
}
