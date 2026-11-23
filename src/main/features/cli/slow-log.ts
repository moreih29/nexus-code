import type { LimitedLogger } from "../../../shared/log/limit";

export const CLI_SLOW_MS = 5000;

export function noteSlowRequest(
  limited: LimitedLogger,
  command: string,
  waits: boolean,
  ms: number,
): void {
  if (waits || ms <= CLI_SLOW_MS) return;
  limited.log("warn", `slow:${command}`, `cli request was slow: command=${command} ms=${ms}`);
}
