import { expect, mock, spyOn, test } from "bun:test";
import { profileUsageView } from "../../../../../src/renderer/components/agent-view/remote-usage";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { POLL_MS } from "../../../../../src/renderer/services/chat/plan-usage";
import {
  type PeerProfileUsage,
  watchPeerProfileUsage,
} from "../../../../../src/renderer/services/remote/profile-usage";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const profile: PeerProfileUsage = {
  id: "qa-profile",
  name: "qa-profile",
  agent: "claude",
  status: "fresh",
  fetchedAt: 90,
  limits: [],
};

test("profile usage filters expired or unsupported windows and reports the oldest stale meter", () => {
  const meter = { kind: "weekly", percent: 60, fetchedAt: 80, stale: true };
  const limits = [
    { ...meter, kind: "future", fetchedAt: 10 },
    { ...meter, kind: "window", windowMins: 0, fetchedAt: 15 },
    { ...meter, kind: "session", resetsAt: 100, fetchedAt: 20 },
    meter,
    { ...meter, kind: "weekly_scoped", scope: "qa-scope", fetchedAt: 70 },
  ];
  expect(profileUsageView({ ...profile, limits }, 100)).toEqual({
    note: "stale",
    checkedAt: 70,
    meters: limits.slice(3),
  });
  expect(profileUsageView({ ...profile, status: "not-subscription", limits }, 100)).toEqual({
    note: "notSubscription",
    meters: [],
  });
  expect(profileUsageView(profile, 100)).toEqual({ note: "unavailable", meters: [] });
});

test.each([
  true,
  false,
])("forced refresh owns the result and restarts polling when it succeeds=%s", async (success) => {
  const initial =
    Promise.withResolvers<ReturnType<typeof ipcOk<{ profiles: PeerProfileUsage[] }>>>();
  const refreshed = Promise.withResolvers<ipc.IpcResult<{ profiles: PeerProfileUsage[] }>>();
  const polled = ipcOk({ profiles: [profile] });
  const call = spyOn(ipc, "ipcCallResult")
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(refreshed.promise)
    .mockResolvedValue(polled);
  const realSetTimeout = globalThis.setTimeout;
  let poll: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === POLL_MS && typeof callback === "function") {
      poll = () => callback(...args);
      return realSetTimeout(() => {}, delay);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  const onResult = mock();
  const onRefresh = mock();
  const watch = watchPeerProfileUsage("qa-peer", onResult, onRefresh);
  try {
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual([
      "remote",
      "peerProfilesUsage",
      { deviceId: "qa-peer" },
    ]);
    const refresh = watch.refresh();
    await watch.refresh();
    expect(call.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(call.mock.calls[1]?.[2]).toEqual({ deviceId: "qa-peer", refresh: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(onRefresh.mock.calls).toEqual([[true]]);
    initial.resolve(ipcOk({ profiles: [] }));
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(poll).toBeUndefined();
    refreshed.resolve(success ? polled : ipcErr("unavailable", "qa-failure"));
    await refresh;
    expect(onResult.mock.calls).toEqual([[success ? [profile] : null, true]]);
    expect(onRefresh.mock.calls).toEqual([[true], [false]]);
    expect(poll).toBeDefined();
    poll?.();
    expect(call.mock.calls[2]?.[2]).toEqual({ deviceId: "qa-peer" });
    watch.stop();
    expect(call.mock.calls[2]?.[3]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledTimes(1);
  } finally {
    watch.stop();
    timer.mockRestore();
    call.mockRestore();
  }
});
