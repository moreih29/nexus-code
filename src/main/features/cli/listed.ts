/**
 * Whether a folder nexus workspace add is given is one the app lists. The
 * app's own check compares paths as spelled, but a terminal's directory is
 * its real path: on macOS a workspace at /tmp/app is /private/tmp/app there.
 */
import { realpath as fsRealpath } from "node:fs/promises";
import {
  type WorkspaceLocation,
  type WorkspaceMeta,
  workspaceLocationKey,
} from "../../../shared/types/workspace";

/**
 * The workspace listed at `location`: one spelled the same, or for a local
 * folder, one whose folder is the same once links are followed.
 */
export async function listedAt(
  workspaces: readonly WorkspaceMeta[],
  location: WorkspaceLocation,
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<WorkspaceMeta | undefined> {
  const key = workspaceLocationKey(location);
  const spelled = workspaces.find((w) => workspaceLocationKey(w.location) === key);
  if (spelled || location.kind !== "local") return spelled;
  const real = (path: string) => realpath(path).catch(() => null);
  const folder = await real(location.rootPath);
  if (folder === null) return undefined;
  for (const workspace of workspaces) {
    if (workspace.location.kind !== "local") continue;
    if ((await real(workspace.location.rootPath)) === folder) return workspace;
  }
  return undefined;
}
