// lsp-status-segment.tsx — the status bar's language server item.
//
// Shows the server of the active editor's language in this workspace: its
// name, a spinner while it starts or loads the project, a warning when it
// failed. Clicking it opens a menu with the server's state and memory, and
// the actions on it: restart, turn off in this workspace, show the log, open
// the settings. Renders nothing for a file no server serves, or while
// language servers are off altogether.

import { AlertTriangle, Braces, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { findLeaf } from "@/engine";
import { cn } from "@/utils/cn";
import {
  type BuiltinLspPresetLanguageId,
  lspPresetLanguageIdForPath,
  resolveLspPreset,
} from "../../../shared/lsp/config";
import { isLspLanguageOn, isLspLanguageOnForWorkspace } from "../../../shared/lsp/settings";
import type { LspServerStatus } from "../../../shared/lsp/status";
import { ipcCallResult } from "../../ipc/client";
import { useLayoutStore } from "../../state/stores/layout";
import { useLspLogViewerStore } from "../../state/stores/lsp-log-viewer";
import { useLspSettingsStore } from "../../state/stores/lsp-settings";
import { type LspProgress, lspStatusKey, useLspStatusStore } from "../../state/stores/lsp-status";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useTabsStore } from "../../state/stores/tabs";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

/** The language of the file in the workspace's active editor, if a server serves it. */
function useActiveEditorLanguage(workspaceId: string): BuiltinLspPresetLanguageId | null {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  return useMemo(() => {
    if (!layout) return null;
    const tabId = findLeaf(layout.root, layout.activeGroupId)?.activeTabId;
    const tab = tabId ? tabs?.[tabId] : undefined;
    if (tab?.type !== "editor") return null;
    return lspPresetLanguageIdForPath(tab.props.filePath);
  }, [layout, tabs]);
}

type SegmentState = "off" | "idle" | "busy" | "running" | "failed";

function segmentState(
  on: boolean,
  status: LspServerStatus | undefined,
  progress: LspProgress | undefined,
): SegmentState {
  if (!on) return "off";
  if (!status) return "idle";
  if (status.state === "failed") return "failed";
  if (status.state === "starting" || progress) return "busy";
  if (status.state === "running") return "running";
  // Crashed, or stopping to restart: the next server is on its way.
  if (status.stopReason === "crashed" || status.stopReason === "restart") return "busy";
  return "idle";
}

export function LspStatusSegment({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const languageId = useActiveEditorLanguage(workspaceId);
  const settings = useLspSettingsStore((s) => s.settings);
  const key = languageId ? lspStatusKey(workspaceId, languageId) : "";
  const status = useLspStatusStore((s) => s.statuses[key]);
  const progress = useLspStatusStore((s) => s.progress[key]);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  if (!languageId || !settings.enabled) return null;

  const on = isLspLanguageOnForWorkspace(settings, workspaceId, languageId);
  const state = segmentState(on, status, progress);
  const language = t(`lsp.language.${languageId}`);
  const title = t("lsp.segmentTitle", { language, state: describeState(t, on, status, progress) });
  const Icon = state === "busy" ? Loader2 : state === "failed" ? AlertTriangle : Braces;

  return (
    <div ref={wrapperRef} className="relative inline-flex h-full">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 h-full px-2",
          "text-app-ui-sm font-sans leading-none",
          "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
          (state === "off" || state === "idle") && "text-muted-foreground/70",
        )}
      >
        <Icon
          className={cn("size-3 shrink-0", state === "busy" && "animate-spin")}
          style={state === "failed" ? { color: "var(--status-bar-warning-bg)" } : undefined}
          aria-hidden="true"
        />
        <span className="truncate max-w-40">{language}</span>
      </button>
      {open ? (
        <LspStatusPopover
          workspaceId={workspaceId}
          languageId={languageId}
          on={on}
          status={status}
          progress={progress}
          wrapperRef={wrapperRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function describeState(
  t: Translate,
  on: boolean,
  status: LspServerStatus | undefined,
  progress: LspProgress | undefined,
): string {
  if (!on) return t("lsp.state.off");
  if (!status) return t("lsp.state.notStarted");
  if (status.state === "failed") {
    return status.missingBinary ? t("lsp.state.notFound") : t("lsp.state.failed");
  }
  if (status.state === "starting") return t("lsp.state.starting");
  if (progress) {
    const text = [progress.title, progress.message].filter(Boolean).join(" — ");
    const percent = progress.percentage !== undefined ? ` ${progress.percentage}%` : "";
    return `${text || t("lsp.state.working")}${percent}`;
  }
  if (status.state === "running") return t("lsp.state.running");
  return t(`lsp.state.stopped.${status.stopReason ?? "idle"}`);
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const MENU_ITEM_CLASS =
  "flex w-full items-center px-2 py-1 rounded-(--radius-control) text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none";

function LspStatusPopover({
  workspaceId,
  languageId,
  on,
  status,
  progress,
  wrapperRef,
  onClose,
}: {
  workspaceId: string;
  languageId: BuiltinLspPresetLanguageId;
  on: boolean;
  status: LspServerStatus | undefined;
  progress: LspProgress | undefined;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const settings = useLspSettingsStore((s) => s.settings);
  const [memory, setMemory] = useState<number | null>(null);
  const running = status?.state === "running";

  useDismissOnOutsideClick(wrapperRef, true, onClose);

  // Asked once per opening: ps on macOS, a process walk on Windows.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    void ipcCallResult("lsp", "serverMemory", { workspaceId }).then((result) => {
      if (cancelled || !result.ok) return;
      const entry = result.value.find((m) => m.languageId === languageId);
      setMemory(entry ? entry.rssBytes : null);
    });
    return () => {
      cancelled = true;
    };
  }, [running, workspaceId, languageId]);

  const offInSettings = !isLspLanguageOn(settings, languageId);
  const offHere = settings.disabledByWorkspace[workspaceId]?.includes(languageId) ?? false;
  const server = [status?.serverName, status?.serverVersion].filter(Boolean).join(" ");
  const install = status?.missingBinary ? resolveLspPreset(languageId)?.install : undefined;

  function act(action: () => void): void {
    action();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-label={t("lsp.menuTitle", { language: t(`lsp.language.${languageId}`) })}
      className={cn(
        "absolute bottom-full right-0 z-40 mb-1",
        "w-[300px] max-w-[min(300px,calc(100vw-2rem))]",
        "floating-panel p-1",
      )}
    >
      <div className="px-2 pt-1 pb-1.5 flex flex-col gap-0.5">
        <span className="text-app-ui-sm text-foreground font-medium">
          {t("lsp.menuTitle", { language: t(`lsp.language.${languageId}`) })}
        </span>
        {server && <span className="text-app-ui-sm text-muted-foreground truncate">{server}</span>}
        <span className="text-app-ui-sm text-muted-foreground">
          {describeState(t, on, status, progress)}
          {running && memory !== null && ` · ${t("lsp.memory", { size: formatMegabytes(memory) })}`}
        </span>
        {status?.state === "failed" &&
          (install ? (
            <span className="text-app-ui-sm text-muted-foreground break-words select-text">
              {t("lsp.installHint", { command: install })}
            </span>
          ) : (
            status.error && (
              <span className="text-app-ui-sm text-muted-foreground line-clamp-3 break-words">
                {status.error}
              </span>
            )
          ))}
      </div>
      <div className="h-px bg-border my-1" />
      {on && (
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={() =>
            act(() => void ipcCallResult("lsp", "restartServer", { workspaceId, languageId }))
          }
        >
          {t("lsp.restart")}
        </button>
      )}
      {!offInSettings && (
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={() =>
            act(
              () =>
                void ipcCallResult("lsp", "setWorkspaceLanguageEnabled", {
                  workspaceId,
                  languageId,
                  enabled: offHere,
                }),
            )
          }
        >
          {offHere ? t("lsp.turnOnHere") : t("lsp.turnOffHere")}
        </button>
      )}
      <button
        type="button"
        className={MENU_ITEM_CLASS}
        onClick={() => act(() => useLspLogViewerStore.getState().open({ workspaceId, languageId }))}
      >
        {t("lsp.showLog")}
      </button>
      <button
        type="button"
        className={MENU_ITEM_CLASS}
        onClick={() => act(() => useSettingsUIStore.getState().openSettingsAt("editor"))}
      >
        {t("lsp.openSettings")}
      </button>
    </div>
  );
}
