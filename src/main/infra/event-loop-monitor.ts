import { monitorEventLoopDelay } from "node:perf_hooks";
import { limitLog } from "../../shared/log/limit";
import type { Logger } from "../../shared/log/types";

/** How often the delay is read. */
export const LOOP_CHECK_MS = 10_000;
/** The timer resolution of the sampler. */
export const LOOP_RESOLUTION_MS = 20;
/** p99 over this, in a check, is worth a line. */
export const LOOP_P99_WARN_MS = 200;
/** A single delay over this, in a check, is worth a line. */
export const LOOP_MAX_WARN_MS = 1000;
/** A line for the same cause at most this often. */
export const LOOP_LINE_INTERVAL_MS = 60_000;

/** The part of a perf_hooks histogram the monitor reads; delays in nanoseconds. */
export interface DelaySampler {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number;
  readonly max: number;
}

export interface LoopMonitorDeps {
  sampler?: DelaySampler;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  now?: () => number;
  /** Electron's powerMonitor: a check across a suspend or resume is skipped. */
  power?: PowerEvents;
}

/** The part of Electron's powerMonitor the monitor listens to. */
export interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  removeListener(event: "suspend" | "resume", listener: () => void): unknown;
}

/**
 * Watches how late the main process's timers fire, which is how long its event
 * loop was busy. The sampler costs a timer every 20 ms and an array-free
 * histogram; it is read every 10 s and a line is written only when p99 or the
 * longest delay is over its limit, so a healthy app writes nothing.
 * A check that came late is itself a stall (the same blocked loop delays the
 * check), so its lateness counts as a delay too. Only a check across a suspend
 * or resume (from powerMonitor) is skipped, as the sleep would read as a stall.
 */
export function startEventLoopMonitor(logger: Logger, deps: LoopMonitorDeps = {}): () => void {
  const sampler: DelaySampler =
    deps.sampler ?? (monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS }) as DelaySampler);
  const now = deps.now ?? Date.now;
  const every =
    deps.setInterval ??
    ((run, ms) => {
      const timer = setInterval(run, ms);
      timer.unref();
      return timer;
    });
  const stop = deps.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const limited = limitLog(logger, { intervalMs: LOOP_LINE_INTERVAL_MS, now });

  let slept = false;
  const markSlept = () => {
    slept = true;
  };
  deps.power?.on("suspend", markSlept);
  deps.power?.on("resume", markSlept);

  sampler.enable();
  let lastCheck = now();
  const timer = every(() => {
    const at = now();
    const late = Math.max(0, at - lastCheck - LOOP_CHECK_MS);
    lastCheck = at;
    const p99 = sampler.percentile(99) / 1e6;
    const max = Math.max(sampler.max / 1e6, late);
    sampler.reset();
    if (slept) {
      slept = false;
      return;
    }
    if (p99 > LOOP_P99_WARN_MS || max > LOOP_MAX_WARN_MS) {
      limited.log(
        "warn",
        "event-loop-lag",
        `main event loop was slow: p99=${Math.round(p99)}ms max=${Math.round(max)}ms over ${LOOP_CHECK_MS / 1000}s`,
      );
    }
  }, LOOP_CHECK_MS);

  return () => {
    stop(timer);
    sampler.disable();
    deps.power?.removeListener("suspend", markSlept);
    deps.power?.removeListener("resume", markSlept);
  };
}
