/**
 * Render the file tree's "no rows yet" states (error / loading / empty).
 *
 * Extracted from FileTree so the tree component can stay focused on
 * tree-with-rows rendering. Returning `null` is the "pre-200ms hidden"
 * pose — the caller branches on the same condition there.
 */

import { useTranslation } from "react-i18next";
import { refresh } from "@/state/operations/files";
import { FS_ERROR, hasFsErrorCode } from "../../../../shared/fs/errors";

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
  const { t } = useTranslation("files");
  if (rootError) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        {t("fileTree.status.cantRead")}
        <div className="mt-1 text-app-micro text-stone-gray">{toUserMessage(rootError, t)}</div>
        <button
          type="button"
          onClick={() => refresh(workspaceId)}
          className="mt-3 underline text-foreground hover:text-foreground/80"
        >
          {t("fileTree.status.retry")}
        </button>
      </div>
    );
  }
  if (showLoading) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">{t("fileTree.status.loading")}</div>
    );
  }
  if (treeKnown && !isLoading) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        {t("fileTree.status.emptyFolder")}
      </div>
    );
  }
  return null; // pre-200ms hidden
}

function toUserMessage(err: string, t: (key: string) => string): string {
  // Errors flow through three layers before landing here:
  //   1. Node throws an errno (`ENOENT`, `EACCES`).
  //   2. The fs handler wraps it as `FS_ERROR.NOT_FOUND` etc.
  //   3. The renderer subscriber stores `err.message` on the tree slice.
  // Older error strings can still leak through from layers that haven't
  // been migrated to the shared codes — accept both forms here.
  if (hasFsErrorCode(err, FS_ERROR.NOT_FOUND) || err.includes("ENOENT")) return t("fileTree.status.error.notFound");
  if (hasFsErrorCode(err, FS_ERROR.PERMISSION_DENIED) || err.includes("EACCES"))
    return t("fileTree.status.error.permissionDenied");
  return t("fileTree.status.error.unexpected");
}
