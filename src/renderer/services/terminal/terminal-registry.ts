/**
 * The terminal controllers of the mounted terminal tabs, by tab id, for the
 * nexus CLI, which reads and types into terminals the user may not be
 * looking at. A view registers its controller while it is mounted.
 */
import type { TerminalController } from "./types";

const controllers = new Map<string, TerminalController>();

/** Registers a tab's controller. Returns the unregister function for unmount. */
export function registerTerminalController(
  tabId: string,
  controller: TerminalController,
): () => void {
  controllers.set(tabId, controller);
  return () => {
    if (controllers.get(tabId) === controller) controllers.delete(tabId);
  };
}

/** The controller of a mounted terminal tab. */
export function getTerminalController(tabId: string): TerminalController | undefined {
  return controllers.get(tabId);
}
