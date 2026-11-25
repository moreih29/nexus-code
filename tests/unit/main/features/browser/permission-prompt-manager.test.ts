import { describe, expect, test } from "bun:test";
import { BrowserPermissionPromptManager } from "../../../../../src/main/features/browser/permission-prompt-manager";

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

describe("handlePermissionRequest — allow", () => {
  test("calls callback(true) immediately without broadcasting", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "media",
        webContentsId: 1,
        decision: "allow",
      },
      (ok) => {
        result = ok;
      },
    );

    expect(result).toBe(true);
    expect(broadcastCalls).toHaveLength(0);
  });
});

describe("handlePermissionRequest — block", () => {
  test("calls callback(false) immediately without broadcasting", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "media",
        webContentsId: 1,
        decision: "block",
      },
      (ok) => {
        result = ok;
      },
    );

    expect(result).toBe(false);
    expect(broadcastCalls).toHaveLength(0);
  });
});

describe("handlePermissionRequest — ask (first request)", () => {
  test("broadcasts a prompt and registers the waiter", () => {
    const manager = makeManager();
    let result: boolean | null = null;

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "notifications",
        webContentsId: 1,
        decision: "ask",
      },
      (ok) => {
        result = ok;
      },
    );

    expect(result).toBeNull();
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0].channelName).toBe("browserPermission");
    expect(broadcastCalls[0].event).toBe("prompt");
    expect((broadcastCalls[0].args as { promptId: string }).promptId).toBe("prompt-1");
    expect((broadcastCalls[0].args as { permissions: string[] }).permissions).toEqual([
      "notifications",
    ]);
  });
});

describe("handlePermissionRequest — coalesce", () => {
  test("adds waiter to existing group, no second broadcast", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "notifications",
        webContentsId: 1,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "notifications",
        webContentsId: 2,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );

    expect(broadcastCalls).toHaveLength(1);
    expect(results).toHaveLength(0);
  });

  test("different permission key creates new broadcast", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "notifications",
        webContentsId: 1,
        decision: "ask",
      },
      () => {},
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://example.com",
        permission: "geolocation",
        webContentsId: 1,
        decision: "ask",
      },
      () => {},
    );

    expect(broadcastCalls).toHaveLength(2);
  });
});

describe("respond", () => {
  test("resolves all waiters with allow=true", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 1,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 2,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );

    manager.respond("prompt-1", "allow", false);

    expect(results).toEqual([true, true]);
  });

  test("resolves all waiters with allow=false when decision is block", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 1,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );

    manager.respond("prompt-1", "block", false);

    expect(results).toEqual([false]);
  });

  test("calls setRemembered when remember=true", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-2",
        origin: "https://b.com",
        permission: "geolocation",
        webContentsId: 1,
        decision: "ask",
      },
      () => {},
    );

    manager.respond("prompt-1", "allow", true);

    expect(broadcastCalls.at(-1)).toEqual({
      channelName: "browserPermission",
      event: "rememberedChanged",
      args: { workspaceId: "ws-2" },
    });
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
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 1,
        decision: "ask",
      },
      () => {},
    );

    manager.respond("prompt-1", "allow", false);

    expect(setRememberedCalls).toHaveLength(0);
    expect(broadcastCalls.map(({ event }) => event)).not.toContain("rememberedChanged");
  });
});

describe("cancel", () => {
  test("denies all waiters", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 1,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 2,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );

    manager.cancel("prompt-1");

    expect(results).toEqual([false, false]);
  });

  test("does NOT call setRemembered", () => {
    const manager = makeManager();

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 1,
        decision: "ask",
      },
      () => {},
    );
    manager.cancel("prompt-1");

    expect(setRememberedCalls).toHaveLength(0);
  });
});

describe("disposeByWebContents", () => {
  test("denies callbacks for matching webContentsId", () => {
    const manager = makeManager();
    const results: Array<{ id: number; ok: boolean }> = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 10,
        decision: "ask",
      },
      (ok) => results.push({ id: 10, ok }),
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 20,
        decision: "ask",
      },
      (ok) => results.push({ id: 20, ok }),
    );

    manager.disposeByWebContents(10);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: 10, ok: false });
  });

  test("leaves non-matching waiters in place", () => {
    const manager = makeManager();
    const results: boolean[] = [];

    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 10,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 20,
        decision: "ask",
      },
      (ok) => results.push(ok),
    );

    manager.disposeByWebContents(10);

    expect(results).toHaveLength(1);

    manager.respond("prompt-1", "allow", false);
    expect(results).toEqual([false, true]);
  });

  test("tells the renderer to drop a prompt nothing waits on any more", () => {
    const manager = makeManager();
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 10,
        decision: "ask",
      },
      () => {},
    );
    manager.handlePermissionRequest(
      {
        workspaceId: "ws-1",
        origin: "https://a.com",
        permission: "media",
        webContentsId: 20,
        decision: "ask",
      },
      () => {},
    );

    manager.disposeByWebContents(10);
    expect(broadcastCalls.filter((call) => call.event === "dismissed")).toEqual([]);

    manager.disposeByWebContents(20);
    expect(broadcastCalls.filter((call) => call.event === "dismissed")).toEqual([
      { channelName: "browserPermission", event: "dismissed", args: { promptId: "prompt-1" } },
    ]);
  });
});
