import path from "node:path";

/** Files a peer opened must also be read without following links in the editor. */
const guarded = new Map<string, { windows: boolean; paths: Set<string> }>();

function key(relPath: string, windows: boolean): string {
  return windows ? path.win32.normalize(relPath).toLowerCase() : path.posix.normalize(relPath);
}

export function guardPeerViewFile(workspaceId: string, root: string, relPath: string): void {
  const entry = guarded.get(workspaceId) ?? {
    windows: /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(root),
    paths: new Set<string>(),
  };
  entry.paths.add(key(relPath, entry.windows));
  guarded.set(workspaceId, entry);
}

export function isGuardedPeerViewFile(workspaceId: string, relPath: string): boolean {
  const entry = guarded.get(workspaceId);
  return entry?.paths.has(key(relPath, entry.windows)) === true;
}
