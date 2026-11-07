/**
 * Commit context menu shared by History rows, row toolbar buttons, and the
 * detail toolbar. Mixed and hard reset are intentionally not present.
 */
import i18next from "i18next";
import { AlertDialog as RadixAlertDialog } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CommitDetail, LogEntry } from "../../../../../shared/git/types";
import { copyText } from "../../../../utils/clipboard";
import { Button } from "../../../ui/button";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../../../ui/dialog";
import { DialogHeader } from "../../../ui/dialog-header";
import {
  DropdownMenuAtPoint,
  DropdownMenuItem,
  type DropdownMenuPoint,
  DropdownMenuSeparator,
} from "../../../ui/dropdown-menu";
import { useDialogFocusReturn } from "../../../ui/use-dialog-focus-return";

export type HistoryCommitMenuPoint = DropdownMenuPoint;

export interface HistoryCommitMenuTarget {
  entry: LogEntry;
  detail?: CommitDetail | null;
  point: HistoryCommitMenuPoint;
}

export interface HistoryCommitMenuActions {
  cherryPick: (sha: string) => void;
  checkoutDetached: (sha: string) => void;
  resetSoft: (sha: string) => void;
}

export type HistoryCommitMenuSpec =
  | { kind: "item"; label: string; destructive?: boolean; onSelect: () => void }
  | { kind: "separator" };

interface HistoryCommitMenuProps {
  target: HistoryCommitMenuTarget | null;
  actions: HistoryCommitMenuActions;
  onClose: () => void;
}

export type HistoryCommitConfirmRequest =
  | { kind: "checkout"; sha: string; shortSha: string }
  | { kind: "reset-soft"; sha: string; shortSha: string };

/** Renders the commit menu at its point and owns its confirm dialogs. */
export function HistoryCommitMenu({ target, actions, onClose }: HistoryCommitMenuProps) {
  const [confirm, setConfirm] = useState<HistoryCommitConfirmRequest | null>(null);

  const items = target
    ? buildHistoryCommitMenuItems(target.entry, target.detail, actions, {
        requestCheckout: (request) => setConfirm(request),
        requestResetSoft: (request) => setConfirm(request),
      })
    : [];

  return (
    <>
      <DropdownMenuAtPoint point={target?.point ?? null} onClose={onClose}>
        {items.map((item, index) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key={separatorKey(items, index)} />
          ) : (
            <DropdownMenuItem
              key={item.label}
              className={item.destructive ? "git-destructive-text" : undefined}
              onSelect={item.onSelect}
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuAtPoint>
      <HistoryCommitConfirmDialog
        request={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={(request) => {
          setConfirm(null);
          if (request.kind === "checkout") {
            actions.checkoutDetached(request.sha);
          } else {
            actions.resetSoft(request.sha);
          }
        }}
      />
    </>
  );
}

/**
 * Builds the menu model. Tests assert this list so mixed/hard reset cannot
 * accidentally appear when the UI grows.
 */
export function buildHistoryCommitMenuItems(
  entry: LogEntry,
  detail: CommitDetail | null | undefined,
  actions: HistoryCommitMenuActions,
  confirmers: {
    requestCheckout: (request: HistoryCommitConfirmRequest) => void;
    requestResetSoft: (request: HistoryCommitConfirmRequest) => void;
  },
): HistoryCommitMenuSpec[] {
  const shortSha = entry.shortSha ?? entry.sha.slice(0, 7);
  const message = detail?.message ?? [entry.subject, entry.body].filter(Boolean).join("\n\n");

  const t = i18next.t.bind(i18next);
  return [
    { kind: "item", label: t("files:git.history.menu.copySha"), onSelect: () => copyText(entry.sha) },
    { kind: "item", label: t("files:git.history.menu.copyMessage"), onSelect: () => copyText(message) },
    { kind: "separator" },
    {
      kind: "item",
      label: t("files:git.history.menu.cherryPick"),
      onSelect: () => actions.cherryPick(entry.sha),
    },
    {
      kind: "item",
      label: t("files:git.history.menu.checkoutDetached"),
      onSelect: () => confirmers.requestCheckout({ kind: "checkout", sha: entry.sha, shortSha }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("files:git.history.menu.resetSoft"),
      destructive: true,
      onSelect: () => confirmers.requestResetSoft({ kind: "reset-soft", sha: entry.sha, shortSha }),
    },
  ];
}

/** Builds a stable separator key from neighboring labels. */
function separatorKey(items: readonly HistoryCommitMenuSpec[], index: number): string {
  const before = closestMenuLabel(items, index, -1) ?? "start";
  const after = closestMenuLabel(items, index, 1) ?? "end";
  return `separator:${before}:${after}`;
}

/** Finds the nearest item label before or after a separator. */
function closestMenuLabel(
  items: readonly HistoryCommitMenuSpec[],
  index: number,
  direction: -1 | 1,
): string | null {
  for (let i = index + direction; i >= 0 && i < items.length; i += direction) {
    const item = items[i];
    if (item.kind === "item") return item.label;
  }
  return null;
}

/** Renders the detached checkout and soft-reset confirmations. */
function HistoryCommitConfirmDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: HistoryCommitConfirmRequest | null;
  onCancel: () => void;
  onConfirm: (request: HistoryCommitConfirmRequest) => void;
}) {
  const { t } = useTranslation("files");
  const title =
    request?.kind === "checkout"
      ? t("git.history.menu.confirmCheckout.title", { sha: request.shortSha })
      : t("git.history.menu.confirmResetSoft.title", { sha: request?.shortSha ?? "" });
  const description =
    request?.kind === "checkout"
      ? t("git.history.menu.confirmCheckout.description")
      : t("git.history.menu.confirmResetSoft.description");
  const confirmLabel =
    request?.kind === "checkout"
      ? t("git.history.menu.confirmCheckout.confirmLabel")
      : t("git.history.menu.confirmResetSoft.confirmLabel");
  const returnFocus = useDialogFocusReturn(request !== null);

  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixAlertDialog.Content
          className={dialogContentClass("sm", true)}
          onCloseAutoFocus={returnFocus}
        >
          <DialogHeader alert title={title} description={description} />
          <div className="mt-5 flex justify-end gap-2">
            <RadixAlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" size="sm" autoFocus>
                {request?.kind === "checkout"
                  ? t("git.history.menu.confirmCheckout.cancel")
                  : t("git.history.menu.confirmResetSoft.cancel")}
              </Button>
            </RadixAlertDialog.Cancel>
            <RadixAlertDialog.Action asChild>
              <Button
                type="button"
                variant={request?.kind === "reset-soft" ? "destructive" : "default"}
                size="sm"
                onClick={() => {
                  if (request) onConfirm(request);
                }}
              >
                {confirmLabel}
              </Button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
