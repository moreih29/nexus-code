import { describe, expect, jest, spyOn, test } from "bun:test";
import {
  MAX_MARK_SEEN,
  type RemoteSession,
  type RpcResult,
  type SessionEvent,
} from "../../../../../packages/remote-protocol/src/rpc";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { remoteSessionKey } from "../../../../../src/renderer/services/agent-view/layout";
import {
  markVisibleRemoteResult,
  RemoteResults,
  watchResults,
} from "../../../../../src/renderer/services/agent-view/remote-results";
import * as room from "../../../../../src/renderer/services/remote/room";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const chat: RemoteSession = {
  kind: "codex",
  workspaceId: "w1",
  tabId: "t1",
  title: "Review",
  state: "idle",
};
const complete: SessionEvent = {
  ...chat,
  seq: 1,
  at: 10,
  from: "running",
  to: "completed",
};

const unread: RemoteSession = { ...chat, state: "new-result", since: 10 };

describe("host read receipts", () => {
  test.each([
    ["a listed result", unread, "new-result"],
    ["a result without its time", { ...unread, since: undefined }, "idle"],
    ["a failed turn", { ...unread, failed: true }, "idle"],
    ["a usage limit wait", { ...unread, limitWait: { at: 10 } }, "idle"],
    [
      "a pending permission",
      { ...unread, waiting: { kind: "permission", text: "May I?" } },
      "idle",
    ],
    ["an idle chat with completion history", chat, "idle"],
  ] as const)("uses the listing for %s", (_label, row, state) => {
    const results = new RemoteResults();
    results.applyPage("mac", { events: [complete], cursor: 1, more: false });
    expect(results.session("mac", row, true, true)).toMatchObject({ state });
  });

  test("batches visible successes per capable host and hides through the next listing after an ack", async () => {
    const results = new RemoteResults();
    const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () => ipcOk({ marked: 2 }));
    let take: ((listing: room.PeerSessions) => void) | undefined;
    const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, listener) => {
      take = listener;
      return () => {};
    });
    const list = (...sessions: RemoteSession[]) =>
      take?.({ status: "ready", list: { sessions, workspaces: [] } });
    const stop = results.watchReceipts("mac", 0);
    const second = { ...unread, tabId: "second", since: 11 };
    const newer = { ...unread, since: 12 };
    try {
      list(unread, second);
      results.markSeen([
        { deviceId: "mac", session: unread, hostReceipts: true },
        { deviceId: "mac", session: second, hostReceipts: true },
        { deviceId: "mac", session: { ...unread, failed: true }, hostReceipts: true },
        {
          deviceId: "mac",
          session: { ...unread, tabId: "limited", limitWait: { at: 10 } },
          hostReceipts: true,
        },
        {
          deviceId: "mac",
          session: { ...unread, tabId: "asking", waiting: { kind: "permission", text: "May I?" } },
          hostReceipts: true,
        },
        { deviceId: "older", session: unread },
      ]);
      expect(call.mock.calls).toEqual([
        [
          "remote",
          "peerSessionsMarkSeen",
          {
            deviceId: "mac",
            seen: [
              { workspaceId: "w1", tabId: "t1", upTo: 10 },
              { workspaceId: "w1", tabId: "second", upTo: 11 },
            ],
          },
        ],
      ]);
      list(unread, second);
      expect(results.session("mac", unread, true, true).state).toBe("idle");
      expect(results.session("mac", newer, true, true)).toBe(newer);
      expect(results.session("older", unread).state).toBe("idle");
      await Promise.resolve();
      expect(results.session("mac", unread, true, true).state).toBe("idle");
      list(unread);
      expect(results.session("mac", unread, true, true)).toBe(unread);
      list(chat);
      expect(results.session("mac", chat, true, true)).toBe(chat);
    } finally {
      stop();
      observe.mockRestore();
      call.mockRestore();
    }
  });

  test("migrates matching saved times and retries on a fresh connection after failure", async () => {
    const { remoteSeen, peerOrderAccount } = useAgentViewStore.getState();
    const accountKey = "receipt-migration";
    const candidates = [
      { tabId: "t1", saved: { at: 10 }, send: true },
      { tabId: "after", saved: { at: 15, listedAt: 9 }, send: true },
      { tabId: "before", saved: { at: 8 }, send: false },
      { tabId: "undated", saved: { at: 0, undated: true }, send: false },
      { tabId: "listed", saved: { at: 0, listedAt: 10 }, send: false },
    ] as const;
    const entries = new Map(
      candidates.map(({ tabId, saved }) => [
        remoteSessionKey({ deviceId: "mac", ...chat, tabId }),
        saved,
      ]),
    );
    useAgentViewStore.setState({
      peerOrderAccount: accountKey,
      remoteSeen: { accountKey, entries },
    });
    const listed = candidates.map(({ tabId }) => ({ ...unread, tabId }));
    let publish = () => {};
    const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, take) => {
      publish = () => take({ status: "ready", list: { sessions: listed, workspaces: [] } });
      publish();
      return () => {};
    });
    let online = false;
    const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () =>
      online ? ipcOk({ marked: 2 }) : ipcErr("unavailable", "disconnected"),
    );
    const results = new RemoteResults(accountKey);
    let stop = () => {};
    try {
      stop = results.watchReceipts("mac", 0);
      await Promise.resolve();
      publish();
      expect(call).toHaveBeenCalledTimes(1);
      expect(useAgentViewStore.getState().remoteSeen?.entries.size).toBe(2);
      expect(results.session("mac", unread, true, true).state).toBe("idle");
      stop();
      online = true;
      stop = results.watchReceipts("mac", 1);
      await Promise.resolve();
      const seen = candidates
        .filter(({ send }) => send)
        .map(({ tabId }) => ({
          workspaceId: "w1",
          tabId,
          upTo: 10,
        }));
      expect(call.mock.calls).toEqual(
        Array(2).fill(["remote", "peerSessionsMarkSeen", { deviceId: "mac", seen }]),
      );
      expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
    } finally {
      stop();
      observe.mockRestore();
      call.mockRestore();
      useAgentViewStore.setState({ remoteSeen, peerOrderAccount });
    }
  });

  test.each([
    true,
    false,
  ])("retries within a live watch with bounded delays (recovers=%s)", async (recovers) => {
    const results = new RemoteResults();
    const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, take) => {
      take({ status: "ready", list: { sessions: [unread], workspaces: [] } });
      return () => {};
    });
    let healthy = false;
    const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () =>
      healthy ? ipcOk({ marked: 1 }) : ipcErr("unavailable", "the host did not answer"),
    );
    jest.useFakeTimers();
    const stop = watchResults(results, "mac", 0, true);
    try {
      jest.advanceTimersByTime(0);
      // The receipt-capable watch reads listings without asking for legacy events.
      expect(call).not.toHaveBeenCalled();
      results.markSeen([{ deviceId: "mac", session: unread, hostReceipts: true }]);
      await Promise.resolve();
      expect(call).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(999);
      expect(call).toHaveBeenCalledTimes(1);
      healthy = recovers;
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(call).toHaveBeenCalledTimes(2);
      for (const delay of [2_000, 4_000, 60_000]) {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
      }
      expect(call).toHaveBeenCalledTimes(recovers ? 2 : 4);
      expect(call.mock.calls.every(([, method]) => method === "peerSessionsMarkSeen")).toBe(true);
    } finally {
      stop();
      jest.useRealTimers();
      observe.mockRestore();
      call.mockRestore();
    }
  });

  test("splits a selection of over 500 results into bounded receipts", async () => {
    const previous = useAgentViewStore.getState();
    const accountKey = "large-read-batch";
    useAgentViewStore.setState({ peerOrderAccount: accountKey, remoteSeen: undefined });
    const calls: string[][] = [];
    const call = spyOn(ipc, "ipcCallResult").mockImplementation(async (_, __, params) => {
      const seen = (params as { seen: { tabId: string }[] }).seen;
      calls.push(seen.map(({ tabId }) => tabId));
      return ipcOk({ marked: seen.length });
    });
    const tabIds = Array.from({ length: MAX_MARK_SEEN + 2 }, (_, i) => `tab-${i}`);
    try {
      new RemoteResults(accountKey).markSeen(
        tabIds.map((tabId) => ({
          deviceId: "mac",
          session: { ...unread, tabId },
          hostReceipts: true,
        })),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(calls.map((batch) => batch.length)).toEqual([MAX_MARK_SEEN, 2]);
      expect(calls.flat()).toEqual(tabIds);
      expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
    } finally {
      call.mockRestore();
      useAgentViewStore.setState({
        remoteSeen: previous.remoteSeen,
        peerOrderAccount: previous.peerOrderAccount,
      });
    }
  });

  test("retries a migrated receipt from a cached listing during the same watch", async () => {
    const previous = useAgentViewStore.getState();
    const accountKey = "cached-listing-retry";
    const key = remoteSessionKey({ deviceId: "mac", ...unread });
    useAgentViewStore.setState({
      peerOrderAccount: accountKey,
      remoteSeen: { accountKey, entries: new Map([[key, { at: 10 }]]) },
    });
    const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, take) => {
      take({ status: "ready", list: { sessions: [unread], workspaces: [] } });
      return () => {};
    });
    const call = spyOn(ipc, "ipcCallResult")
      .mockImplementationOnce(async () => ipcErr("unavailable", "temporary failure"))
      .mockImplementationOnce(async () => ipcOk({ marked: 1 }));
    jest.useFakeTimers();
    const stop = new RemoteResults(accountKey).watchReceipts("mac", 0);
    try {
      await Promise.resolve();
      expect(call).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(call).toHaveBeenCalledTimes(2);
      expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
    } finally {
      stop();
      jest.useRealTimers();
      observe.mockRestore();
      call.mockRestore();
      useAgentViewStore.setState({
        remoteSeen: previous.remoteSeen,
        peerOrderAccount: previous.peerOrderAccount,
      });
    }
  });

  test("reconciles saved receipts once their workspace's listing is complete", async () => {
    const previous = useAgentViewStore.getState();
    const accountKey = "partial-receipts";
    const key = remoteSessionKey({ deviceId: "mac", ...unread });
    useAgentViewStore.setState({
      peerOrderAccount: accountKey,
      remoteSeen: { accountKey, entries: new Map([[key, { at: 12 }]]) },
    });
    let take: ((listing: room.PeerSessions) => void) | undefined;
    const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, listener) => {
      take = listener;
      return () => {};
    });
    const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () => ipcOk({ marked: 1 }));
    const stop = new RemoteResults(accountKey).watchReceipts("mac", 0);
    const list = (sessions: RemoteSession[], incompleteWorkspaces?: string[]) =>
      take?.({ status: "ready", list: { sessions, workspaces: [], incompleteWorkspaces } });
    try {
      list([], ["w1"]);
      list([unread], ["w1"]);
      expect(useAgentViewStore.getState().remoteSeen?.entries.get(key)).toEqual({ at: 12 });
      expect(call).not.toHaveBeenCalled();
      list([unread]);
      await Promise.resolve();
      expect(call.mock.calls).toEqual([
        [
          "remote",
          "peerSessionsMarkSeen",
          {
            deviceId: "mac",
            seen: [{ workspaceId: "w1", tabId: "t1", upTo: 10 }],
          },
        ],
      ]);
      expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
    } finally {
      stop();
      observe.mockRestore();
      call.mockRestore();
      useAgentViewStore.setState({
        remoteSeen: previous.remoteSeen,
        peerOrderAccount: previous.peerOrderAccount,
      });
    }
  });

  test("a focused visible pane can queue a newer result while the previous receipt is in flight", async () => {
    const { peerOrderAccount, remoteSeen } = useAgentViewStore.getState();
    const accountKey = "receipt-pane";
    const results = new RemoteResults(accountKey);
    useAgentViewStore.setState({ peerOrderAccount: accountKey, remoteSeen: undefined });
    const first = Promise.withResolvers<ReturnType<typeof ipcOk<{ marked: number }>>>();
    const second = Promise.withResolvers<ReturnType<typeof ipcOk<{ marked: number }>>>();
    const call = spyOn(ipc, "ipcCallResult")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const newer = { ...unread, since: 20 };
    try {
      markVisibleRemoteResult(accountKey, "mac", unread, false, true, true);
      markVisibleRemoteResult(accountKey, "mac", unread, true, false, true);
      expect(call).not.toHaveBeenCalled();
      markVisibleRemoteResult(accountKey, "mac", unread, true, true, true);
      expect(results.session("mac", newer, true, true)).toBe(newer);
      markVisibleRemoteResult(accountKey, "mac", newer, true, true, true);
      expect(call).toHaveBeenCalledTimes(1);
      first.resolve(ipcOk({ marked: 0 }));
      await Promise.resolve();
      expect(call.mock.calls[1]?.[2]).toEqual({
        deviceId: "mac",
        seen: [{ workspaceId: "w1", tabId: "t1", upTo: 20 }],
      });
      expect(useAgentViewStore.getState().remoteSeen?.entries.values().next().value).toEqual({
        at: 20,
      });
      second.resolve(ipcOk({ marked: 1 }));
      await Promise.resolve();
      expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
    } finally {
      call.mockRestore();
      useAgentViewStore.setState({ peerOrderAccount, remoteSeen });
    }
  });
});

test("the watch resumes at the last cursor and replaces history after a host restart", async () => {
  const results = new RemoteResults();
  let page: RpcResult<"events.read"> = {
    events: [{ ...complete, seq: 15 }],
    cursor: 15,
    more: false,
  };
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () => ipcOk(page));
  const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, take) => {
    take({ status: "ready", list: { sessions: [chat], workspaces: [] } });
    return () => {};
  });
  jest.useFakeTimers();
  let stop = () => {};
  const flush = async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  };
  try {
    stop = watchResults(results, "mac", 0);
    await flush();
    expect(results.session("mac", chat).state).toBe("new-result");
    stop();
    page = { events: [], cursor: 15, more: false };
    stop = watchResults(results, "mac", 1);
    await flush();
    expect(results.session("mac", chat).state).toBe("new-result");
    stop();
    // The server returns its first page for a cursor from before its restart.
    page = { events: [{ ...complete, tabId: "other", seq: 1 }], cursor: 2, more: true };
    call.mockImplementation(async (_, __, params) =>
      ipcOk(
        (params as { since: number }).since === 1 ? { events: [], cursor: 2, more: false } : page,
      ),
    );
    stop = watchResults(results, "mac", 2);
    await flush();
    expect(results.session("mac", chat)).toBe(chat);
    expect(call.mock.calls.map(([, , args]) => (args as { since: number }).since)).toEqual([
      0, 15, 15, 1,
    ]);
    expect(results.cursor("mac")).toBe(2);
  } finally {
    stop();
    jest.useRealTimers();
    call.mockRestore();
    observe.mockRestore();
  }
});

test("a working chat is provisionally done and its outcome is read without waiting", async () => {
  const results = new RemoteResults();
  const running = { ...chat, state: "running" as const };
  const quiet = { ...chat, since: 30 };
  let take: ((listing: room.PeerSessions) => void) | undefined;
  const list = (session: RemoteSession) =>
    take?.({ status: "ready", list: { sessions: [session], workspaces: [] } });
  const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, listener) => {
    take = listener;
    return () => {};
  });
  let page: RpcResult<"events.read"> = { events: [], cursor: 0, more: false };
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async () => ipcOk(page));
  jest.useFakeTimers();
  const stop = watchResults(results, "mac", 0);
  const flush = async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  };
  try {
    list(running);
    await flush();
    list(quiet);
    expect(results.session("mac", quiet).state).toBe("new-result");
    expect(call).toHaveBeenCalledTimes(1);
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    expect(results.session("mac", quiet)).toBe(quiet);

    list(running);
    list(quiet);
    expect(results.session("mac", quiet).state).toBe("new-result");
    page = { events: [complete], cursor: 1, more: false };
    await flush();
    expect(call).toHaveBeenCalledTimes(3);
    expect(results.session("mac", quiet)).toMatchObject({ state: "new-result", since: 10 });
    list(running);
    list(quiet);
    page = { events: [], cursor: 1, more: false };
    await flush();
    expect(results.session("mac", quiet)).toBe(quiet);
  } finally {
    stop();
    jest.useRealTimers();
    call.mockRestore();
    observe.mockRestore();
  }
});

test("an unsupported event log is left alone and its provisional result rolls back", async () => {
  const results = new RemoteResults();
  let take: ((listing: room.PeerSessions) => void) | undefined;
  const list = (session: RemoteSession) =>
    take?.({ status: "ready", list: { sessions: [session], workspaces: [] } });
  const observe = spyOn(room, "observePeerSessions").mockImplementation((_, __, listener) => {
    take = listener;
    return () => {};
  });
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcErr("unsupported", "No event log"));
  jest.useFakeTimers();
  const stop = watchResults(results, "mac", 0);
  try {
    list({ ...chat, state: "running" });
    list(chat);
    expect(results.session("mac", chat).state).toBe("new-result");
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    expect(results.session("mac", chat)).toBe(chat);
    list({ ...chat, state: "running" });
    list(chat);
    jest.advanceTimersByTime(10_000);
    expect(call).toHaveBeenCalledTimes(1);
    expect(results.session("mac", chat)).toBe(chat);
  } finally {
    stop();
    jest.useRealTimers();
    call.mockRestore();
    observe.mockRestore();
  }
});

describe("remote results", () => {
  test("finds chat outcomes in the event log and marks only the listed result locally", () => {
    const results = new RemoteResults();
    for (const deviceId of ["mac", "pc"]) {
      results.applyPage(deviceId, { events: [complete], cursor: 1, more: false });
    }
    const row = results.session("mac", chat);
    expect(row).toMatchObject({ state: "new-result", since: 10 });
    results.markSeen([{ deviceId: "mac", session: row }]);
    expect(results.session("mac", chat)).toBe(chat);
    expect(results.session("pc", chat).state).toBe("new-result");

    results.applyPage("mac", {
      events: [{ ...complete, seq: 2, at: 20, to: "error" }],
      cursor: 2,
      more: false,
    });
    expect(results.session("mac", chat)).toMatchObject({
      state: "idle",
      since: 20,
      failed: true,
    });
    const running = { ...chat, state: "running" as const };
    expect(results.session("mac", running)).toBe(running);
    results.applyPage("mac", {
      events: [{ ...complete, seq: 3, at: 25, from: "error", to: "idle" }],
      cursor: 3,
      more: false,
    });
    expect(results.session("mac", chat).failed).toBe(true);
    results.observe("mac", [running], 26);
    expect(results.session("mac", chat)).toBe(chat);
  });

  test("keeps a live result read until a different turn finishes, even without timestamps", () => {
    const results = new RemoteResults();
    const terminal: RemoteSession = {
      ...chat,
      kind: "terminal",
      agent: "claude",
      state: "new-result",
    };
    results.observe("mac", [terminal], 10);
    results.markSeen([{ deviceId: "mac", session: results.session("mac", terminal) }]);
    results.observe("mac", [terminal], 15);
    expect(results.session("mac", terminal).state).toBe("idle");
    results.observe("mac", [{ ...terminal, state: "running" }], 20);
    results.observe("mac", [terminal], 25);
    expect(results.session("mac", terminal)).toMatchObject({ state: "new-result", since: 25 });
  });

  test("keeps failures outside the unread results, including legacy terminal errors", () => {
    const results = new RemoteResults();
    const failed: RemoteSession = { ...chat, failed: true, since: 10 };
    const row = results.session("mac", failed);
    expect(row).toBe(failed);
    results.markSeen([{ deviceId: "mac", session: { ...row, state: "new-result" } }]);
    expect(results.session("mac", failed)).toBe(failed);
    expect(results.session("mac", chat)).toBe(chat);
    const terminal: RemoteSession = { ...chat, kind: "terminal" };
    const error = {
      ...complete,
      kind: "terminal" as const,
      to: "error",
      message: "Failed in hook",
    };
    results.applyPage("pc", { events: [error], cursor: 1, more: false });
    expect(results.session("pc", terminal)).toMatchObject({ failed: true, last: "Failed in hook" });
    expect(results.session("pc", terminal, true)).toBe(terminal);
    const success: RemoteSession = { ...terminal, state: "new-result", since: 20 };
    expect(results.session("pc", success)).toBe(success);
    const working: RemoteSession = { ...terminal, state: "running" };
    results.observe("pc", [working], 21);
    expect(results.session("pc", terminal)).toBe(terminal);
  });
});

test("pausing the sidebar stops scheduled reads and resuming reads before any listing", async () => {
  const results = new RemoteResults();
  const observed = spyOn(room, "observePeerSessions").mockReturnValue(() => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
    ipcOk({ events: [], cursor: 12, more: false }),
  );
  jest.useFakeTimers();
  let stop = watchResults(results, "mac", 0);
  const flush = async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  };
  try {
    stop();
    jest.advanceTimersByTime(10_000);
    expect(call).not.toHaveBeenCalled();
    stop = watchResults(results, "mac", 0);
    await flush();
    expect(call).toHaveBeenLastCalledWith("remote", "peerSessionEvents", {
      deviceId: "mac",
      since: 0,
      limit: 200,
    });
    stop();
    stop = watchResults(results, "mac", 0);
    await flush();
    expect(call).toHaveBeenLastCalledWith("remote", "peerSessionEvents", {
      deviceId: "mac",
      since: 12,
      limit: 200,
    });
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    call.mockRestore();
    observed.mockRestore();
    jest.useRealTimers();
  }
});

test("a visible focused pane marks a result and the next turn can be unread again", () => {
  const view = useAgentViewStore.getState();
  const accountKey = "visible-account";
  const results = new RemoteResults(accountKey);
  const quiet = { ...chat, since: 3 };
  useAgentViewStore.setState({ remoteSeen: undefined, peerOrderAccount: accountKey });
  try {
    results.applyPage("mac", { events: [complete], cursor: 1, more: false });
    markVisibleRemoteResult(accountKey, "mac", quiet, false, true);
    markVisibleRemoteResult(accountKey, "mac", quiet, true, false);
    expect(results.session("mac", quiet).state).toBe("new-result");
    markVisibleRemoteResult(accountKey, "mac", quiet, true, true);
    expect(results.session("mac", quiet)).toBe(quiet);
    const anotherAccount = new RemoteResults("another-account");
    anotherAccount.applyPage("mac", { events: [complete], cursor: 1, more: false });
    expect(anotherAccount.session("mac", quiet).state).toBe("new-result");

    results.observe("mac", [{ ...chat, state: "running" }], 20);
    results.applyPage("mac", { events: [{ ...complete, seq: 2, at: 30 }], cursor: 2, more: false });
    expect(results.session("mac", quiet)).toMatchObject({ state: "new-result", since: 30 });
  } finally {
    useAgentViewStore.setState({
      remoteSeen: view.remoteSeen,
      peerOrderAccount: view.peerOrderAccount,
    });
  }
});

test("a saved undated terminal result stays read until another turn or close", () => {
  const view = useAgentViewStore.getState();
  const accountKey = "terminal-account";
  const row: RemoteSession = { ...chat, kind: "terminal", state: "new-result" };
  const key = remoteSessionKey({ deviceId: "mac", ...row });
  useAgentViewStore.setState({ remoteSeen: undefined, peerOrderAccount: accountKey });
  try {
    markVisibleRemoteResult(accountKey, "mac", row, true, true);
    const reopened = new RemoteResults(accountKey);
    reopened.observe("mac", [row], 10);
    expect(reopened.session("mac", row).state).toBe("idle");
    reopened.observe("mac", [], 20);
    expect(useAgentViewStore.getState().remoteSeen?.entries.has(key)).toBeFalsy();
    reopened.observe("mac", [row], 30);
    expect(reopened.session("mac", row).state).toBe("new-result");
    reopened.markSeen([{ deviceId: "mac", session: reopened.session("mac", row) }]);
    reopened.applyPage("mac", {
      events: [{ ...complete, kind: "terminal", to: "closed" }],
      cursor: 1,
      more: false,
    });
    expect(useAgentViewStore.getState().remoteSeen?.entries.has(key)).toBeFalsy();
  } finally {
    useAgentViewStore.setState({
      remoteSeen: view.remoteSeen,
      peerOrderAccount: view.peerOrderAccount,
    });
  }
});

test("a late running snapshot preserves the completed event from the same turn", () => {
  const results = new RemoteResults();
  results.applyPage("mac", { events: [complete], cursor: 1, more: false });
  const running = { ...chat, state: "running" as const, since: 5 };
  const quiet = { ...chat, since: 30 };
  results.observe("mac", [running], 30);
  expect(results.session("mac", running)).toBe(running);
  results.observe("mac", [quiet], 31);
  results.settleAfterRead("mac")();
  expect(results.session("mac", quiet)).toMatchObject({ state: "new-result", since: 10 });

  results.observe("mac", [{ ...running, since: 32 }], 32);
  results.observe("mac", [quiet], 33);
  results.settleAfterRead("mac")();
  expect(results.session("mac", quiet)).toBe(quiet);
});
