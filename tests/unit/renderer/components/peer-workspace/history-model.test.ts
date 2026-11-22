import { expect, spyOn, test } from "bun:test";
import {
  createPeerHistory,
  type PeerHistoryCommit,
} from "../../../../../src/renderer/components/peer-workspace/history-model";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const peer = { deviceId: "desk", workspaceId: "project" };
const commit = (n: number): PeerHistoryCommit => ({
  hash: n.toString(16).padStart(40, "0"),
  subject: String(n),
  author: "Ada",
  at: 1,
});
const page = (first: number, count: number) =>
  ipcOk({ commits: Array.from({ length: count }, (_, i) => commit(first + i)) });

test("history asks for 50 rows at a time and advances by the rows received", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(page(0, 50))
    .mockResolvedValueOnce(page(49, 25))
    .mockResolvedValueOnce(page(0, 0));
  const history = createPeerHistory(peer);
  try {
    await history.resume(0);
    expect(history.getSnapshot().commits).toHaveLength(50);
    history.pause();
    await history.resume(0);
    expect(call).toHaveBeenCalledTimes(1);
    await history.more();
    expect(history.getSnapshot().commits).toHaveLength(74);
    // A short page may be a frame cut, and a duplicate still consumes an offset.
    expect(history.getSnapshot().nextSkip).toBe(75);
    await history.more();
    expect(history.getSnapshot().nextSkip).toBeNull();
    await history.more();
    expect(call.mock.calls.map(([channel, method, params]) => [channel, method, params])).toEqual(
      [0, 50, 75].map((skip) => ["remote", "peerGitLog", { ...peer, limit: 50, skip }]),
    );
  } finally {
    history.pause();
    call.mockRestore();
  }
});

test("refresh supersedes an in-flight page and starts at zero", async () => {
  const late = Promise.withResolvers<ReturnType<typeof page>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(page(0, 1))
    .mockImplementationOnce(() => late.promise)
    .mockResolvedValueOnce(page(100, 2));
  const history = createPeerHistory(peer);
  try {
    await history.resume(0);
    const more = history.more();
    expect(history.getSnapshot().pending).toBe(true);
    await history.refresh();
    expect(call.mock.calls[1][3]?.signal?.aborted).toBe(true);
    expect(call.mock.calls[2][2]).toEqual({ ...peer, limit: 50, skip: 0 });
    late.resolve(page(1, 1));
    await more;
    expect(history.getSnapshot()).toMatchObject({
      commits: [commit(100), commit(101)],
      pending: false,
      nextSkip: 2,
    });
  } finally {
    history.pause();
    call.mockRestore();
  }
});

test("switching peers releases the old history request and ignores its late reply", async () => {
  const late = Promise.withResolvers<ReturnType<typeof page>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => late.promise)
    .mockResolvedValueOnce(page(30, 1));
  const old = createPeerHistory(peer);
  const nextPeer = { ...peer, deviceId: "other" };
  const next = createPeerHistory(nextPeer);
  try {
    const pending = old.resume(0);
    old.pause();
    await next.resume(0);
    late.resolve(page(0, 50));
    await pending;
    expect(call.mock.calls[0][3]?.signal?.aborted).toBe(true);
    expect(call.mock.calls[1][2]).toMatchObject(nextPeer);
    expect(old.getSnapshot()).toEqual({
      commits: null,
      pending: false,
      nextSkip: null,
      error: undefined,
    });
    expect(next.getSnapshot().commits).toEqual([commit(30)]);
    await old.more();
    await old.refresh();
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    old.pause();
    next.pause();
    call.mockRestore();
  }
});

test("history keeps the last page while offline and retries an unsupported read on rejoin", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcErr("unsupported", "method not found"))
    .mockResolvedValueOnce(page(0, 1));
  const history = createPeerHistory(peer);
  try {
    await history.resume(0);
    expect(history.getSnapshot().error).toBe("unsupported");
    history.pause();
    await history.resume(0);
    expect(call).toHaveBeenCalledTimes(1);
    history.pause();
    await history.resume(1);
    expect(history.getSnapshot().commits).toEqual([commit(0)]);
    history.pause();
    expect(history.getSnapshot().commits).toEqual([commit(0)]);
  } finally {
    history.pause();
    call.mockRestore();
  }
});

test("when HEAD advances between pages, overlap is deduplicated and refresh picks up the new HEAD", async () => {
  const base = Array.from({ length: 54 }, (_, i) => commit(54 - i));
  const advanced = [commit(56), commit(55), ...base];
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk({ commits: base.slice(0, 50) }))
    .mockResolvedValueOnce(ipcOk({ commits: advanced.slice(50, 100) }))
    .mockResolvedValueOnce(ipcOk({ commits: advanced.slice(56) }))
    .mockResolvedValueOnce(ipcOk({ commits: advanced.slice(0, 50) }));
  const history = createPeerHistory(peer);
  try {
    await history.resume(0);
    await history.more();
    expect(history.getSnapshot()).toMatchObject({ commits: base, nextSkip: 56 });
    await history.more();
    expect(history.getSnapshot()).toMatchObject({ commits: base, nextSkip: null });
    await history.refresh();
    expect(history.getSnapshot()).toMatchObject({ commits: advanced.slice(0, 50), nextSkip: 50 });
    expect(call.mock.calls.map(([, , args]) => args)).toEqual(
      [0, 50, 56, 0].map((skip) => ({ ...peer, limit: 50, skip })),
    );
  } finally {
    history.pause();
    call.mockRestore();
  }
});
