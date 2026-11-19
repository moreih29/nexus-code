import { expect, jest, mock, test } from "bun:test";
import { SshBrowseSessionRegistry } from "../../../../../src/main/features/ssh/browse-session-registry";
import type { AgentChannel } from "../../../../../src/main/infra/agent/channel";

test("browsing after every window closed still reaps abandoned sessions", () => {
  jest.useFakeTimers();
  let now = 0;
  const registry = new SshBrowseSessionRegistry(100, () => now);
  const channel = { dispose: mock(() => {}) } as unknown as AgentChannel;
  const next = { dispose: mock(() => {}) } as unknown as AgentChannel;
  try {
    registry.register(channel, null);
    registry.closeAll();
    expect(channel.dispose).toHaveBeenCalledTimes(1);

    const id = registry.register(next, null);
    now = 30_000;
    jest.advanceTimersByTime(30_000);

    expect(registry.get(id)).toBeNull();
    expect(next.dispose).toHaveBeenCalledTimes(1);
  } finally {
    registry.dispose();
    jest.useRealTimers();
  }
});
