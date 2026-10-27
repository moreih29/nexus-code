// The working-tree file behind a diff tab's right side. A diff against the
// working tree (an unstaged or untracked change) edits that file in place,
// as VSCode's does; one whose right side is a git revision stays read-only.

import type { DiffTabPayload } from "../../../../shared/types/tab";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { cacheUriFor } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";

/**
 * The absolute path of the working-tree file a diff shows on its right side,
 * or null when that side is a git revision or the workspace is unknown.
 *
 * Resolved against the workspace root, as the diff reads that side
 * (`fs.readFile` of `relPath` in the workspace) — not against git's
 * top-level, which is the root with symlinks resolved (`/private/tmp/…` for
 * a workspace at `/tmp/…`) and so names the file by a path the editor's
 * workspace-relative model cache cannot load.
 */
export function diffWorkingFilePath(
  props: Pick<DiffTabPayload, "relPath" | "rightRef">,
  workspaceRoot: string | null,
): string | null {
  if (props.rightRef !== "WORKING" || !workspaceRoot) return null;
  return `${workspaceRoot.replace(/\/+$/, "")}/${props.relPath}`;
}

function workspaceRootOf(
  workspaces: ReadonlyArray<{ id: string; rootPath: string }>,
  workspaceId: string,
): string | null {
  return workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null;
}

/** {@link diffWorkingFilePath} for a diff tab's workspace. */
export function workingFileOfDiff(props: DiffTabPayload): string | null {
  const { workspaces } = useWorkspacesStore.getState();
  return diffWorkingFilePath(props, workspaceRootOf(workspaces, props.workspaceId));
}

/**
 * {@link workingFileOfDiff}, re-rendering when the workspace resolves. Null
 * props (a caller that is not showing a diff) yield null.
 */
export function useDiffWorkingFile(props: DiffTabPayload | null): string | null {
  const workspaceId = props?.workspaceId;
  const workspaceRoot = useWorkspacesStore((s) =>
    workspaceId === undefined ? null : workspaceRootOf(s.workspaces, workspaceId),
  );
  return props ? diffWorkingFilePath(props, workspaceRoot) : null;
}

/** Whether the working-tree file a diff edits has unsaved changes. */
export function isDiffWorkingFileDirty(props: DiffTabPayload): boolean {
  const filePath = workingFileOfDiff(props);
  return filePath !== null && isDirty(cacheUriFor(props.workspaceId, filePath));
}
