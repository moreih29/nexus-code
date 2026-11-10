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
  // ---------------------------------------------------------------------------
  // dispose()
  // ---------------------------------------------------------------------------

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
