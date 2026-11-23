import { truncate } from "../../shared/log/limit";
import { createLogger } from "../../shared/log/main";

const log = createLogger("main");

type SafetyNetMode = "log-only" | "exit";

const ERROR_SAFETY_NET_MODE: SafetyNetMode = "log-only";

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

function handleFault(): void {
  if (ERROR_SAFETY_NET_MODE === "exit") {
    process.exit(1);
  }
}

export function onUncaughtException(error: Error): void {
  log.error(`Uncaught exception: ${describeError(error)}`);
  handleFault();
}

export function onUnhandledRejection(reason: unknown): void {
  log.error(`Unhandled promise rejection: ${describeError(reason)}`);
  handleFault();
}

export function installErrorSafetyNet(): void {
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
}
