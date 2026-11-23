import { createLogger } from "../../shared/log/renderer";

const log = createLogger("renderer");

export function isPureCanceled(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }

  const candidate = reason as { message?: unknown; name?: unknown };
  return candidate.name === "Canceled" || candidate.message === "Canceled";
}

const NAME_MAX = 64;

export interface UncaughtErrorDetail {
  name: string;
  source: string;
  errorNull: boolean;
  resizeObserverLoop: boolean;
}

function fileBasename(filename: unknown): string {
  if (typeof filename !== "string" || filename === "") return "none";
  const path = filename.split(/[?#]/, 1)[0] ?? "";
  return path.split(/[\\/]/).pop() || "none";
}

function errorName(error: unknown): string {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === "string" && name !== "" ? name.slice(0, NAME_MAX) : "none";
}

function position(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function uncaughtErrorDetail(
  event: Pick<ErrorEvent, "error" | "message" | "filename" | "lineno" | "colno">,
): UncaughtErrorDetail {
  return {
    name: errorName(event.error),
    source: `${fileBasename(event.filename)}:${position(event.lineno)}:${position(event.colno)}`,
    errorNull: event.error === null,
    resizeObserverLoop:
      typeof event.message === "string" && event.message.startsWith("ResizeObserver loop"),
  };
}

function onError(event: ErrorEvent): void {
  if (isPureCanceled(event.error)) {
    event.preventDefault();
    return;
  }

  const detail = uncaughtErrorDetail(event);
  log.error(
    `Uncaught renderer error name=${JSON.stringify(detail.name)} source=${JSON.stringify(detail.source)} errorNull=${detail.errorNull} resizeObserverLoop=${detail.resizeObserverLoop}`,
  );
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  if (isPureCanceled(event.reason)) {
    event.preventDefault();
    return;
  }

  log.error("Unhandled promise rejection in renderer", {});
}

export function installWindowErrorHandlers(): () => void {
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
