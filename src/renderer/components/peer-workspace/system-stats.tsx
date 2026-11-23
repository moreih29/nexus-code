/**
 * How busy the host of a workspace on another computer is, in its status
 * bar as locally: asked while the workspace is shown and that computer
 * serves it (system.stats, with its files); an older one that does not
 * know the method is not asked again until the workspace is shown again.
 */

import type { RoomPeer } from "../../../shared/remote/room";
import { ipcCallResult } from "../../ipc/client";
import { peerServes } from "../../services/remote/room";
import { type StatsAnswer, usePolledStats } from "../../services/system-stats/use-system-stats";
import { type PeerWorkspaceTarget, peerTargetId } from "../../state/stores/peer-workspace";
import { SystemStatsItem } from "../workbench/system-stats";

/** One ask of that computer: none while it cannot tell, "never" from one without the method. */
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

export function PeerSystemStatsSegment({
  target,
  peer,
  active,
}: {
  target: PeerWorkspaceTarget;
  peer: RoomPeer | undefined;
  /** The workspace is shown and that computer can be reached. */
  active: boolean;
}) {
  const served = peerServes(peer, "system.stats");
  const stats = usePolledStats(`peer:${peerTargetId(target)}`, active && served, (signal) =>
    askPeerSystemStats(target, signal),
  );
  if (!served || !stats) return null;
  return <SystemStatsItem stats={stats} host={target.deviceName} />;
}
