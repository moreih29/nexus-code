// A workspace of another of the user's computers, as this one's previews
// read it: quick look over another computer's chat shows its files with the
// viewers a chat here uses. The renderer names such a workspace by both of
// its ids (peerWorkspaceId); the `nexus-workspace://` protocol serves its
// files at `nexus-workspace://peer/<deviceId>/<workspaceId>/<absPath>`,
// read from that computer through the room (files.read), which keeps them
// to that workspace's folders.

import { isDrivePath } from "./outside-url";

const PEER_ID_PREFIX = "peer:";

/** The URL host the protocol serves another computer's files under. */
export const PEER_HOST = "peer";

export interface PeerWorkspace {
  readonly deviceId: string;
  readonly workspaceId: string;
}

/** Ids as they go in a URL's path and in a peer workspace's name: no separator of either. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The name the renderer's previews give a workspace of another computer. */
export function peerWorkspaceId(deviceId: string, workspaceId: string): string {
  return `${PEER_ID_PREFIX}${deviceId}:${workspaceId}`;
}

/** The workspace of another computer `id` names; null for a workspace of this one. */
export function peerOf(id: string): PeerWorkspace | null {
  if (!id.startsWith(PEER_ID_PREFIX)) return null;
  const [deviceId = "", workspaceId = "", ...rest] = id.slice(PEER_ID_PREFIX.length).split(":");
  if (rest.length > 0 || !ID.test(deviceId) || !ID.test(workspaceId)) return null;
  return { deviceId, workspaceId };
}

/**
 * The URL a file of another computer's workspace is served at, by its
 * absolute path there: a Windows path from its drive (`…/C%3A/Users/…`).
 */
export function buildPeerUrl(peer: PeerWorkspace, absPath: string): string {
  const path = isDrivePath(absPath) ? absPath.replace(/\\/g, "/") : absPath;
  const segments = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `nexus-workspace://${PEER_HOST}/${encodeURIComponent(peer.deviceId)}/${encodeURIComponent(peer.workspaceId)}/${segments}`;
}

/** buildPeerUrl for a folder, with the trailing slash a `<base href>` needs. */
export function buildPeerDirUrl(peer: PeerWorkspace, absDir: string): string {
  const base = buildPeerUrl(peer, absDir.replace(/[\\/]+$/, ""));
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * The file a URL the protocol serves under PEER_HOST names: its workspace,
 * and its absolute path there, from the URL's decoded path segments. Null
 * for one that names none.
 */
export function peerFileOf(
  segments: readonly string[],
): { peer: PeerWorkspace; absPath: string } | null {
  const [deviceId = "", workspaceId = "", ...path] = segments;
  if (!ID.test(deviceId) || !ID.test(workspaceId) || path.length === 0) return null;
  // URL parsing takes out dot segments; one that decodes to a separator could climb back.
  const climbs = (segment: string) =>
    segment === "" || segment === "." || segment === ".." || /[\\/]/.test(segment);
  if (path.some(climbs)) return null;
  const fromDrive = /^[A-Za-z]:$/.test(path[0] ?? "");
  return {
    peer: { deviceId, workspaceId },
    absPath: fromDrive ? path.join("/") : `/${path.join("/")}`,
  };
}
