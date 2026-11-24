import { LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { dateTimeFormat } from "@/utils/intl-format";
import type { RecordingSummary } from "../../../shared/notes/summary";
import { notesApi } from "../../services/notes/api";
import {
  type RecordingSummaries,
  summarizeSavedRecording,
} from "../../services/notes/use-summaries";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { Button } from "../ui/button";
import { showToast } from "../ui/toast";

export function NoteSummaryBanners({
  workspaceId,
  noteId,
  summaries,
  flush,
  onShow,
}: {
  workspaceId: string;
  noteId: string;
  summaries: RecordingSummaries;
  flush: () => Promise<boolean>;
  onShow?: (recordingId: string) => void;
}) {
  const entries = Object.entries(summaries)
    .filter(([, summary]) => !summary.seen && summary.state !== "undone")
    .sort(([, a], [, b]) => b.startedAt - a.startedAt);
  if (entries.length === 0) return null;
  return (
    <div className="app-scrollbar flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto border-b border-border px-3 py-1.5">
      {entries.map(([recordingId, summary]) => (
        <SummaryBanner
          key={summary.runId}
          {...{ workspaceId, noteId, recordingId, summary, flush }}
          onShow={onShow && (() => onShow(recordingId))}
        />
      ))}
    </div>
  );
}

export function SummaryBanner({
  workspaceId,
  noteId,
  recordingId,
  summary,
  flush,
  onShow,
}: {
  workspaceId: string;
  noteId: string;
  recordingId: string;
  summary: RecordingSummary;
  flush: () => Promise<boolean>;
  onShow?: () => void;
}) {
  const { t, i18n } = useTranslation("notes");
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (summary.seen || summary.state === "undone") return null;
  const running = summary.state === "running";
  const done = summary.state === "done";
  const skipped = summary.state === "skipped";
  const error = summary.state === "failed" ? summary.error : undefined;
  const kind = error?.kind;
  const resetsAt =
    error?.kind === "limit" && error.resetsAt !== undefined ? new Date(error.resetsAt) : null;
  const reset =
    resetsAt && Number.isFinite(resetsAt.getTime())
      ? dateTimeFormat(i18n.language || "en", { hour: "numeric", minute: "2-digit" }).format(
          resetsAt,
        )
      : null;
  const label = running
    ? t("summary.running")
    : done
      ? t("summary.complete", { count: summary.todos })
      : skipped
        ? t("summary.skipped")
        : reset
          ? t("summary.limitReset", { time: reset })
          : t(`summary.failure.${kind ?? "failed"}`);
  const needsSettings = kind === "signed-out" || kind === "missing";
  const canRetry = error && !needsSettings && kind !== "too-long";
  const hasDetails = canRetry && kind !== "limit";
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      showToast({ kind: "error", message: t("summary.actionFailed") });
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!(await flush())) throw new Error("Note save failed");
    if ((await notesApi.undoSummary(workspaceId, noteId, recordingId)) === 0) {
      showToast({ kind: "info", message: t("summary.nothingToUndo") });
    }
  };
  return (
    <div
      className={cn(
        "min-w-0 rounded-(--radius-control) border px-2 py-1 text-app-ui-sm",
        error
          ? "border-[var(--state-warning-border)] bg-[var(--state-warning-bg)]"
          : "border-[var(--state-info-border)] bg-[var(--state-info-bg)]",
      )}
      data-testid="summary-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5" role="status">
          {running ? (
            <LoaderCircle
              className="size-3.5 shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0">
            {label}
            {running && <span className="text-muted-foreground"> · {t("summary.where")}</span>}
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {running ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              disabled={busy}
              onClick={() =>
                void run(() => notesApi.cancelSummary(workspaceId, noteId, recordingId))
              }
            >
              {t("common:action.cancel")}
            </Button>
          ) : (
            <>
              {done && onShow && (
                <Button variant="outline" size="sm" className="h-6 px-2" onClick={onShow}>
                  {t("summary.show")}
                </Button>
              )}
              {done && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2"
                  disabled={busy}
                  onClick={() => void run(undo)}
                >
                  {t("summary.undo")}
                </Button>
              )}
              {needsSettings && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => useSettingsUIStore.getState().openSettingsAt("claude")}
                >
                  {t("summary.openSettings")}
                </Button>
              )}
              {canRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      summarizeSavedRecording(workspaceId, noteId, recordingId, "retry"),
                    )
                  }
                >
                  {t("common:action.retry")}
                </Button>
              )}
              {hasDetails && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  {t("summary.details")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                disabled={busy}
                onClick={() =>
                  void run(() => notesApi.dismissSummary(workspaceId, noteId, recordingId))
                }
              >
                {t("common:action.close")}
              </Button>
            </>
          )}
        </div>
      </div>
      {hasDetails && detailsOpen && (
        <pre className="app-scrollbar max-h-24 overflow-y-auto whitespace-pre-wrap break-words px-1 py-1 font-mono text-app-ui-sm">
          {error.message ?? t("summary.noDetails")}
        </pre>
      )}
    </div>
  );
}
