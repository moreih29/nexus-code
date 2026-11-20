const FRAME_STALL_MS = 5_000;
const TIMER_SLIP_MS = 1_000;

/** Gives a stalled frame a fresh deadline if the main event loop ran the timer late. */
export function frameStallDeadline(onStall: (elapsedMs: number) => void) {
  const started = performance.now();
  let due = started + FRAME_STALL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    const check = () => {
      const now = performance.now();
      if (now - due >= TIMER_SLIP_MS) {
        due = now + FRAME_STALL_MS;
        timer = setTimeout(check, FRAME_STALL_MS);
        return;
      }
      resolve(null);
      onStall(now - started);
    };
    timer = setTimeout(check, FRAME_STALL_MS);
  });
  return { expiry, cancel: () => clearTimeout(timer) };
}
