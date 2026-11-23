import type { RoomPeer } from "../../../shared/remote/room";
import { ipcCallResult } from "../../ipc/client";
import { peerServes } from "../../services/remote/room";
import { type StatsAnswer, usePolledStats } from "../../services/system-stats/use-system-stats";
import { type PeerWorkspaceTarget, peerTargetId } from "../../state/stores/peer-workspace";
import { SystemStatsItem } from "../workbench/system-stats";

export async function askPeerSystemStats(
  target: PeerWorkspaceTarget,
  signal?: AbortSignal,
): Promise<StatsAnswer> {
  const result = await ipcCallResult(
    "remote",
    "peerSystemStats",
    { deviceId: target.deviceId, workspaceId: target.workspaceId },
    { signal },
  );
  if (result.ok) return result.value;
  return result.kind === "unsupported" ? "never" : null;
}

export function peerStatsKey(target: PeerWorkspaceTarget): string {
  return `peer:${peerTargetId(target)}`;
}

export function asksPeerSystemStats(peer: RoomPeer | undefined, active: boolean): boolean {
  return active && peerServes(peer, "system.stats");
}

export function PeerSystemStatsSegment({
  target,
  peer,
  active,
}: {
  target: PeerWorkspaceTarget;
  peer: RoomPeer | undefined;
  active: boolean;
}) {
  const asked = asksPeerSystemStats(peer, active);
  const stats = usePolledStats(
    peerStatsKey(target),
    asked,
    (signal) => askPeerSystemStats(target, signal),
    true,
  );
  if (!asked || !stats) return null;
  return <SystemStatsItem stats={stats} host={target.deviceName} />;
}
