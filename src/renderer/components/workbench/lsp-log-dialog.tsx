// lsp-log-dialog.tsx — a language server's log: what it logged and showed,
// the end of its stderr when it exited, and its starts and stops. Main keeps
// the entries (lsp.serverLog); the dialog asks for new ones while open.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/utils/cn";
import type { LspLogEntry, LspLogLevel } from "../../../shared/lsp/status";
import { ipcCallResult } from "../../ipc/client";
import { type LspLogTarget, useLspLogViewerStore } from "../../state/stores/lsp-log-viewer";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Button } from "../ui/button";

/** How often the open dialog asks for entries logged since. */
const LOG_POLL_MS = 1_000;
/** Entries kept on screen; main keeps fewer, this bounds a long session. */
const LOG_VIEW_LIMIT = 2_000;

const LEVEL_CLASS: Partial<Record<LspLogLevel, string>> = {
  error: "text-[var(--state-error-fg)]",
  warning: "text-[var(--state-warning-fg)]",
  stderr: "text-[var(--state-error-fg)]",
  lifecycle: "text-muted-foreground",
};

/** Mounted once at the App root; shows the log the store points at. */
export function LspLogDialogRoot(): React.JSX.Element | null {
  const target = useLspLogViewerStore((s) => s.target);
  const close = useLspLogViewerStore((s) => s.close);
  if (!target) return null;
  return (
    <LspLogDialog
      key={`${target.workspaceId}\0${target.languageId}`}
      target={target}
      onClose={close}
    />
  );
}

/** HH:MM:SS: a locale's own format can spell the units out. */
function formatTime(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatEntry(entry: LspLogEntry): string {
  return `[${formatTime(entry.time)}] ${entry.level}: ${entry.message}`;
}

function LspLogDialog({
  target,
  onClose,
}: {
  target: LspLogTarget;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LspLogEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // Follow new entries unless the user scrolled up to read.
  const followRef = useRef(true);
  const workspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === target.workspaceId)?.name ?? "",
  );
  const language = t(`lsp.language.${target.languageId}`, { defaultValue: target.languageId });

  useEffect(() => {
    let cancelled = false;
    let lastSeq = -1;
    let inFlight = false;
    const fetchNew = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await ipcCallResult("lsp", "serverLog", { ...target, afterSeq: lastSeq });
        if (cancelled || !result.ok || result.value.length === 0) return;
        lastSeq = result.value[result.value.length - 1]?.seq ?? lastSeq;
        setEntries((previous) => [...previous, ...result.value].slice(-LOG_VIEW_LIMIT));
      } finally {
        inFlight = false;
      }
    };
    void fetchNew();
    const timer = setInterval(() => void fetchNew(), LOG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [target]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on new entries
  useEffect(() => {
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [entries]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      className="flex flex-col gap-3"
      contentStyle={{ height: "min(560px, 80vh)" }}
      aria-describedby={undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <RadixDialog.Title className="text-app-body-emphasis text-foreground truncate">
          {t("lsp.logTitle", { language, workspace })}
        </RadixDialog.Title>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => void navigator.clipboard.writeText(entries.map(formatEntry).join("\n"))}
        >
          {t("lsp.copyLog")}
        </Button>
      </div>
      <div
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        }}
        className={cn(
          "flex-1 min-h-0 overflow-auto select-text",
          "rounded-(--radius-control) border border-border p-2",
          "font-mono text-app-ui-sm",
        )}
      >
        {entries.length === 0 ? (
          <p className="text-muted-foreground">{t("lsp.logEmpty")}</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.seq}
              className={cn("whitespace-pre-wrap break-words", LEVEL_CLASS[entry.level])}
            >
              <span className="text-muted-foreground">[{formatTime(entry.time)}] </span>
              {entry.message}
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
