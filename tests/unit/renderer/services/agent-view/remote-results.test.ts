import { describe, expect, jest, spyOn, test } from "bun:test";
import type {
  RemoteSession,
  RpcResult,
  SessionEvent,
} from "../../../../../packages/remote-protocol/src/rpc";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  RemoteResults,
  watchResults,
} from "../../../../../src/renderer/services/agent-view/remote-results";
import * as room from "../../../../../src/renderer/services/remote/room";
import { ipcOk } from "../../../../../src/shared/ipc/result";

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
      state: "new-result",
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

  test("keeps the failure label after the new result is read", () => {
    const results = new RemoteResults();
    const failed: RemoteSession = { ...chat, failed: true, since: 10 };
    const row = results.session("mac", failed);
    expect(row.state).toBe("new-result");
    results.markSeen([{ deviceId: "mac", session: row }]);
    expect(results.session("mac", failed)).toBe(failed);
    expect(results.session("mac", chat)).toBe(chat);
  });
});
