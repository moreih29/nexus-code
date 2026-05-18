/**
 * Commit context menu shared by History rows, row toolbar buttons, and the
 * detail toolbar. Mixed and hard reset are intentionally not present.
 */
import { AlertDialog as RadixAlertDialog } from "radix-ui";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitDetail, LogEntry } from "../../../../../shared/git/types";
import { copyText } from "../../../../utils/clipboard";
import { Button } from "../../../ui/button";
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
          className="fixed z-50 min-w-[212px] rounded border border-border bg-popover p-1 text-popover-foreground shadow-none"
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

  return [
    { kind: "item", label: "Copy SHA", onSelect: () => copyText(entry.sha) },
    { kind: "item", label: "Copy message", onSelect: () => copyText(message) },
    { kind: "separator" },
    {
      kind: "item",
      label: "Cherry-pick this commit…",
      onSelect: () => actions.cherryPick(entry.sha),
    },
    {
      kind: "item",
      label: "Checkout (detached)…",
      onSelect: () => confirmers.requestCheckout({ kind: "checkout", sha: entry.sha, shortSha }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Reset branch to here (soft)…",
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
  const title =
    request?.kind === "checkout"
      ? `Checkout ${request.shortSha} detached?`
      : `Reset branch to ${request?.shortSha ?? ""}?`;
  const description =
    request?.kind === "checkout"
      ? "This leaves your branch and views the commit in detached HEAD mode."
      : "Soft reset keeps changes staged so you can recommit them.";
  const confirmLabel = request?.kind === "checkout" ? "Checkout Detached" : "Reset Soft";

  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixAlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-(--radius-island) border border-border bg-background p-5 text-foreground shadow-none outline-none">
          <RadixAlertDialog.Title className="text-app-body-emphasis text-foreground">
            {title}
          </RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            {description}
          </RadixAlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <RadixAlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" size="sm" autoFocus>
                Cancel
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
