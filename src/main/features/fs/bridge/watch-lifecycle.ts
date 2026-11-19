import type { AgentBackedProvider } from "./provider";

/** Binds change and reconnect signals only while their provider registration is current. */
export function subscribeAgentWatch(
  provider: AgentBackedProvider,
  eventName: string,
  isCurrent: () => boolean,
  onChanged: (payload: unknown) => void,
  onReady: () => void,
): () => void {
  const offChanged = provider.onAgentEvent(eventName, (payload) => {
    if (isCurrent()) onChanged(payload);
  });
  const offLifecycle = provider.onAgentLifecycle((event) => {
    if (event.type === "ready" && isCurrent()) onReady();
  });
  return () => {
    offChanged();
    offLifecycle();
  };
}

/** Runs one watch operation after any earlier operation for the same key. */
export function enqueueWatchOperation<Key>(
  pending: Map<Key, Promise<void>>,
  key: Key,
  run: () => Promise<void>,
  onSettled?: () => void,
): Promise<void> {
  const previous = pending.get(key);
  const operation = (previous ? previous.then(run, run) : run()).finally(() => {
    if (pending.get(key) === operation) pending.delete(key);
    onSettled?.();
  });
  pending.set(key, operation);
  return operation;
}
