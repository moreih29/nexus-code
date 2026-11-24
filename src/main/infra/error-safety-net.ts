import { truncate } from "../../shared/log/limit";
import { createLogger } from "../../shared/log/main";
import { bugReportErrorCode, errorMessageOf, errorNameOf } from "../../shared/remote/bug-report";
import { appErrors, type RecordError } from "./recent-errors";

const log = createLogger("main");

export const FAULT_MESSAGE_MAX = 500;

export function describeError(value: unknown): string {
  if (value instanceof Error) {
    const head = `${value.name}: ${truncate(value.message, FAULT_MESSAGE_MAX)}`;
    const stack = value.stack;
    if (stack === undefined) return head;
    const frames = stack.indexOf("\n    at ");
    return frames === -1 ? head : `${head}${stack.slice(frames)}`;
  }
  return truncate(String(value), FAULT_MESSAGE_MAX);
}

function noteFault(kind: string, error: unknown, record: RecordError): void {
  const code = bugReportErrorCode(kind, errorNameOf(error));
  if (code) record("app", code, undefined, errorMessageOf(error));
}

export function onUncaughtException(error: Error, record: RecordError = appErrors.record): void {
  log.error(`Uncaught exception: ${describeError(error)}`);
  noteFault("uncaught", error, record);
}

export function onUnhandledRejection(
  reason: unknown,
  record: RecordError = appErrors.record,
): void {
  log.error(`Unhandled promise rejection: ${describeError(reason)}`);
  noteFault("rejection", reason, record);
}

export function installErrorSafetyNet(): void {
  process.on("uncaughtException", (error) => onUncaughtException(error));
  process.on("unhandledRejection", (reason) => onUnhandledRejection(reason));
}
