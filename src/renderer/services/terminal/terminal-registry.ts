import type { TerminalController } from "./types";

const controllers = new Map<string, TerminalController>();
const waiting = new Map<string, Set<(controller: TerminalController) => void>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function registerTerminalController(
  tabId: string,
  controller: TerminalController,
): () => void {
  controllers.set(tabId, controller);
  const wanted = waiting.get(tabId);
  waiting.delete(tabId);
  for (const give of wanted ?? []) give(controller);
  changed();
  return () => {
    if (controllers.get(tabId) !== controller) return;
    controllers.delete(tabId);
    changed();
  };
}

export function onTerminalControllersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTerminalController(tabId: string): TerminalController | undefined {
  return controllers.get(tabId);
}

export function whenTerminalController(
  tabId: string,
  timeoutMs: number,
): Promise<TerminalController | undefined> {
  const now = controllers.get(tabId);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const give = (controller: TerminalController | undefined) => {
      clearTimeout(timer);
      const wanted = waiting.get(tabId);
      wanted?.delete(give);
      if (wanted?.size === 0) waiting.delete(tabId);
      resolve(controller);
    };
    const timer = setTimeout(() => give(undefined), timeoutMs);
    const wanted = waiting.get(tabId) ?? new Set();
    wanted.add(give);
    waiting.set(tabId, wanted);
  });
}
