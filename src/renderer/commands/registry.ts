import type { CommandId } from "../../shared/keybindings/commands";
import { createLogger } from "../../shared/log/renderer";

const log = createLogger("commands");

export type CommandHandler = () => void | Promise<void>;

const handlers = new Map<CommandId, CommandHandler>();

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

export function __resetCommandsForTests(): void {
  handlers.clear();
  interceptor = null;
}
