import { isDrivePath } from "./outside-url";

const PEER_ID_PREFIX = "peer:";

export const PEER_HOST = "peer";

export interface PeerWorkspace {
  readonly deviceId: string;
  readonly workspaceId: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function peerWorkspaceId(deviceId: string, workspaceId: string): string {
  return `${PEER_ID_PREFIX}${deviceId}:${workspaceId}`;
}

export function peerOf(id: string): PeerWorkspace | null {
  if (!id.startsWith(PEER_ID_PREFIX)) return null;
  const [deviceId = "", workspaceId = "", ...rest] = id.slice(PEER_ID_PREFIX.length).split(":");
  if (rest.length > 0 || !ID.test(deviceId) || !ID.test(workspaceId)) return null;
  return { deviceId, workspaceId };
}

export function buildPeerUrl(peer: PeerWorkspace, absPath: string): string {
  const path = isDrivePath(absPath) ? absPath.replace(/\\/g, "/") : absPath;
  const segments = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `nexus-workspace://${PEER_HOST}/${encodeURIComponent(peer.deviceId)}/${encodeURIComponent(peer.workspaceId)}/${segments}`;
}

export function buildPeerDirUrl(peer: PeerWorkspace, absDir: string): string {
  const base = buildPeerUrl(peer, absDir.replace(/[\\/]+$/, ""));
  return base.endsWith("/") ? base : `${base}/`;
}

export function peerFileOf(
  segments: readonly string[],
): { peer: PeerWorkspace; absPath: string } | null {
  const [deviceId = "", workspaceId = "", ...path] = segments;
  if (!ID.test(deviceId) || !ID.test(workspaceId) || path.length === 0) return null;
  const climbs = (segment: string) =>
    segment === "" || segment === "." || segment === ".." || /[\\/]/.test(segment);
  if (path.some(climbs)) return null;
  const fromDrive = /^[A-Za-z]:$/.test(path[0] ?? "");
  return {
    peer: { deviceId, workspaceId },
    absPath: fromDrive ? path.join("/") : `/${path.join("/")}`,
  };
}
