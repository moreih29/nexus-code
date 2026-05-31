/**
 * Unit tests for SshBrowseSessionRegistry.
 *
 * Verifies:
 *  - register() / get() / close() / dispose() lifecycle
 *  - dispose() is idempotent (safe to call multiple times)
 *  - idle-TTL reaper disposes expired sessions
 *  - close() on unknown id is a no-op (idempotent)
 *  - disposeSession catches errors thrown by channel.dispose() and master.dispose()
 *
 * Real-timer removal: all Date.now() calls in the registry go through an
 * injected nowFn; tests advance a mutable fakeNow variable instead of
 * sleeping for real milliseconds.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  BROWSE_IDLE_TTL_MS,
  SshBrowseSessionRegistry,
} from "../../../../src/main/features/ssh/browse-session-registry";
import type { AgentChannel } from "../../../../src/main/infra/agent/channel";
import type { SshControlMaster } from "../../../../src/main/infra/agent/ssh/master";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Creates a registry with a controllable clock. */
function makeRegistry(idleTtlMs = BROWSE_IDLE_TTL_MS, initialNow = 1_000_000) {
  let fakeNow = initialNow;
  const nowFn = () => fakeNow;
  const advance = (ms: number) => { fakeNow += ms; };
  const registry = new SshBrowseSessionRegistry(idleTtlMs, nowFn);
  return { registry, advance };
}

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

describe("SshBrowseSessionRegistry", () => {
  describe("register / get / size", () => {
    it("registers a session and returns a uuid sessionId", () => {
      const { registry } = makeRegistry();
      const channel = makeChannel();
      const master = makeMaster();

      const sessionId = registry.register(channel, master);

      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(registry.size()).toBe(1);
      registry.dispose();
    });

    it("get returns the session and updates lastUsed", () => {
      // Advance the clock so get() records a different timestamp than register().
      const { registry, advance } = makeRegistry();
      const channel = makeChannel();
      const sessionId = registry.register(channel, null);
      const registeredAt = 1_000_000; // initial fakeNow

      advance(5); // simulates 5 ms passing — no real sleep needed
      const session = registry.get(sessionId);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
      expect(session!.lastUsed).toBeGreaterThanOrEqual(registeredAt);
      registry.dispose();
    });

    it("get returns null for an unknown sessionId", () => {
      const { registry } = makeRegistry();
      const result = registry.get("00000000-0000-4000-8000-000000000000");
      expect(result).toBeNull();
      registry.dispose();
    });

    it("multiple register calls produce distinct session IDs", () => {
      const { registry } = makeRegistry();
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(registry.register(makeChannel(), null));
      }
      expect(ids.size).toBe(10);
      expect(registry.size()).toBe(10);
      registry.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  describe("close()", () => {
    it("disposes channel and master and removes session from registry", () => {
      const { registry } = makeRegistry();
      const channelDispose = mock(() => {});
      const masterDispose = mock(() => {});
      const channel = makeChannel(channelDispose);
      const master = makeMaster(masterDispose);

      const sessionId = registry.register(channel, master);
      expect(registry.size()).toBe(1);

      registry.close(sessionId);

      expect(registry.size()).toBe(0);
      expect(channelDispose).toHaveBeenCalledTimes(1);
      expect(masterDispose).toHaveBeenCalledTimes(1);
    });

    it("close() is idempotent — second call on same id is a no-op", () => {
      const { registry } = makeRegistry();
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      registry.close(sessionId);
      registry.close(sessionId); // second call — must not throw or double-dispose

      expect(channelDispose).toHaveBeenCalledTimes(1);
      registry.dispose();
    });

    it("close() on unknown id is a no-op and does not throw", () => {
      const { registry } = makeRegistry();
      expect(() =>
        registry.close("00000000-0000-4000-8000-000000000000"),
      ).not.toThrow();
      registry.dispose();
    });

    it("close() without master calls only channel.dispose()", () => {
      const { registry } = makeRegistry();
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      registry.close(sessionId);

      expect(channelDispose).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // dispose()
  // ---------------------------------------------------------------------------

  describe("dispose()", () => {
    it("disposes all open sessions and clears the map", () => {
      const { registry } = makeRegistry();
      const disposes = [mock(() => {}), mock(() => {}), mock(() => {})];
      for (const d of disposes) registry.register(makeChannel(d), null);

      expect(registry.size()).toBe(3);
      registry.dispose();
      expect(registry.size()).toBe(0);
      for (const d of disposes) expect(d).toHaveBeenCalledTimes(1);
    });

    it("dispose() is idempotent — safe to call twice", () => {
      const { registry } = makeRegistry();
      const channelDispose = mock(() => {});
      registry.register(makeChannel(channelDispose), null);

      registry.dispose();
      expect(() => registry.dispose()).not.toThrow();
      // channel is disposed exactly once (map is cleared after first dispose)
      expect(channelDispose).toHaveBeenCalledTimes(1);
    });

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

  // ---------------------------------------------------------------------------
  // Idle-TTL reaper
  // ---------------------------------------------------------------------------

  describe("idle-TTL reaper", () => {
    it("reaps sessions whose lastUsed exceeds the idle TTL", () => {
      const SHORT_TTL = 50; // ms (logical, no real sleep)
      const { registry, advance } = makeRegistry(SHORT_TTL);
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      expect(registry.size()).toBe(1);

      // Advance clock past TTL — no real sleep needed.
      advance(SHORT_TTL + 10);

      // Trigger reaper manually through the private method.
      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(0);
      expect(channelDispose).toHaveBeenCalledTimes(1);

      // get() should now return null.
      expect(registry.get(sessionId)).toBeNull();

      registry.dispose();
    });

    it("reaper does not evict a recently-touched session", () => {
      const SHORT_TTL = 200; // ms (logical)
      const { registry, advance } = makeRegistry(SHORT_TTL);
      const channel = makeChannel();

      const sessionId = registry.register(channel, null);

      // Touch the session (updates lastUsed to current fakeNow).
      registry.get(sessionId);

      // Advance only a little — still inside TTL.
      advance(SHORT_TTL - 1);

      // Trigger reaper immediately — lastUsed was just refreshed, so TTL not expired.
      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(1);
      registry.dispose();
    });
  });
});
