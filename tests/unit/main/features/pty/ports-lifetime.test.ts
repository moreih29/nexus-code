import { expect, jest, mock, test } from "bun:test";
import { PortWatcher } from "../../../../../src/main/features/pty/ports";

test("removing a workspace cancels its scheduled port lookup", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, (event: unknown) => void>();
  const lookup = mock(async (_workspaceId: string) => []);
  const watcher = new PortWatcher(
    {
      on(event, callback) {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      },
    },
    lookup,
    () => {},
  );
  try {
    listeners.get("data")?.({ workspaceId: "removed", tabId: "t", replay: true });
    listeners.get("data")?.({ workspaceId: "kept", tabId: "t", replay: true });
    watcher.forgetWorkspace("removed");
    jest.advanceTimersByTime(0);

    expect(lookup.mock.calls).toEqual([["kept"]]);
  } finally {
    watcher.dispose();
    jest.useRealTimers();
  }
});
