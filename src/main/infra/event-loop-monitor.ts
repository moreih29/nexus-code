import { monitorEventLoopDelay } from "node:perf_hooks";
import { limitLog } from "../../shared/log/limit";
import type { Logger } from "../../shared/log/types";

export const LOOP_CHECK_MS = 10_000;
export const LOOP_RESOLUTION_MS = 20;
export const LOOP_P99_WARN_MS = 200;
export const LOOP_MAX_WARN_MS = 1000;
export const LOOP_LINE_INTERVAL_MS = 60_000;

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
  power?: PowerEvents;
}

export interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  removeListener(event: "suspend" | "resume", listener: () => void): unknown;
}

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
