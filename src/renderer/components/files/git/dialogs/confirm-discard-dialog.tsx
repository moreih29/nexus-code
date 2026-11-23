import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { GitExpandedGroupKey } from "../../../../../shared/git/types";
import { showConfirmDialog } from "../../../ui/confirm-dialog";

export interface DiscardConfirmRequest {
  title: string;
  description: string;
  relPaths: string[];
  source?: GitExpandedGroupKey;
  confirmLabel?: string;
}

interface ConfirmDiscardDialogProps {
  request: DiscardConfirmRequest | null;
  onCancel: () => void;
  onConfirm: (request: DiscardConfirmRequest) => void;
}

export function ConfirmDiscardDialog({ request, onCancel, onConfirm }: ConfirmDiscardDialogProps) {
  const { t } = useTranslation("files");
  const handlers = useRef({ request, onCancel, onConfirm, t });
  handlers.current = { request, onCancel, onConfirm, t };
  const requestKey = request ? JSON.stringify(request) : null;

  useEffect(() => {
    const { request } = handlers.current;
    if (requestKey === null || !request) return;
    const aborter = new AbortController();
    const { t: translate } = handlers.current;
    void showConfirmDialog({
      title: request.title,
      description: request.description,
      details: request.relPaths,
      cancelLabel: translate("git.discard.cancel"),
      confirmLabel: request.confirmLabel ?? translate("git.discard.dialogConfirm"),
      variant: "destructive",
      signal: aborter.signal,
    }).then((confirmed) => {
      if (aborter.signal.aborted) return;
      if (confirmed) handlers.current.onConfirm(request);
      else handlers.current.onCancel();
    });
    return () => aborter.abort();
  }, [requestKey]);

  return null;
}
