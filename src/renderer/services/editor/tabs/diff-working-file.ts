import type { DiffTabPayload } from "../../../../shared/types/tab";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { cacheUriFor } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";

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

export function workingFileOfDiff(props: DiffTabPayload): string | null {
  const { workspaces } = useWorkspacesStore.getState();
  return diffWorkingFilePath(props, workspaceRootOf(workspaces, props.workspaceId));
}

export function useDiffWorkingFile(props: DiffTabPayload | null): string | null {
  const workspaceId = props?.workspaceId;
  const workspaceRoot = useWorkspacesStore((s) =>
    workspaceId === undefined ? null : workspaceRootOf(s.workspaces, workspaceId),
  );
  return props ? diffWorkingFilePath(props, workspaceRoot) : null;
}

export function isDiffWorkingFileDirty(props: DiffTabPayload): boolean {
  const filePath = workingFileOfDiff(props);
  return filePath !== null && isDirty(cacheUriFor(props.workspaceId, filePath));
}
