import { isDrivePath, OUTSIDE_HOST_SUFFIX } from "../../../../shared/fs/outside-url";
import { buildPeerDirUrl, buildPeerUrl, peerOf } from "../../../../shared/fs/peer-url";
import { peerRoot } from "../../remote/peer-workspace";

export function buildWorkspaceUrl(workspaceId: string, relPath: string): string {
  const peer = peerOf(workspaceId);
  if (peer) return buildPeerUrl(peer, joinUnder(peerRoot(workspaceId), relPath));
  const forwardSlashPath = relPath.replace(/\\/g, "/");
  const encodedSegments = forwardSlashPath.split("/").map(encodeURIComponent).join("/");
  return `nexus-workspace://${encodeURIComponent(workspaceId)}/${encodedSegments}`;
}

export function buildWorkspaceDirUrl(workspaceId: string, relDir: string): string {
  const peer = peerOf(workspaceId);
  if (peer) return buildPeerDirUrl(peer, joinUnder(peerRoot(workspaceId), relDir));
  const trimmed = relDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const base = buildWorkspaceUrl(workspaceId, trimmed);
  return base.endsWith("/") ? base : `${base}/`;
}

export function buildOutsideUrl(workspaceId: string, absPath: string): string {
  const peer = peerOf(workspaceId);
  if (peer) return buildPeerUrl(peer, absPath);
  const path = isDrivePath(absPath) ? absPath.replace(/\\/g, "/") : absPath;
  const encodedSegments = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `nexus-workspace://${encodeURIComponent(workspaceId)}${OUTSIDE_HOST_SUFFIX}/${encodedSegments}`;
}

export function buildOutsideDirUrl(workspaceId: string, absDir: string): string {
  const peer = peerOf(workspaceId);
  if (peer) return buildPeerDirUrl(peer, absDir);
  const base = buildOutsideUrl(workspaceId, absDir.replace(/\/+$/, ""));
  return base.endsWith("/") ? base : `${base}/`;
}

function joinUnder(root: string, relPath: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const rel = relPath.replace(/[\\/]+/g, sep).replace(/^[\\/]+/, "");
  if (rel === "") return root;
  return root.endsWith(sep) ? `${root}${rel}` : `${root}${sep}${rel}`;
}
