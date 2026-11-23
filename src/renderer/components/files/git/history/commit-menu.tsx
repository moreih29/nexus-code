import i18next from "i18next";
import type { CommitDetail, LogEntry } from "../../../../../shared/git/types";
import { copyText } from "../../../../utils/clipboard";
import { showConfirmDialog } from "../../../ui/confirm-dialog";
import {
  DropdownMenuAtPoint,
  DropdownMenuItem,
  type DropdownMenuPoint,
  DropdownMenuSeparator,
} from "../../../ui/dropdown-menu";

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

export function HistoryCommitMenu({ target, actions, onClose }: HistoryCommitMenuProps) {
  const confirmThenRun = (request: HistoryCommitConfirmRequest) => {
    void confirmHistoryCommit(request).then((confirmed) => {
      if (!confirmed) return;
      if (request.kind === "checkout") actions.checkoutDetached(request.sha);
      else actions.resetSoft(request.sha);
    });
  };
  const items = target
    ? buildHistoryCommitMenuItems(target.entry, target.detail, actions, {
        requestCheckout: confirmThenRun,
        requestResetSoft: confirmThenRun,
      })
    : [];

  return (
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
  );
}

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
    {
      kind: "item",
      label: t("files:git.history.menu.copySha"),
      onSelect: () => copyText(entry.sha),
    },
    {
      kind: "item",
      label: t("files:git.history.menu.copyMessage"),
      onSelect: () => copyText(message),
    },
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

function separatorKey(items: readonly HistoryCommitMenuSpec[], index: number): string {
  const before = closestMenuLabel(items, index, -1) ?? "start";
  const after = closestMenuLabel(items, index, 1) ?? "end";
  return `separator:${before}:${after}`;
}

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

function confirmHistoryCommit(request: HistoryCommitConfirmRequest): Promise<boolean> {
  const t = i18next.t.bind(i18next);
  if (request.kind === "checkout") {
    return showConfirmDialog({
      title: t("files:git.history.menu.confirmCheckout.title", { sha: request.shortSha }),
      description: t("files:git.history.menu.confirmCheckout.description"),
      cancelLabel: t("files:git.history.menu.confirmCheckout.cancel"),
      confirmLabel: t("files:git.history.menu.confirmCheckout.confirmLabel"),
    });
  }
  return showConfirmDialog({
    title: t("files:git.history.menu.confirmResetSoft.title", { sha: request.shortSha }),
    description: t("files:git.history.menu.confirmResetSoft.description"),
    cancelLabel: t("files:git.history.menu.confirmResetSoft.cancel"),
    confirmLabel: t("files:git.history.menu.confirmResetSoft.confirmLabel"),
    variant: "destructive",
  });
}
