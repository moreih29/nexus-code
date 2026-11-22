import type { IpcResult } from "../../../shared/ipc/result";
import type { PeerFolder } from "../../state/stores/peer-workspace";
import { joinPeerPath, peerPathKey } from "../../utils/peer-path";

export type PeerFolderError =
  | "missingWorkspace"
  | "missingFolder"
  | "accessDenied"
  | "updateNeeded"
  | "connectionUnavailable";

export function peerFolderError(kind: string, message: string): PeerFolderError {
  switch (kind) {
    case "not-found":
      return message === "no such workspace" ? "missingWorkspace" : "missingFolder";
    case "unsupported":
      return "updateNeeded";
    case "permission-denied":
      return "accessDenied";
    default:
      return "connectionUnavailable";
  }
}

export async function loadPeerFolder(
  read: () => Promise<IpcResult<PeerFolder>>,
): Promise<{ folder: PeerFolder } | { error: PeerFolderError }> {
  try {
    const result = await read();
    return result.ok
      ? { folder: result.value }
      : { error: peerFolderError(result.kind, result.message) };
  } catch {
    return { error: "connectionUnavailable" };
  }
}

export interface PeerTreeEntry {
  kind: "entry";
  path: string;
  key: string;
  parent: string | null;
  depth: number;
  node: { name: string; type: "dir" | "file" | "symlink" };
}

type PeerTreeRow =
  | PeerTreeEntry
  | {
      kind: "truncated" | "error" | "loading";
      key: string;
      folder: string;
      depth: number;
    };

export function peerTreeRows({
  root,
  title,
  folders,
  expanded,
  collapsedRoot,
  errors,
}: {
  root: string;
  title: string;
  folders: Readonly<Record<string, PeerFolder>>;
  expanded: ReadonlySet<string>;
  collapsedRoot: boolean;
  errors: Readonly<Record<string, PeerFolderError>>;
}): PeerTreeRow[] {
  const rootKey = peerPathKey(root);
  const rows: PeerTreeRow[] = [];
  function visit(entry: PeerTreeEntry) {
    rows.push(entry);
    if (entry.node.type !== "dir") return;
    const { key, depth } = entry;
    if (entry.parent === null ? collapsedRoot : !expanded.has(key)) return;

    const folder = folders[key];
    const status = errors[key] ? "error" : folder ? null : "loading";
    if (status) rows.push({ kind: status, key: `${status}:${key}`, folder: key, depth: depth + 1 });
    if (!folder) return;
    for (const child of folder.entries) {
      const path = joinPeerPath(folder.path, child.name);
      visit({
        kind: "entry",
        path,
        key: peerPathKey(path),
        parent: key,
        depth: depth + 1,
        node: { name: child.name, type: child.kind === "link" ? "symlink" : child.kind },
      });
    }
    if (folder.truncated) {
      rows.push({ kind: "truncated", key: `truncated:${key}`, folder: key, depth: depth + 1 });
    }
  }
  visit({
    kind: "entry",
    path: folders[rootKey]?.path ?? root,
    key: rootKey,
    parent: null,
    depth: 0,
    node: { type: "dir", name: title },
  });
  return rows;
}
