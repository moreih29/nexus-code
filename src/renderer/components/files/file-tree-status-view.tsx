/**
 * Render the file tree's "no rows yet" states (error / loading / empty).
 *
 * Extracted from FileTree so the tree component can stay focused on
 * tree-with-rows rendering. Returning `null` is the "pre-200ms hidden"
 * pose — the caller branches on the same condition there.
 */

import { useFilesStore } from "@/state/stores/files";

interface FileTreeStatusViewProps {
  workspaceId: string;
  rootAbsPath: string;
  rootError: string | undefined;
  isLoading: boolean;
  showLoading: boolean;
  treeKnown: boolean;
}

export function FileTreeStatusView({
  workspaceId,
  rootError,
  isLoading,
  showLoading,
  treeKnown,
}: FileTreeStatusViewProps): React.JSX.Element | null {
  if (rootError) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        Couldn't read this folder.
        <div className="mt-1 text-micro text-stone-gray">{toUserMessage(rootError)}</div>
        <button
          type="button"
          onClick={() => useFilesStore.getState().refresh(workspaceId)}
          className="mt-3 underline text-foreground hover:text-foreground/80"
        >
          Retry
        </button>
      </div>
    );
  }
  if (showLoading) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">Loading…</div>
    );
  }
  if (treeKnown && !isLoading) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        This folder is empty.
      </div>
    );
  }
  return null; // pre-200ms hidden
}

function toUserMessage(err: string): string {
  if (err.includes("ENOENT")) return "Folder not found.";
  if (err.includes("EACCES")) return "Permission denied.";
  return "Unexpected error.";
}
