/**
 * Unit tests for SshBrowseSessionRegistry.
 *
 * Verifies:
 *  - register() / get() / close() / dispose() lifecycle
 *  - dispose() is idempotent (safe to call multiple times)
 *  - idle-TTL reaper disposes expired sessions
 *  - close() on unknown id is a no-op (idempotent)
 *  - disposeSession catches errors thrown by channel.dispose() and master.dispose()
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

describe("SshBrowseSessionRegistry", () => {
  describe("register / get / size", () => {
    it("registers a session and returns a uuid sessionId", () => {
      const registry = new SshBrowseSessionRegistry();
      const channel = makeChannel();
      const master = makeMaster();

      const sessionId = registry.register(channel, master);

      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(registry.size()).toBe(1);
      registry.dispose();
    });

    it("get returns the session and updates lastUsed", async () => {
      const registry = new SshBrowseSessionRegistry();
      const channel = makeChannel();
      const sessionId = registry.register(channel, null);

      const before = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      const session = registry.get(sessionId);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
      expect(session!.lastUsed).toBeGreaterThanOrEqual(before);
      registry.dispose();
    });

    it("get returns null for an unknown sessionId", () => {
      const registry = new SshBrowseSessionRegistry();
      const result = registry.get("00000000-0000-4000-8000-000000000000");
      expect(result).toBeNull();
      registry.dispose();
    });

    it("multiple register calls produce distinct session IDs", () => {
      const registry = new SshBrowseSessionRegistry();
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
      const registry = new SshBrowseSessionRegistry();
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
      const registry = new SshBrowseSessionRegistry();
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      registry.close(sessionId);
      registry.close(sessionId); // second call — must not throw or double-dispose

      expect(channelDispose).toHaveBeenCalledTimes(1);
      registry.dispose();
    });

    it("close() on unknown id is a no-op and does not throw", () => {
      const registry = new SshBrowseSessionRegistry();
      expect(() =>
        registry.close("00000000-0000-4000-8000-000000000000"),
      ).not.toThrow();
      registry.dispose();
    });

    it("close() without master calls only channel.dispose()", () => {
      const registry = new SshBrowseSessionRegistry();
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
      const registry = new SshBrowseSessionRegistry();
      const disposes = [mock(() => {}), mock(() => {}), mock(() => {})];
      for (const d of disposes) registry.register(makeChannel(d), null);

      expect(registry.size()).toBe(3);
      registry.dispose();
      expect(registry.size()).toBe(0);
      for (const d of disposes) expect(d).toHaveBeenCalledTimes(1);
    });

    it("dispose() is idempotent — safe to call twice", () => {
      const registry = new SshBrowseSessionRegistry();
      const channelDispose = mock(() => {});
      registry.register(makeChannel(channelDispose), null);

      registry.dispose();
      expect(() => registry.dispose()).not.toThrow();
      // channel is disposed exactly once (map is cleared after first dispose)
      expect(channelDispose).toHaveBeenCalledTimes(1);
    });

    it("dispose() swallows errors thrown by channel.dispose()", () => {
      const registry = new SshBrowseSessionRegistry();
      const throwingDispose = mock(() => {
        throw new Error("channel dispose boom");
      });
      registry.register(makeChannel(throwingDispose), null);

      expect(() => registry.dispose()).not.toThrow();
    });

    it("dispose() swallows errors thrown by master.dispose()", () => {
      const registry = new SshBrowseSessionRegistry();
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
    it("reaps sessions whose lastUsed exceeds the idle TTL", async () => {
      const SHORT_TTL = 50; // ms
      const registry = new SshBrowseSessionRegistry(SHORT_TTL);
      const channelDispose = mock(() => {});
      const channel = makeChannel(channelDispose);

      const sessionId = registry.register(channel, null);
      expect(registry.size()).toBe(1);

      // Wait for TTL to expire then manually invoke a reaper tick through
      // the private method via casting — we use a short custom TTL so we
      // don't need to wait 30 seconds.
      await new Promise((r) => setTimeout(r, SHORT_TTL + 10));

      // Trigger reaper manually through the private method.
      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(0);
      expect(channelDispose).toHaveBeenCalledTimes(1);

      // get() should now return null.
      expect(registry.get(sessionId)).toBeNull();

      registry.dispose();
    });

    it("reaper does not evict a recently-touched session", async () => {
      const SHORT_TTL = 200; // ms
      const registry = new SshBrowseSessionRegistry(SHORT_TTL);
      const channel = makeChannel();

      const sessionId = registry.register(channel, null);

      // Touch the session (updates lastUsed).
      registry.get(sessionId);

      // Trigger reaper immediately — lastUsed was just refreshed, so TTL not expired.
      (registry as unknown as { reapExpired: (ttl: number) => void }).reapExpired(SHORT_TTL);

      expect(registry.size()).toBe(1);
      registry.dispose();
    });

  });
});
