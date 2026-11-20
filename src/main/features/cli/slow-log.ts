import type { LimitedLogger } from "../../../shared/log/limit";

/** A nexus command that takes longer than this is worth a line. */
export const CLI_SLOW_MS = 5000;

/**
 * Writes a line for a command that ran past CLI_SLOW_MS. A command that waits
 * by design ("wait", "--wait", "--follow") is left out: its time says nothing.
 * The line has the command's name and the time, never its arguments.
 */
export function noteSlowRequest(
  limited: LimitedLogger,
  command: string,
  waits: boolean,
  ms: number,
): void {
  if (waits || ms <= CLI_SLOW_MS) return;
  limited.log("warn", `slow:${command}`, `cli request was slow: command=${command} ms=${ms}`);
}
