/**
 * Commit context menu shared by History rows, row toolbar buttons, and the
 * detail toolbar. Mixed and hard reset are intentionally not present.
 */
import { AlertDialog as RadixAlertDialog } from "radix-ui";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import type { CommitDetail, LogEntry } from "../../../../../shared/git/types";
import { copyText } from "../../../../utils/clipboard";
import { Button } from "../../../ui/button";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../../../ui/dialog";
import { useDismissOnOutsideClick } from "../../../ui/use-dismiss-on-outside-click";

export interface HistoryCommitMenuPoint {
  x: number;
  y: number;
}

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

/** Renders the fixed-position commit menu and owns confirm dialogs. */
export function HistoryCommitMenu({ target, actions, onClose }: HistoryCommitMenuProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<HistoryCommitConfirmRequest | null>(null);
  const open = target !== null;
  const close = useCallback(() => onClose(), [onClose]);
  useDismissOnOutsideClick(wrapperRef, open, close);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const items = target
    ? buildHistoryCommitMenuItems(target.entry, target.detail, actions, {
        requestCheckout: (request) => setConfirm(request),
        requestResetSoft: (request) => setConfirm(request),
      })
    : [];

  return (
    <>
      {target ? (
        <div
          ref={wrapperRef}
          role="menu"
          className="fixed z-50 min-w-[212px] floating-panel p-1"
          style={popoverPositionStyle(target.point)}
          onContextMenu={(event) => event.preventDefault()}
        >
          {items.map((item, index) =>
            item.kind === "separator" ? (
              <MenuSeparator key={separatorKey(items, index)} />
            ) : (
              <MenuButton
                key={item.label}
                label={item.label}
                destructive={item.destructive}
                onClick={() => {
                  onClose();
                  item.onSelect();
                }}
              />
            ),
          )}
        </div>
      ) : null}
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

/** Keeps the fixed menu inside the viewport. */
function popoverPositionStyle(point: HistoryCommitMenuPoint): React.CSSProperties {
  if (typeof window === "undefined") return { left: point.x, top: point.y };
  return {
    left: Math.max(4, Math.min(point.x, window.innerWidth - 220)),
    top: Math.max(4, Math.min(point.y, window.innerHeight - 260)),
  };
}

/** Renders one commit menu button. */
function MenuButton({
  label,
  destructive,
  onClick,
}: {
  label: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={
        destructive
          ? "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm git-destructive-text hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
          : "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Renders the separator shared by commit menu sections. */
function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-border" />;
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

  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixAlertDialog.Content className={dialogContentClass("sm", true)}>
          <RadixAlertDialog.Title className="text-app-body-emphasis text-foreground">
            {title}
          </RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            {description}
          </RadixAlertDialog.Description>
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
