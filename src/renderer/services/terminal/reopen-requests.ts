type ReopenRequestHandler = () => void;

const handlersBySessionKey = new Map<string, Set<ReopenRequestHandler>>();

/**
 * Builds the stable domain key used to route manual reopen requests.
 */
function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

/**
 * Registers the view-owned reopen flow for a terminal tab. The terminal
 * controller remains the owner of cwd, dimensions, and scrollback state.
 */
export function subscribeTerminalReopenRequest(
  workspaceId: string,
  tabId: string,
  handler: ReopenRequestHandler,
): () => void {
  const key = sessionKey(workspaceId, tabId);
  let handlers = handlersBySessionKey.get(key);
  if (!handlers) {
    handlers = new Set<ReopenRequestHandler>();
    handlersBySessionKey.set(key, handlers);
  }
  handlers.add(handler);

  return () => {
    const currentHandlers = handlersBySessionKey.get(key);
    if (!currentHandlers) return;
    currentHandlers.delete(handler);
    if (currentHandlers.size === 0) {
      handlersBySessionKey.delete(key);
    }
  };
}

/**
 * Requests an explicit manual reopen for an existing terminal tab.
 */
export function requestTerminalReopen(workspaceId: string, tabId: string): void {
  const handlers = handlersBySessionKey.get(sessionKey(workspaceId, tabId));
  if (!handlers) return;
  for (const handler of [...handlers]) {
    handler();
  }
}

/**
 * Clears registered reopen handlers. Intended for isolated unit tests.
 */
export function resetTerminalReopenRequestsForTests(): void {
  handlersBySessionKey.clear();
}
