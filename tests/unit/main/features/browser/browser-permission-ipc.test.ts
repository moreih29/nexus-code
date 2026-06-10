/**
 * IPC round-trip tests for the browserPermission channel.
 *
 * Verifies that respond/cancel/listRemembered/revoke IPC call args are
 * correctly validated and routed to the right manager/storage methods.
 *
 * Uses DI-first: BrowserPermissionPromptManager injected with fake deps;
 * WorkspaceStorage injected with a fake (no SQLite needed).
 * mock.module is used only for the ipc-router leaf (electron boundary).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Leaf mock: ipc-router
// ---------------------------------------------------------------------------

type RegisteredChannel = {
  call: Record<string, (args: unknown) => unknown>;
  listen: Record<string, object>;
};
const registeredChannels = new Map<string, RegisteredChannel>();

const realIpcRouter = await import("../../../../../src/main/infra/ipc-router");
mock.module("../../../../../src/main/infra/ipc-router", () => ({
  ...realIpcRouter,
  register: (channelName: string, def: RegisteredChannel) => {
    registeredChannels.set(channelName, def);
  },
  broadcast: mock(() => {}),
  validateArgs: realIpcRouter.validateArgs,
}));

// ---------------------------------------------------------------------------
// Module under test — import after mock
// ---------------------------------------------------------------------------

const { registerBrowserChannel } = await import("../../../../../src/main/features/browser/ipc");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeOriginPermRow {
  origin: string;
  permission: string;
  decision: "allow" | "block";
}

function makeFakeRegistry() {
  return {
    create: () => {},
    destroy: () => {},
    setBounds: () => {},
    setActive: () => {},
    navigate: () => {},
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    openDevTools: () => ({ open: false }),
    setDevToolsBounds: () => {},
    suspendAll: async () => [],
    resumeAll: () => [],
    get: () => undefined,
    listByWorkspace: () => [],
    disposeAll: () => {},
  } as unknown as import("../../../../../src/main/features/browser/registry").BrowserTabRegistry;
}

type RespondArgs = Parameters<
  import("../../../../../src/main/features/browser/permission-prompt-manager").BrowserPermissionPromptManager["respond"]
>;
type CancelArgs = Parameters<
  import("../../../../../src/main/features/browser/permission-prompt-manager").BrowserPermissionPromptManager["cancel"]
>;

function makeFakePromptManager() {
  const respondCalls: RespondArgs[] = [];
  const cancelCalls: CancelArgs[] = [];

  return {
    manager: {
      handlePermissionRequest: () => {},
      respond: (...args: RespondArgs) => respondCalls.push(args),
      cancel: (...args: CancelArgs) => cancelCalls.push(args),
      disposeByWebContents: () => {},
    } as unknown as import("../../../../../src/main/features/browser/permission-prompt-manager").BrowserPermissionPromptManager,
    respondCalls,
    cancelCalls,
  };
}

function makeFakeWorkspaceStorage(rows: FakeOriginPermRow[] = []) {
  const deletedCalls: Array<{ workspaceId: string; origin: string; permission: string }> = [];

  return {
    storage: {
      isOpen: (_wsId: string) => true,
      listOriginPermissions: (_wsId: string) => rows,
      deleteOriginPermission: (wsId: string, origin: string, perm: string) => {
        deletedCalls.push({ workspaceId: wsId, origin, permission: perm });
      },
    } as unknown as import("../../../../../src/main/infra/storage/workspace-storage").WorkspaceStorage,
    deletedCalls,
  };
}

function makeFakeGlobalStorage(workspaceIds: string[] = []) {
  return {
    listWorkspaces: () => workspaceIds.map((id) => ({ id })),
  } as unknown as import("../../../../../src/main/infra/storage/global-storage").GlobalStorage;
}

// ---------------------------------------------------------------------------
// Setup: register the channel before each test
// ---------------------------------------------------------------------------

let respond: (args: unknown) => unknown;
let cancel: (args: unknown) => unknown;
let listRemembered: (args: unknown) => unknown;
let revoke: (args: unknown) => unknown;

let promptFake: ReturnType<typeof makeFakePromptManager>;
let storageFake: ReturnType<typeof makeFakeWorkspaceStorage>;

beforeEach(() => {
  registeredChannels.clear();
  promptFake = makeFakePromptManager();

  const rows: FakeOriginPermRow[] = [
    { origin: "https://a.com", permission: "geolocation", decision: "allow" },
    { origin: "https://b.com", permission: "media", decision: "block" },
  ];
  storageFake = makeFakeWorkspaceStorage(rows);

  const globalStorage = makeFakeGlobalStorage(["ws-1"]);

  registerBrowserChannel(makeFakeRegistry(), {
    promptManager: promptFake.manager,
    workspaceStorage: storageFake.storage,
    globalStorage,
  });

  const bpChannel = registeredChannels.get("browserPermission");
  if (!bpChannel) throw new Error("browserPermission channel not registered");

  respond = bpChannel.call.respond;
  cancel = bpChannel.call.cancel;
  listRemembered = bpChannel.call.listRemembered;
  revoke = bpChannel.call.revoke;
});

// ---------------------------------------------------------------------------
// respond round-trip
// ---------------------------------------------------------------------------

describe("browserPermission IPC — respond", () => {
  test("routes to promptManager.respond with correct args (allow, remember=true)", () => {
    respond({ promptId: "pid-1", decision: "allow", remember: true });

    expect(promptFake.respondCalls).toHaveLength(1);
    expect(promptFake.respondCalls[0]).toEqual(["pid-1", "allow", true]);
  });

  test("routes to promptManager.respond with correct args (block, remember=false)", () => {
    respond({ promptId: "pid-2", decision: "block", remember: false });

    expect(promptFake.respondCalls).toHaveLength(1);
    expect(promptFake.respondCalls[0]).toEqual(["pid-2", "block", false]);
  });

  test("throws validation error for missing promptId", () => {
    expect(() => respond({ decision: "allow", remember: false })).toThrow();
  });

  test("throws validation error for invalid decision value", () => {
    expect(() => respond({ promptId: "pid-1", decision: "maybe", remember: false })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// cancel round-trip
// ---------------------------------------------------------------------------

describe("browserPermission IPC — cancel", () => {
  test("routes to promptManager.cancel", () => {
    cancel({ promptId: "pid-99" });

    expect(promptFake.cancelCalls).toHaveLength(1);
    expect(promptFake.cancelCalls[0]).toEqual(["pid-99"]);
  });

  test("throws validation error for missing promptId", () => {
    expect(() => cancel({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// listRemembered
// ---------------------------------------------------------------------------

describe("browserPermission IPC — listRemembered", () => {
  test("returns rows for the given workspaceId", () => {
    const result = listRemembered({ workspaceId: "ws-1" }) as { value: unknown[] };
    expect(result.value).toHaveLength(2);
    expect((result.value[0] as { workspaceId: string }).workspaceId).toBe("ws-1");
    expect((result.value[0] as { origin: string }).origin).toBe("https://a.com");
  });

  test("returns [] for unknown/closed workspaceId (isOpen=false)", () => {
    // Override isOpen to return false
    const closedStorageFake = makeFakeWorkspaceStorage();
    closedStorageFake.storage.isOpen = (_wsId: string) => false;

    registeredChannels.clear();
    registerBrowserChannel(makeFakeRegistry(), {
      promptManager: promptFake.manager,
      workspaceStorage: closedStorageFake.storage,
      globalStorage: makeFakeGlobalStorage(),
    });

    const bpChannel = registeredChannels.get("browserPermission")!;
    const result = bpChannel.call.listRemembered({ workspaceId: "unknown-ws" }) as {
      value: unknown[];
    };
    expect(result.value).toHaveLength(0);
  });

  test("global query (no workspaceId) aggregates across open workspaces", () => {
    const result = listRemembered({}) as { value: unknown[] };
    // globalStorage has ws-1 open, storage returns 2 rows
    expect(result.value).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("browserPermission IPC — revoke", () => {
  test("calls deleteOriginPermission with correct args", () => {
    revoke({ workspaceId: "ws-1", origin: "https://a.com", permission: "geolocation" });

    expect(storageFake.deletedCalls).toHaveLength(1);
    expect(storageFake.deletedCalls[0]).toEqual({
      workspaceId: "ws-1",
      origin: "https://a.com",
      permission: "geolocation",
    });
  });

  test("throws validation error for unrecognised permission kind", () => {
    expect(() =>
      revoke({ workspaceId: "ws-1", origin: "https://a.com", permission: "not-a-real-permission" }),
    ).toThrow();
  });
});
