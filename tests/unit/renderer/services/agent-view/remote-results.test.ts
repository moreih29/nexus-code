import { describe, expect, jest, spyOn, test } from "bun:test";
import type {
  RemoteSession,
  RpcResult,
  SessionEvent,
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
