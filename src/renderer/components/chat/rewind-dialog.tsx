// Going back to before one of the user's messages: what the files would
// lose (a dry run of rewind_files), then the conversation alone, or with
// the files.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatController, RewindPreview } from "../../services/chat/controller";
import type { UserItem } from "../../services/chat/model";
import { relPath } from "../../utils/path";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { showToast } from "../ui/toast";

/** Most files the dialog names; the rest are counted. */
const MAX_FILES = 8;

export function RewindDialog({
  controller,
  item,
  cwd,
  onClose,
}: {
  controller: ChatController;
  item: UserItem | null;
  cwd: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<RewindPreview | "loading" | { failed: string }>("loading");
  const [busy, setBusy] = useState(false);
  const uuid = item?.uuid;

  useEffect(() => {
    if (!uuid) return;
    let live = true;
    setPreview("loading");
    setBusy(false);
    controller.previewRewind(uuid).then(
      (result) => live && setPreview(result),
      (err: Error) => live && setPreview({ failed: err.message }),
    );
    return () => {
      live = false;
    };
  }, [controller, uuid]);

  const go = (files: boolean) => {
    if (!item) return;
    setBusy(true);
    controller.rewind(item, { files }).then(onClose, (err: Error) => {
      setBusy(false);
      showToast({ kind: "error", message: t("chat.rewind.failed", { error: err.message }) });
    });
  };

  const ready = preview !== "loading" && !("failed" in preview);
  const changes = ready && preview.canRewind && preview.filesChanged.length > 0 ? preview : null;

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && !busy && onClose()} size="md">
      <DialogHeader title={t("chat.rewind.title")} description={t("chat.rewind.description")} />
      <div className="mt-3 text-app-ui-sm" data-testid="chat-rewind-files">
        {preview === "loading" ? (
          <span className="text-muted-foreground">{t("chat.rewind.checking")}</span>
        ) : "failed" in preview ? (
          <span className="text-muted-foreground">
            {t("chat.rewind.files_unknown", { error: preview.failed })}
          </span>
        ) : !preview.canRewind ? (
          <span className="text-muted-foreground">
            {t("chat.rewind.files_unavailable", { error: preview.error ?? "" })}
          </span>
        ) : changes ? (
          <div className="flex flex-col gap-1">
            <span>
              {t("chat.rewind.files_changed", { count: changes.filesChanged.length })}
              <span className="ml-2 font-mono text-app-micro">
                <span className="text-[var(--git-status-added-fg)]">+{changes.insertions}</span>{" "}
                <span className="text-[var(--git-status-deleted-fg)]">−{changes.deletions}</span>
              </span>
            </span>
            <ul className="flex flex-col gap-0.5 font-mono text-app-micro text-muted-foreground">
              {changes.filesChanged.slice(0, MAX_FILES).map((file) => (
                <li key={file} className="truncate" title={file}>
                  {relPath(file, cwd)}
                </li>
              ))}
              {changes.filesChanged.length > MAX_FILES && (
                <li>
                  {t("chat.rewind.more_files", { count: changes.filesChanged.length - MAX_FILES })}
                </li>
              )}
            </ul>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("chat.rewind.no_files")}</span>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("action.cancel")}
        </Button>
        <Button
          variant={changes ? "outline" : "default"}
          size="sm"
          onClick={() => go(false)}
          disabled={busy || preview === "loading"}
          autoFocus={!changes}
        >
          {t("chat.rewind.conversation")}
        </Button>
        {changes && (
          <Button variant="default" size="sm" onClick={() => go(true)} disabled={busy} autoFocus>
            {t("chat.rewind.conversation_and_files")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
