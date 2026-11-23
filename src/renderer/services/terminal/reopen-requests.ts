type ReopenRequestHandler = () => void;

const handlersBySessionKey = new Map<string, Set<ReopenRequestHandler>>();

function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

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

export function requestTerminalReopen(workspaceId: string, tabId: string): void {
  const handlers = handlersBySessionKey.get(sessionKey(workspaceId, tabId));
  if (!handlers) return;
  for (const handler of [...handlers]) {
    handler();
  }
}

export function resetTerminalReopenRequestsForTests(): void {
  handlersBySessionKey.clear();
}
