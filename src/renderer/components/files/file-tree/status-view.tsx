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
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        {t("fileTree.status.loading")}
      </div>
    );
  }
  if (treeKnown && !isLoading) {
    return (
      <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        {t("fileTree.status.emptyFolder")}
      </div>
    );
  }
  return null;
}

function toUserMessage(err: string, t: (key: string) => string): string {
  if (hasFsErrorCode(err, FS_ERROR.NOT_FOUND) || err.includes("ENOENT"))
    return t("fileTree.status.error.notFound");
  if (hasFsErrorCode(err, FS_ERROR.PERMISSION_DENIED) || err.includes("EACCES"))
    return t("fileTree.status.error.permissionDenied");
  return t("fileTree.status.error.unexpected");
}
