import { isDrivePath } from "./outside-url";
import { type PeerWorkspace, peerOf, peerWorkspaceId } from "./peer-url";

const PREFIX = "remote-file:";

export interface RemoteFileRef extends PeerWorkspace {
  path: string;
}

export function remoteFileKey({ deviceId, workspaceId, path }: RemoteFileRef): string {
  const canonical = /^[a-z]:\//.test(path) ? path[0].toUpperCase() + path.slice(1) : path;
  return `${PREFIX}${deviceId}/${workspaceId}/${encodeURIComponent(canonical)}`;
}

export function isRemoteFileKey(key: string): boolean {
  return key.startsWith(PREFIX);
}

export function parseRemoteFileKey(key: string): RemoteFileRef | null {
  if (!isRemoteFileKey(key)) return null;
  const [deviceId, workspaceId, encoded, ...rest] = key.slice(PREFIX.length).split("/");
  if (!deviceId || !workspaceId || !encoded || rest.length) return null;
  const peer = peerOf(peerWorkspaceId(deviceId, workspaceId));
  if (!peer) return null;
  try {
    const path = decodeURIComponent(encoded);
    if (path.includes("\0") || (!path.startsWith("/") && !isDrivePath(path))) return null;
    const file = { ...peer, path };
    return remoteFileKey(file) === key ? file : null;
  } catch {
    return null;
  }
}
