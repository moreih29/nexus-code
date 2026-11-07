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

import type { CommandId } from "../../shared/keybindings/commands";
import { createLogger } from "../../shared/log/renderer";

const log = createLogger("commands");

export type CommandHandler = () => void | Promise<void>;

const handlers = new Map<CommandId, CommandHandler>();

/**
 * Decides a command ahead of its registered handler, for a view the
 * handlers don't know (the agent view): a handler of its own, "skip" to do
 * nothing, or undefined for the registered one.
 */
export type CommandInterceptor = (id: CommandId) => CommandHandler | "skip" | undefined;

let interceptor: CommandInterceptor | null = null;

export function setCommandInterceptor(next: CommandInterceptor): () => void {
  interceptor = next;
  return () => {
    if (interceptor === next) interceptor = null;
  };
}

export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

export function executeCommand(id: CommandId): void {
  const routed = interceptor?.(id);
  if (routed === "skip") return;
  const handler = routed ?? handlers.get(id);
  if (!handler) {
    if (import.meta.env?.DEV) log.debug(`no handler for ${id}`);
    return;
  }
  try {
    const result = handler();
    if (result instanceof Promise)
      result.catch((e: unknown) => log.error(`${id} failed: ${(e as Error).message}`));
  } catch (e) {
    log.error(`${id} threw: ${(e as Error).message}`);
  }
}

/** Test-only — clear all handlers between tests. */
export function __resetCommandsForTests(): void {
  handlers.clear();
  interceptor = null;
}
