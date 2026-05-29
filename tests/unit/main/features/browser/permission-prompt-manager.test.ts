/**
 * Unit tests for BrowserPermissionPromptManager.
 *
 * All tests use the DI seam — no Electron import or mock.module required.
 * broadcast and setRemembered are injected as plain mock functions.
 *
 * Coverage:
 *   1. allow/block decisions resolved immediately (no broadcast).
 *   2. ask → broadcast once, coalesce subsequent calls.
 *   3. respond: resolves all waiters, calls setRemembered when remember=true.
 *   4. cancel: denies all waiters, no setRemembered.
 *   5. disposeByWebContents: removes only matching waiters, denies them.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BrowserPermissionPromptManager,
} from "../../../../../src/main/features/browser/permission-prompt-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let broadcastCalls: Array<{ channelName: string; event: string; args: unknown }> = [];
let setRememberedCalls: Array<{
  workspaceId: string;
  origin: string;
  permission: string;
  decision: "allow" | "block";
}> = [];
let idCounter = 0;

function makeManager() {
  broadcastCalls = [];
  setRememberedCalls = [];
  idCounter = 0;

  return new BrowserPermissionPromptManager({
    broadcast: (channelName, event, args) => {
      broadcastCalls.push({ channelName, event, args });
    },
    setRemembered: (workspaceId, origin, permission, decision) => {
      setRememberedCalls.push({ workspaceId, origin, permission, decision });
    },
    generateId: () => `prompt-${++idCounter}`,
  });
}

// ---------------------------------------------------------------------------
// 1. allow decision — immediate callback(true), no broadcast
// ---------------------------------------------------------------------------

describe("handlePermissionRequest — allow", () => {
  test("calls callback(true) immediately without broadcasting", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "media", webContentsId: 1, decision: "allow" },
      (ok) => { result = ok; },
    );

    expect(result).toBe(true);
    expect(broadcastCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. block decision — immediate callback(false), no broadcast
// ---------------------------------------------------------------------------

describe("handlePermissionRequest — block", () => {
  test("calls callback(false) immediately without broadcasting", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "media", webContentsId: 1, decision: "block" },
      (ok) => { result = ok; },
    );

    expect(result).toBe(false);
    expect(broadcastCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. ask decision — broadcast once
// ---------------------------------------------------------------------------

describe("handlePermissionRequest — ask (first request)", () => {
  test("broadcasts a prompt and registers the waiter", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "notifications", webContentsId: 1, decision: "ask" },
      (ok) => { result = ok; },
    );

    // callback not called yet
    expect(result).toBeNull();
    // broadcast fired exactly once
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0].channelName).toBe("browserPermission");
    expect(broadcastCalls[0].event).toBe("prompt");
    expect((broadcastCalls[0].args as { promptId: string }).promptId).toBe("prompt-1");
    expect((broadcastCalls[0].args as { permissions: string[] }).permissions).toEqual(["notifications"]);
  });
});

// ---------------------------------------------------------------------------
// 4. coalesce — same key, no second broadcast
// ---------------------------------------------------------------------------

describe("handlePermissionRequest — coalesce", () => {
  test("adds waiter to existing group, no second broadcast", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "notifications", webContentsId: 1, decision: "ask" },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "notifications", webContentsId: 2, decision: "ask" },
      (ok) => results.push(ok),
    );

    // Still only one broadcast
    expect(broadcastCalls).toHaveLength(1);
    // No callbacks fired yet
    expect(results).toHaveLength(0);
  });

  test("different permission key creates new broadcast", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "notifications", webContentsId: 1, decision: "ask" },
      () => {},
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://example.com", permission: "geolocation", webContentsId: 1, decision: "ask" },
      () => {},
    );

    expect(broadcastCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. respond — resolves waiters, calls setRemembered when remember=true
// ---------------------------------------------------------------------------

describe("respond", () => {
  test("resolves all waiters with allow=true", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 2, decision: "ask" },
      (ok) => results.push(ok),
    );

    manager.respond("prompt-1", "allow", false);

    expect(results).toEqual([true, true]);
  });

  test("resolves all waiters with allow=false when decision is block", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      (ok) => results.push(ok),
    );

    manager.respond("prompt-1", "block", false);

    expect(results).toEqual([false]);
  });

  test("calls setRemembered when remember=true", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      { workspaceId: "ws-2", origin: "https://b.com", permission: "geolocation", webContentsId: 1, decision: "ask" },
      () => {},
    );

    manager.respond("prompt-1", "allow", true);

    expect(setRememberedCalls).toHaveLength(1);
    expect(setRememberedCalls[0]).toEqual({
      workspaceId: "ws-2",
      origin: "https://b.com",
      permission: "geolocation",
      decision: "allow",
    });
  });

  test("does NOT call setRemembered when remember=false", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      () => {},
    );

    manager.respond("prompt-1", "allow", false);

    expect(setRememberedCalls).toHaveLength(0);
  });

  test("is a no-op for unknown promptId", () => {
    const manager = makeManager();
    expect(() => manager.respond("unknown-id", "allow", false)).not.toThrow();
  });

  test("removes the pending entry after resolution", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      (ok) => results.push(ok),
    );
    manager.respond("prompt-1", "allow", false);

    // Second respond with the same promptId should be no-op (already cleared)
    manager.respond("prompt-1", "block", false);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. cancel — denies all waiters, no setRemembered
// ---------------------------------------------------------------------------

describe("cancel", () => {
  test("denies all waiters", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 2, decision: "ask" },
      (ok) => results.push(ok),
    );

    manager.cancel("prompt-1");

    expect(results).toEqual([false, false]);
  });

  test("does NOT call setRemembered", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 1, decision: "ask" },
      () => {},
    );
    manager.cancel("prompt-1");

    expect(setRememberedCalls).toHaveLength(0);
  });

  test("is a no-op for unknown promptId", () => {
    const manager = makeManager();
    expect(() => manager.cancel("no-such-id")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. disposeByWebContents — removes matching waiters, denies them
// ---------------------------------------------------------------------------

describe("disposeByWebContents", () => {
  test("denies callbacks for matching webContentsId", () => {
    const manager = makeManager();
    const results: Array<{ id: number; ok: boolean }> = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 10, decision: "ask" },
      (ok) => results.push({ id: 10, ok }),
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 20, decision: "ask" },
      (ok) => results.push({ id: 20, ok }),
    );

    manager.disposeByWebContents(10);

    // Only the watcher for webContentsId=10 should have been denied
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: 10, ok: false });
  });

  test("leaves non-matching waiters in place", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 10, decision: "ask" },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 20, decision: "ask" },
      (ok) => results.push(ok),
    );

    manager.disposeByWebContents(10);

    // waiter 20 is still pending — not yet resolved
    expect(results).toHaveLength(1);

    // Now respond — the remaining waiter (id=20) should resolve
    manager.respond("prompt-1", "allow", false);
    expect(results).toEqual([false, true]);
  });

  test("removes empty pending group from the map", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 10, decision: "ask" },
      () => {},
    );

    manager.disposeByWebContents(10);

    // After dispose the group is gone; a new request should create a new prompt
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 10, decision: "ask" },
      () => {},
    );

    // Two broadcasts: initial + after dispose the new one
    expect(broadcastCalls).toHaveLength(2);
    expect((broadcastCalls[1].args as { promptId: string }).promptId).toBe("prompt-2");
  });

  test("no-op when webContentsId has no waiters", () => {
    const manager = makeManager();
    manager.handlePermissionRequest(
      { workspaceId: "ws-1", origin: "https://a.com", permission: "media", webContentsId: 10, decision: "ask" },
      () => {},
    );

    expect(() => manager.disposeByWebContents(99)).not.toThrow();
    // The existing waiter for id=10 is untouched
    expect(broadcastCalls).toHaveLength(1);
  });
});
