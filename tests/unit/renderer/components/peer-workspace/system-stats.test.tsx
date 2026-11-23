import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  askPeerSystemStats,
  PeerSystemStatsSegment,
} from "../../../../../src/renderer/components/peer-workspace/system-stats";
import { SystemStatsItem } from "../../../../../src/renderer/components/workbench/system-stats";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  POLL_MS,
  pollStats,
  type StatsAnswer,
} from "../../../../../src/renderer/services/system-stats/use-system-stats";
import type { PeerWorkspaceTarget } from "../../../../../src/renderer/state/stores/peer-workspace";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "desktop",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const stats = { cpu: 23.4, memUsed: 12 * 1024 ** 3, memTotal: 32 * 1024 ** 3 };

test("that computer is asked for its workspace's host; an older one that lacks the method, never again", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk(stats) as never)
    .mockResolvedValueOnce(ipcErr("unavailable", "the host cannot tell now") as never)
    .mockResolvedValueOnce(ipcErr("unsupported", "MethodNotFound") as never);
  try {
    expect(await askPeerSystemStats(target)).toEqual(stats);
    expect(await askPeerSystemStats(target)).toBeNull();
    expect(await askPeerSystemStats(target)).toBe("never");
    expect(call.mock.calls[0].slice(0, 3)).toEqual([
      "remote",
      "peerSystemStats",
      { deviceId: "desktop", workspaceId: "repo" },
    ]);
  } finally {
    call.mockRestore();
  }
});

test("asked again a while after each answer, until stopped or told never", async () => {
  const answers: StatsAnswer[] = [stats, null, "never"];
  const told: unknown[] = [];
  const waits: { next: () => void; ms: number }[] = [];
  const wait = (next: () => void, ms: number) => {
    waits.push({ next, ms });
    return waits.length as unknown as ReturnType<typeof setTimeout>;
  };
  pollStats(
    async () => answers.shift() ?? null,
    (value) => told.push(value),
    wait,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(told).toEqual([stats]);
  expect(waits.map(({ ms }) => ms)).toEqual([POLL_MS]);
  waits[0].next();
  await Promise.resolve();
  await Promise.resolve();
  expect(told).toEqual([stats, null]);
  waits[1].next();
  await Promise.resolve();
  await Promise.resolve();
  // "never": nothing to show, and no more asking.
  expect(told).toEqual([stats, null, null]);
  expect(waits).toHaveLength(2);

  // Stopped while an answer is on its way, the ask is aborted and nothing told.
  const late: unknown[] = [];
  let signal: AbortSignal | undefined;
  const stop = pollStats(
    async (given) => {
      signal = given;
      return stats;
    },
    (value) => late.push(value),
    wait,
  );
  expect(signal?.aborted).toBe(false);
  stop();
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(late).toEqual([]);
});

test("the local status bar's item, with that computer first in its tooltip", () => {
  const html = renderToStaticMarkup(<SystemStatsItem stats={stats} host="Desktop" />);
  expect(html).toContain("23%");
  expect(html).toContain("12.0/32 GB");
  expect(html).toContain('title="Desktop');
  expect(html).toContain("lucide-cpu");
});

test("nothing, and nothing asked, from a computer that does not serve it", () => {
  const call = spyOn(ipc, "ipcCallResult");
  try {
    const old: RoomPeer = { id: "desktop", name: "Desktop", online: true, serves: ["files"] };
    expect(renderToStaticMarkup(<PeerSystemStatsSegment target={target} peer={old} active />)).toBe(
      "",
    );
    expect(call).not.toHaveBeenCalled();
  } finally {
    call.mockRestore();
  }
});
