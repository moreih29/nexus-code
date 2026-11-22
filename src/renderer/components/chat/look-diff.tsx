// Quick look's diff of a file the session changed: the file before the
// session's first change against the file as it is now, read-only. It
// follows the file as Claude or the editor changes it; another computer's
// file is read once, as it is when quick look opens it.

import { useMonaco } from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { isUnder } from "../../services/chat/links";
import { useSharedModel } from "../../services/editor";
import { usePeerText } from "../../services/remote/peer-workspace";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { fileErrorMessage } from "../../utils/file-error";
import { ReadOnlyDiffEditor } from "../editor/read-only-diff-editor";
import { EmptyState } from "../ui/empty-state";
import { useModelSource } from "../workspace/content/editor-view";

export function LookDiff({
  workspaceId,
  path,
  before,
}: {
  workspaceId: string;
  path: string;
  /** The file before the session changed it; null when the session wrote it new. */
  before: string | null;
}) {
  const { t } = useTranslation();
  const monaco = useMonaco();
  const root = useWorkspacesStore((s) => {
    const location = s.workspaces.find((w) => w.id === workspaceId)?.location;
    if (!location) return "";
    return location.kind === "local" ? location.rootPath : location.remotePath;
  });
  const { model, phase, errorCode } = useSharedModel({
    workspaceId,
    filePath: path,
    origin: isUnder(path, root) ? "workspace" : "external",
  });
  const now = useModelSource(model ?? null);

  if (phase === "error" && errorCode !== "NOT_FOUND") {
    return (
      <EmptyState
        title={fileErrorMessage(errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="h-full"
      />
    );
  }
  if (phase === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="h-full" />;
  }
  if (!monaco || phase === "loading" || (phase === "ready" && !model)) {
    return <EmptyState title={t("editor.loading_diff")} tone="status" className="h-full" />;
  }
  // A file gone since shows as emptied.
  return (
    <ReadOnlyDiffEditor
      testId="chat-look-diff"
      monaco={monaco}
      path={path}
      before={before ?? ""}
      now={model ? now : ""}
    />
  );
}

/** LookDiff of another computer's file, read through the room. */
export function PeerLookDiff({
  workspaceId,
  path,
  before,
}: {
  workspaceId: string;
  path: string;
  before: string | null;
}) {
  const { t } = useTranslation();
  const monaco = useMonaco();
  const read = usePeerText(workspaceId, path);
  if (read?.kind === "binary") {
    return <EmptyState title={t("editor.binary_file")} tone="status" className="h-full" />;
  }
  if (read?.kind === "too_large") {
    return (
      <EmptyState
        title={fileErrorMessage("TOO_LARGE", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
        tone="status"
        className="h-full"
      />
    );
  }
  if (read?.kind === "failed") {
    return <EmptyState title={fileErrorMessage("OTHER")} tone="status" className="h-full" />;
  }
  if (!monaco || read === null) {
    return <EmptyState title={t("editor.loading_diff")} tone="status" className="h-full" />;
  }
  return (
    <ReadOnlyDiffEditor
      testId="chat-look-diff"
      monaco={monaco}
      path={path}
      before={before ?? ""}
      now={read.text}
      hideGutterActions
    />
  );
}
