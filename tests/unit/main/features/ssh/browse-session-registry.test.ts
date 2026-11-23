import { describe, expect, it, jest, mock, test } from "bun:test";
import {
  BROWSE_IDLE_TTL_MS,
  SshBrowseSessionRegistry,
} from "../../../../../src/main/features/ssh/browse-session-registry";
import type { AgentChannel } from "../../../../../src/main/infra/agent/channel";
import type { SshControlMaster } from "../../../../../src/main/infra/agent/ssh/master";

function makeChannel(disposeFn = mock(() => {})): AgentChannel {
  return {
    ready: Promise.resolve(),
    call: mock(async () => undefined),
    fire: mock(() => {}),
    on: mock(() => () => {}),
    onLifecycle: mock(() => () => {}),
    dispose: disposeFn,
  };
}

function makeMaster(disposeFn = mock(() => {})): SshControlMaster {
  return {
    controlPath: "/tmp/nexus-test/control.sock",
    host: "test.example.com",
    dispose: disposeFn,
  };
}

function makeRegistry(idleTtlMs = BROWSE_IDLE_TTL_MS, initialNow = 1_000_000) {
  let fakeNow = initialNow;
  const nowFn = () => fakeNow;
  const advance = (ms: number) => {
    fakeNow += ms;
  };
  const registry = new SshBrowseSessionRegistry(idleTtlMs, nowFn);
  return { registry, advance };
}

describe("SshBrowseSessionRegistry", () => {
  describe("dispose()", () => {
    it("dispose() swallows errors thrown by channel.dispose()", () => {
      const { registry } = makeRegistry();
      const throwingDispose = mock(() => {
        throw new Error("channel dispose boom");
      });
      registry.register(makeChannel(throwingDispose), null);

      expect(() => registry.dispose()).not.toThrow();
    });

    it("dispose() swallows errors thrown by master.dispose()", () => {
      const { registry } = makeRegistry();
      const throwingMasterDispose = mock(() => {
        throw new Error("master dispose boom");
      });
      registry.register(makeChannel(), makeMaster(throwingMasterDispose));

      expect(() => registry.dispose()).not.toThrow();
    });
  });

  describe("idle-TTL reaper", () => {
    it("reaps sessions whose lastUsed exceeds the idle TTL", () => {
      const SHORT_TTL = 50;
      const { registry, advance } = makeRegistry(SHORT_TTL);
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      expect(registry.size()).toBe(1);

      advance(SHORT_TTL + 10);

      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(0);
      expect(channelDispose).toHaveBeenCalledTimes(1);

      expect(registry.get(sessionId)).toBeNull();

      registry.dispose();
    });

    it("reaper does not evict a recently-touched session", () => {
      const SHORT_TTL = 200;
      const { registry, advance } = makeRegistry(SHORT_TTL);
      const channel = makeChannel();

      const sessionId = registry.register(channel, null);

      registry.get(sessionId);

      advance(SHORT_TTL - 1);

      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(1);
      registry.dispose();
    });
  });
});

test("browsing after every window closed still reaps abandoned sessions", () => {
  jest.useFakeTimers();
  let now = 0;
  const registry = new SshBrowseSessionRegistry(100, () => now);
  const channel = makeChannel();
  const next = makeChannel();
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
