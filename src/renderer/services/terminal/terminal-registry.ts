/**
 * The terminal controllers of the mounted terminal tabs, by tab id, for the
 * nexus CLI, which reads and types into terminals the user may not be
 * looking at. A view registers its controller while it is mounted.
 */
import type { TerminalController } from "./types";

const controllers = new Map<string, TerminalController>();
/** Who waits for a tab's controller (whenTerminalController), by tab id. */
const waiting = new Map<string, Set<(controller: TerminalController) => void>>();

/** Registers a tab's controller. Returns the unregister function for unmount. */
export function registerTerminalController(
  tabId: string,
  controller: TerminalController,
): () => void {
  controllers.set(tabId, controller);
  const wanted = waiting.get(tabId);
  waiting.delete(tabId);
  for (const give of wanted ?? []) give(controller);
  return () => {
    if (controllers.get(tabId) === controller) controllers.delete(tabId);
  };
}

/** The controller of a mounted terminal tab. */
export function getTerminalController(tabId: string): TerminalController | undefined {
  return controllers.get(tabId);
}

/**
 * The controller of a terminal tab once its view mounts; undefined if it
 * has not after `timeoutMs`.
 */
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
