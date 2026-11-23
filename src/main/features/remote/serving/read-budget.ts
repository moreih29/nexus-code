import { RpcErrorCode, type RpcMethod } from "../../../../../packages/remote-protocol/src";
import type { CliUiOp, CliUiOps } from "../../../../shared/cli/ui";
import { createLogger } from "../../../../shared/log/main";
import { shortId } from "../../../../shared/util/short-id";
import type { CliServices } from "../../cli/context";
import { RpcFailure } from "../room";

const log = createLogger("remote-serving");
const SLOW_UI_MS = 1_000;
const WARNING_INTERVAL_MS = 30_000;
const warnedAt = new Map<RpcMethod, number>();
export const RENDERER_READ_MAX_MS = 2_000;

export class ReadBudget {
  private readonly started = performance.now();
  private readonly slow = new Map<CliUiOp, { count: number; timeouts: number; maxMs: number }>();

  constructor(
    private readonly services: CliServices,
    private readonly method: RpcMethod,
    private readonly from?: string,
    private readonly totalMs = 8_000,
  ) {}

  remaining(): number {
    return Math.floor(this.totalMs - (performance.now() - this.started));
  }

  async run<T>(read: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RpcFailure(RpcErrorCode.Unavailable, `${this.method}: the read timed out`));
      }, this.remaining());
    });
    try {
      return await Promise.race([expiry, read()]);
    } finally {
      clearTimeout(timer);
      this.report();
    }
  }

  async ui<K extends CliUiOp>(
    op: K,
    args: CliUiOps[K]["args"],
    maxMs = RENDERER_READ_MAX_MS,
    read = (args: CliUiOps[K]["args"], ms: number) => this.services.ui(op, args, ms),
  ): Promise<CliUiOps[K]["result"]> {
    const timeout = () =>
      new RpcFailure(RpcErrorCode.Unavailable, `${op}: the window did not answer in time`);
    const ms = Math.min(maxMs, this.remaining());
    if (ms <= 0) throw timeout();

    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeout());
      }, ms);
    });
    try {
      return await Promise.race([expiry, read(args, ms)]);
    } finally {
      clearTimeout(timer);
      const elapsed = Math.round(performance.now() - started);
      if (timedOut || elapsed >= SLOW_UI_MS) {
        const stats = this.slow.get(op) ?? { count: 0, timeouts: 0, maxMs: 0 };
        stats.count++;
        if (timedOut) stats.timeouts++;
        stats.maxMs = Math.max(stats.maxMs, elapsed);
        this.slow.set(op, stats);
      }
    }
  }

  report(skipped = 0): void {
    const now = performance.now();
    const elapsed = Math.round(now - this.started);
    if (this.slow.size === 0 && skipped === 0 && elapsed < SLOW_UI_MS) return;
    if (now - (warnedAt.get(this.method) ?? -Infinity) < WARNING_INTERVAL_MS) return;
    warnedAt.set(this.method, now);
    const peer = this.from ? ` peer=${shortId(this.from)}` : "";
    const details = [...this.slow].map(
      ([op, stats]) => `${op} count=${stats.count} timeouts=${stats.timeouts} maxMs=${stats.maxMs}`,
    );
    log.warn(
      `Slow ${this.method}${peer} elapsedMs=${elapsed} skippedUi=${skipped} ${details.join(" | ")}`.trimEnd(),
    );
  }
}
