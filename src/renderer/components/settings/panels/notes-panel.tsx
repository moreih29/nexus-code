/**
 * Settings › Notes: what the notes take, location by location (a workspace's
 * folder), with the ones no workspace in the app is at marked "Not linked".
 * A location's notes can be shown in Finder or moved to the Trash.
 */

import { FolderOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ipcErrorToAppError } from "../../../../shared/ipc/result";
import type { NoteStorageEntry } from "../../../../shared/notes/types";
import { bannerEventId, useBannerDismissal } from "../../../hooks/use-banner-dismissal";
import { useIpcAction } from "../../../hooks/use-ipc-action";
import { ipcCallResult } from "../../../ipc/client";
import { surfaceError } from "../../../services/error-surface/surface-error";
import { notesApi } from "../../../services/notes/api";
import { formatBytes } from "../../../utils/format-bytes";
import { BannerDismissButton } from "../../ui/banner";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { SettingsGroup, SettingsPage } from "../section";
import { NoteSummaryGroup } from "./note-summary-group";
import { RememberedVoicesGroup } from "./remembered-voices-group";

type Entry = NoteStorageEntry & { workspaceIds: string[] };

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
);

const total = (e: Entry) =>
  e.bytes.text + e.bytes.sketches + e.bytes.files + e.bytes.images + e.bytes.recordings;

export function NotesPanel() {
  const { t } = useTranslation("notes");
  const [entries, setEntries] = useState<Entry[] | null>(null);

  const {
    run: runLoad,
    state: loadState,
    cancel: cancelLoad,
  } = useIpcAction<Entry[]>({
    onSuccess: setEntries,
  });
  const load = useCallback(() => {
    runLoad(async (signal) => {
      const result = await ipcCallResult("notes", "storage", undefined, { signal });
      if (!result.ok) throw ipcErrorToAppError(result);
      return result.value as Entry[];
    });
  }, [runLoad]);
  useEffect(() => {
    load();
    return notesApi.onChanged(() => {
      cancelLoad();
      load();
    });
  }, [cancelLoad, load]);

  const loadError = loadState.status === "error" ? loadState.error : null;
  const loadNotice = useBannerDismissal(
    ["settings-notes-storage"],
    loadError ? [bannerEventId(loadError)] : undefined,
  );
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!loadError) {
      setLoadMessage(null);
      return;
    }
    const present = surfaceError(loadError, { surface: "banner", onRetry: load });
    setLoadMessage(
      present.surface === "banner" || present.surface === "inline" ? present.userMessage : null,
    );
  }, [loadError, load]);

  const { run: runRemove, state: removeState } = useIpcAction<void>({ onSuccess: load });
  const removeError = removeState.status === "error" ? removeState.error : null;
  useEffect(() => {
    if (removeError) surfaceError(removeError, { surface: "toast" });
  }, [removeError]);

  const remove = async (entry: Entry) => {
    const ok = await showConfirmDialog({
      title: t("storage.removeConfirm.title", { label: entry.location.label }),
      description: t("storage.removeConfirm.description", {
        count: entry.notes,
        size: formatBytes(total(entry), "notes"),
      }),
      confirmLabel: t("storage.removeConfirm.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    runRemove(async (signal) => {
      const result = await ipcCallResult(
        "notes",
        "removeLocation",
        { key: entry.location.key },
        { signal },
      );
      if (!result.ok) throw ipcErrorToAppError(result);
    });
  };

  const sum = (entries ?? []).reduce((a, e) => a + total(e), 0);
  const count = (entries ?? []).reduce((a, e) => a + e.notes, 0);

  return (
    <SettingsPage>
      <NoteSummaryGroup />
      <SettingsGroup title={t("storage.heading")} description={t("storage.description")}>
        {loadError && !loadNotice.dismissed && (
          <div className="flex items-center justify-between gap-2">
            {loadMessage && (
              <p role="alert" className="text-app-ui-sm text-muted-foreground">
                {loadMessage}
              </p>
            )}
            <Button size="sm" variant="outline" onClick={load}>
              {t("common:action.retry")}
            </Button>
            <BannerDismissButton dismiss={loadNotice.dismiss} />
          </div>
        )}
        {entries === null ? null : entries.length === 0 ? (
          <p className="text-app-ui-sm text-muted-foreground">{t("storage.empty")}</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="notes-storage">
            <p className="text-app-ui-sm text-muted-foreground">
              {t("storage.total", { size: formatBytes(sum, "notes"), count })}
            </p>
            <UsageBar entries={entries} />
            <div className="flex flex-col gap-0.5">
              {entries.map((entry) => (
                <div
                  key={entry.location.key}
                  className="flex items-center gap-3 rounded-(--radius-control) px-2 py-1.5 hover:bg-[var(--state-hover-bg)]"
                  data-testid="notes-storage-row"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-app-body text-foreground">
                        {entry.location.label}
                      </span>
                      {entry.workspaceIds.length === 0 && (
                        <span
                          className="shrink-0 rounded-(--radius-pill) border border-[var(--state-warning-fg)] px-1.5 text-app-micro text-[var(--state-warning-fg)]"
                          title={t("storage.orphanHint")}
                        >
                          {t("storage.orphan")}
                        </span>
                      )}
                    </span>
                    <span
                      className="truncate font-mono text-app-micro text-muted-foreground"
                      title={entry.location.path}
                    >
                      {entry.location.host ? `${entry.location.host}:` : ""}
                      {entry.location.path}
                    </span>
                  </div>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="text-app-ui-sm text-foreground">
                      {formatBytes(total(entry), "notes")}
                    </span>
                    <span className="text-app-micro text-muted-foreground">
                      {t("storage.notes", { count: entry.notes })}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={iconButtonClass}
                    aria-label={t("storage.reveal")}
                    title={t("storage.reveal")}
                    onClick={() =>
                      void ipcCallResult("notes", "revealLocation", { key: entry.location.key })
                    }
                  >
                    <FolderOpen className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={iconButtonClass}
                    aria-label={t("storage.remove")}
                    title={t("storage.remove")}
                    onClick={() => void remove(entry)}
                    disabled={removeState.status === "loading"}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </SettingsGroup>
      <RememberedVoicesGroup />
    </SettingsPage>
  );
}

const PARTS = [
  { key: "recordings", color: "var(--state-error-fg)" },
  { key: "files", color: "var(--state-info-fg)" },
  { key: "images", color: "var(--state-success-fg)" },
  { key: "sketches", color: "var(--state-warning-fg)" },
  { key: "text", color: "var(--muted-foreground)" },
] as const;

function UsageBar({ entries }: { entries: Entry[] }) {
  const { t } = useTranslation("notes");
  const parts = PARTS.map((p) => ({
    ...p,
    bytes: entries.reduce((a, e) => a + e.bytes[p.key], 0),
  }));
  const sum = parts.reduce((a, p) => a + p.bytes, 0) || 1;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-backdrop-bg)]">
        {parts.map((p) => (
          <span key={p.key} style={{ width: `${(p.bytes / sum) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-app-micro text-muted-foreground">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            {t(`storage.${p.key}`)} {formatBytes(p.bytes)}
          </span>
        ))}
      </div>
    </div>
  );
}
