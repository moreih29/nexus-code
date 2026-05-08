function isPureCanceled(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }

  const candidate = reason as { message?: unknown; name?: unknown };
  return candidate.name === "Canceled" || candidate.message === "Canceled";
}

export function installRejectionSink(): () => void {
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (isPureCanceled(event.reason)) {
      event.preventDefault();
    }
  };

  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
}
