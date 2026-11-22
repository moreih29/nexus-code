/**
 * The agent view's store: what was stored comes back with only the agents
 * whose tabs still exist, and a change is stored once things settle, never
 * before what was stored came back.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { remoteFileKey } from "../../../../../src/shared/fs/remote-file-key";
import { type IpcResult, ipcOk } from "../../../../../src/shared/ipc/result";
import type { RemoteAccountState } from "../../../../../src/shared/remote/account";
import {
  AgentViewSnapshotSchema,
  MAX_REMOTE_SEEN,
} from "../../../../../src/shared/types/agent-view";

const stored: unknown[] = [];
let accountReply: Promise<IpcResult<RemoteAccountState>> | undefined;
let accountChanged: ((state: RemoteAccountState) => void) | undefined;

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel === "appState" && method === "set") stored.push(args);
    if (channel === "remote" && method === "account" && accountReply) return accountReply;
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  ipcListen(channel: string, event: string, listener: (state: RemoteAccountState) => void) {
    if (channel === "remote" && event === "accountChanged") accountChanged = listener;
    return () => {
      if (accountChanged === listener) accountChanged = undefined;
    };
  },
}));

const {
  __resetAgentViewForTests,
  flushAgentViewPersistence,
  startAgentViewPeerOrderSync,
  useAgentViewStore,
} = await import("../../../../../src/renderer/state/stores/agent-view");
const { heldKeys, openKey, remoteSessionKey, removeKey } = await import(
  "../../../../../src/renderer/services/agent-view/layout"
);

const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const A = "ws-a:t1";
const B = "ws-b:t2";
const SIGNED_IN = {
  status: "signed-in" as const,
  server: "https://nexus.example",
  user: { id: "user-1", name: "User", email: "user@example.com" },
  device: { id: "self", name: "Mac", platform: "darwin" },
};
const PEER_ORDER_ACCOUNT = JSON.stringify([SIGNED_IN.server, SIGNED_IN.user.id]);

/** Past the store's wait before it stores a change. */
const settle = () => jest.advanceTimersByTime(400);

describe("agent view store", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    stored.length = 0;
    __resetAgentViewForTests();
  });

  afterEach(() => {
    __resetAgentViewForTests();
    accountReply = undefined;
    accountChanged = undefined;
    jest.useRealTimers();
  });

  it("restores the mode and the panels, without the agents whose tabs closed", () => {
    useAgentViewStore.getState().hydrate(
      {
        mode: "agents",
        root: {
          kind: "split",
          id: "00000000-0000-4000-8000-0000000000b1",
          orientation: "horizontal",
          ratio: 0.4,
          first: { kind: "leaf", id: P1, tabIds: [A], activeTabId: A },
          second: { kind: "leaf", id: P2, tabIds: [B], activeTabId: B },
        },
        activeLeafId: P2,
      },
      (key) => key === A,
    );
    const state = useAgentViewStore.getState();
    expect(state.mode).toBe("agents");
    expect(state.root).toEqual({ kind: "leaf", id: P1, tabIds: [A], activeTabId: A });
    expect(state.activeLeafId).toBe(P1);
  });

  it("stores nothing before what was stored came back", async () => {
    useAgentViewStore.getState().setMode("agents");
    await settle();
    expect(stored).toEqual([]);
  });

  it("stores the mode and the panels once a change settles", async () => {
    useAgentViewStore.getState().hydrate(undefined, () => true);
    useAgentViewStore.getState().setMode("agents");
    useAgentViewStore.getState().update((layout) => openKey(layout, A));
    await settle();
    expect(stored).toHaveLength(1);
    const { agentView } = stored[0] as { agentView: { mode: string; root: { tabIds: string[] } } };
    expect(agentView.mode).toBe("agents");
    expect(agentView.root.tabIds).toEqual([A]);
  });

  it("flushes a peer file before closing, restores it without the session, and prunes its details", async () => {
    const where = { deviceId: "mac", workspaceId: "project" };
    const session = remoteSessionKey({ ...where, tabId: "chat" });
    const file = remoteFileKey({ ...where, path: "/project/한글 #.md" });
    const details = {
      deviceName: "Mac",
      workspaceRoot: "/project",
      at: { line: 2 },
      compareFrom: "chat",
    };
    const view = useAgentViewStore.getState();
    view.hydrate(undefined, () => true);
    view.setMode("agents");
    view.update((layout) => openKey(layout, session));
    view.placeRemoteFile(file, session, { ...details, before: "old text" });
    expect(heldKeys(useAgentViewStore.getState().root)).toEqual([session, file]);

    expect(await flushAgentViewPersistence()).toBe(true);
    const saved = AgentViewSnapshotSchema.parse((stored[0] as { agentView: unknown }).agentView);
    expect(saved.remoteFiles).toEqual({ [file]: details });
    __resetAgentViewForTests();
    view.hydrate(saved, () => false);
    const restored = useAgentViewStore.getState();
    expect(heldKeys(restored.root)).toEqual([file]);
    expect(restored.root.kind).toBe("leaf");
    expect(restored.remoteFiles.get(file)).toEqual(details);

    view.update((layout) => removeKey(layout, file));
    expect(useAgentViewStore.getState().remoteFiles.size).toBe(0);
    await flushAgentViewPersistence();
    expect((stored[1] as { agentView: object }).agentView).not.toHaveProperty("remoteFiles");
  });

  it("restores the ended agents of the panels' terminals, and stores them as they change", async () => {
    useAgentViewStore.getState().hydrate(
      {
        mode: "agents",
        root: { kind: "leaf", id: P1, tabIds: [A], activeTabId: A },
        activeLeafId: P1,
        ended: {
          [A]: { agent: "claude", sessionId: "s-1", prompted: true },
          [B]: { agent: "codex", prompted: false },
        },
      },
      () => true,
    );
    const { ended } = useAgentViewStore.getState();
    expect([...ended.entries()]).toEqual([
      [A, { agent: "claude", sessionId: "s-1", prompted: true }],
    ]);

    useAgentViewStore.getState().setEnded(new Map(ended));
    await settle();
    expect(stored).toEqual([]);

    useAgentViewStore.getState().setEnded(new Map());
    await settle();
    expect(stored).toHaveLength(1);
    expect((stored[0] as { agentView: object }).agentView).not.toHaveProperty("ended");

    useAgentViewStore
      .getState()
      .setEnded(new Map([[A, { agent: "codex", sessionId: undefined, prompted: false }]]));
    await settle();
    expect((stored[1] as { agentView: { ended: unknown } }).agentView.ended).toEqual({
      [A]: { agent: "codex", prompted: false },
    });
  });

  it("restores the list's order without the agents whose tabs closed, and stores it as it changes", async () => {
    useAgentViewStore.getState().hydrate(
      {
        mode: "agents",
        root: { kind: "leaf", id: P1, tabIds: [], activeTabId: null },
        activeLeafId: P1,
        order: { "ws-a": ["ws-a:t3", A, "ws-a:gone"], "ws-b": ["ws-b:gone"] },
      },
      (key) => !key.endsWith(":gone"),
    );
    expect(useAgentViewStore.getState().order).toEqual({ "ws-a": ["ws-a:t3", A] });

    useAgentViewStore.getState().setOrder("ws-a", ["ws-a:t3", A]);
    await settle();
    expect(stored).toEqual([]);

    useAgentViewStore.getState().setOrder("ws-b", [B, "ws-b:t4"]);
    await settle();
    expect((stored[0] as { agentView: { order: unknown } }).agentView.order).toEqual({
      "ws-a": ["ws-a:t3", A],
      "ws-b": [B, "ws-b:t4"],
    });
  });

  it("reads older snapshots and round-trips the computer order for the same account", async () => {
    const older = AgentViewSnapshotSchema.parse({
      mode: "agents",
      root: { kind: "leaf", id: P1, tabIds: [], activeTabId: null },
      activeLeafId: P1,
      peerOrder: ["old-unscoped-device"],
    });
    const view = useAgentViewStore.getState();
    view.hydrate(older, () => false);
    expect(useAgentViewStore.getState().peerOrder).toBeUndefined();

    view.setPeerOrderAccount(PEER_ORDER_ACCOUNT);
    view.setPeerOrder(PEER_ORDER_ACCOUNT, ["pc", "mac"]);
    expect(await flushAgentViewPersistence()).toBe(true);
    const saved = AgentViewSnapshotSchema.parse((stored[0] as { agentView: unknown }).agentView);
    expect(saved.peerOrder).toEqual({ accountKey: PEER_ORDER_ACCOUNT, ids: ["pc", "mac"] });

    __resetAgentViewForTests();
    view.hydrate(saved, () => false);
    view.setPeerOrderAccount(PEER_ORDER_ACCOUNT);
    expect(useAgentViewStore.getState().peerOrder).toEqual(saved.peerOrder);
    view.setPeerOrder(PEER_ORDER_ACCOUNT, ["pc", "mac"]);
    expect(await flushAgentViewPersistence()).toBe(true);
    expect(stored).toHaveLength(1);
  });

  it.each([
    ["sign-out", { status: "signed-out", server: SIGNED_IN.server }],
    ["switching accounts", { ...SIGNED_IN, user: { ...SIGNED_IN.user, id: "user-2" } }],
    ["switching servers", { ...SIGNED_IN, server: "https://other.example" }],
  ] as const)("clears persisted computer order on %s while the agent view is closed", async (_, next) => {
    const view = useAgentViewStore.getState();
    view.hydrate(
      {
        mode: "workspace",
        root: { kind: "leaf", id: P1, tabIds: [], activeTabId: null },
        activeLeafId: P1,
        peerOrder: { accountKey: PEER_ORDER_ACCOUNT, ids: ["pc", "mac"] },
      },
      () => true,
    );

    const initial = Promise.withResolvers<IpcResult<RemoteAccountState>>();
    accountReply = initial.promise;
    const stop = startAgentViewPeerOrderSync();
    try {
      expect(accountChanged).toBeDefined();
      accountChanged?.(next);
      initial.resolve(ipcOk(SIGNED_IN));
      await initial.promise;
      view.setPeerOrder(PEER_ORDER_ACCOUNT, ["mac", "pc"]);
      expect(useAgentViewStore.getState().peerOrder).toBeUndefined();
      expect(await flushAgentViewPersistence()).toBe(true);
      expect((stored[0] as { agentView: object }).agentView).not.toHaveProperty("peerOrder");
    } finally {
      stop();
    }
  });

  it("lists by state until the user picks the workspaces, and stores only a pick that is not that", async () => {
    const leaf = { kind: "leaf" as const, id: P1, tabIds: [], activeTabId: null };
    useAgentViewStore
      .getState()
      .hydrate({ mode: "agents", root: leaf, activeLeafId: P1 }, () => true);
    expect(useAgentViewStore.getState().grouping).toBe("status");

    useAgentViewStore.getState().setGrouping("status");
    await settle();
    expect(stored).toEqual([]);

    useAgentViewStore.getState().setGrouping("workspace");
    await settle();
    expect((stored[0] as { agentView: { grouping: unknown } }).agentView.grouping).toBe(
      "workspace",
    );

    useAgentViewStore.getState().setGrouping("status");
    await settle();
    expect(stored[1] as { agentView: object }).not.toHaveProperty("agentView.grouping");
  });

  it("restores the grouping stored, and lists by state for one it does not know", () => {
    const leaf = { kind: "leaf" as const, id: P1, tabIds: [], activeTabId: null };
    useAgentViewStore
      .getState()
      .hydrate({ mode: "agents", root: leaf, activeLeafId: P1, grouping: "workspace" }, () => true);
    expect(useAgentViewStore.getState().grouping).toBe("workspace");

    __resetAgentViewForTests();
    useAgentViewStore
      .getState()
      .hydrate({ mode: "agents", root: leaf, activeLeafId: P1, grouping: "branch" }, () => true);
    expect(useAgentViewStore.getState().grouping).toBe("status");
  });

  it("persists the most recently marked remote results and restores them by account", async () => {
    const view = useAgentViewStore.getState();
    view.hydrate(undefined, () => true);
    const key = (i: number) =>
      remoteSessionKey({ deviceId: "mac", workspaceId: "w", tabId: `t${i}` });
    const all = new Map(
      Array.from({ length: MAX_REMOTE_SEEN }, (_, i) => [key(i), { at: i }] as const),
    );
    view.updateRemoteSeen(PEER_ORDER_ACCOUNT, all);
    view.updateRemoteSeen(
      PEER_ORDER_ACCOUNT,
      new Map([
        [key(0), { at: 500 }],
        [key(500), { at: 501 }],
      ]),
    );
    await flushAgentViewPersistence();
    const snapshot = AgentViewSnapshotSchema.parse(
      (stored.at(-1) as { agentView: unknown }).agentView,
    );
    __resetAgentViewForTests();
    view.hydrate(snapshot, () => true);
    const seen = useAgentViewStore.getState().remoteSeen;
    expect(seen?.accountKey).toBe(PEER_ORDER_ACCOUNT);
    expect(seen?.entries.size).toBe(MAX_REMOTE_SEEN);
    expect(seen?.entries.has(key(1))).toBe(false);
    expect(seen?.entries.get(key(0))).toEqual({ at: 500 });
    expect(seen?.entries.get(key(500))).toEqual({ at: 501 });
  });

  it("restores the folded groups, and stores them as they change; a second fold opens one again", async () => {
    const leaf = { kind: "leaf" as const, id: P1, tabIds: [], activeTabId: null };
    useAgentViewStore
      .getState()
      .hydrate(
        { mode: "agents", root: leaf, activeLeafId: P1, folded: ["status:ended", "peer:d2"] },
        () => true,
      );
    expect([...useAgentViewStore.getState().folded]).toEqual(["status:ended", "peer:d2"]);

    useAgentViewStore.getState().toggleFolded("workspace:ws-a");
    useAgentViewStore.getState().toggleFolded("peer-ws:d2:ws-a");
    await settle();
    expect((stored[0] as { agentView: { folded: unknown } }).agentView.folded).toEqual([
      "status:ended",
      "peer:d2",
      "workspace:ws-a",
      "peer-ws:d2:ws-a",
    ]);

    useAgentViewStore.getState().toggleFolded("status:ended");
    useAgentViewStore.getState().toggleFolded("peer:d2");
    useAgentViewStore.getState().toggleFolded("workspace:ws-a");
    useAgentViewStore.getState().toggleFolded("peer-ws:d2:ws-a");
    await settle();
    expect(stored[1] as { agentView: object }).not.toHaveProperty("agentView.folded");
  });

  it("keeps valid saved folds and gives recent peer folds the remaining slots", async () => {
    const leaf = { kind: "leaf", id: P1, tabIds: [], activeTabId: null };
    const keys = Array.from({ length: 260 }, (_, i) =>
      i % 2 === 0 ? `peer:d${i}` : `peer-ws:d2:w${i}`,
    );
    const local = ["status:done", "workspace:local"];
    const snapshot = AgentViewSnapshotSchema.parse({
      mode: "agents",
      root: leaf,
      activeLeafId: P1,
      folded: [...local, ...keys, `peer:${"x".repeat(201)}`, 7],
    });
    expect(snapshot.folded).toEqual([...local, ...keys.slice(-254)]);

    const view = useAgentViewStore.getState();
    view.hydrate(snapshot, () => true);
    view.toggleFolded("peer-ws:d2:new");
    await flushAgentViewPersistence();
    const saved = AgentViewSnapshotSchema.parse(
      (stored.at(-1) as { agentView: unknown }).agentView,
    );
    expect(saved.folded).toEqual([...local, ...keys.slice(-253), "peer-ws:d2:new"]);
  });
});
