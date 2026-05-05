/**
 * Per-process command registry.
 *
 * Both the keyboard dispatcher and the IPC bridge from the Application
 * Menu push command IDs through `executeCommand`. Implementations are
 * registered with `registerCommand` (typically inside a React effect
 * mounted at the app root, so handlers can close over live store
 * accessors).
 *
 * A command without a registered handler is a no-op — the registry
 * does not throw, because menu items can fire before the renderer has
 * finished mounting (e.g. an early ⌘W during boot). A debug log
 * surfaces the miss so it doesn't disappear silently in production.
 */

import type { CommandId } from "../../shared/commands";

export type CommandHandler = () => void | Promise<void>;

const handlers = new Map<CommandId, CommandHandler>();

export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

export function executeCommand(id: CommandId): void {
  const handler = handlers.get(id);
  if (!handler) {
    if (import.meta.env?.DEV) console.debug(`[commands] no handler for ${id}`);
    return;
  }
  try {
    const result = handler();
    if (result instanceof Promise) result.catch((e) => console.error(`[commands] ${id} failed`, e));
  } catch (e) {
    console.error(`[commands] ${id} threw`, e);
  }
}

/** Test-only — clear all handlers between tests. */
export function __resetCommandsForTests(): void {
  handlers.clear();
}
