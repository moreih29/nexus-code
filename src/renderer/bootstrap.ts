/**
 * App bootstrap sequences run once on mount. Extracted from App.tsx to
 * keep the component focused on rendering and workspace lifecycle.
 *
 * Functions here are plain async — callers own the `useEffect` wrapper.
 */

import type { LspLanguageId } from "../shared/types/app-state";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { ipcCallResult, ipcListen, mustSucceed } from "./ipc/client";
import { startClaudeActiveContextSync } from "./state/claude-active-context-sync";
import { startNotificationClickListener } from "./state/notification-click";
import {
  initBrowserLastUrlPersistence,
  initBrowserRuntimeSubscriptions,
} from "./state/operations/browser";
import { initBrowserPermissionSubscriptions } from "./state/operations/browser-permission";
import { initBrowserOverlayAutoSuspend } from "./state/operations/browser-suspend-auto";
import { initUpdatesSubscriptions } from "./state/operations/updates";
import { registerStatePersistence } from "./state/persistence";
import { useBrowserPermissionsStore } from "./state/stores/browser-permissions";
import { useClaudeStatusStore } from "./state/stores/claude-status";
import { useEditorFontStore } from "./state/stores/editor-font";
import { useIconThemeStore } from "./state/stores/icon-theme";
import { useLanguageStore } from "./state/stores/language";
import { useLayoutStore } from "./state/stores/layout";
import { useLspEnabledStore } from "./state/stores/lsp-enabled";
import { useNotificationsStore } from "./state/stores/notifications";
import { useTabsStore } from "./state/stores/tabs";
import { useTerminalStore } from "./state/stores/terminal";
import { useThemeStore } from "./state/stores/theme";
import { useUIStore } from "./state/stores/ui";
import { useUpdatesStore } from "./state/stores/updates";
import { useWindowOpacityStore } from "./state/stores/window-opacity";
import { initializeWorkspaceLifecycle } from "./state/workspace-cleanup";

/**
 * Hydrate persisted UI widths, layout snapshots, and tab records from
 * the main-process app-state store, then register the persistence
 * subscriber.
 *
 * Must be called once after the first render — Zustand `subscribe` fires
 * only on subsequent state changes, so the hydrate setStates have already
 * flushed synchronously by the time the subscriber is attached.
 */
/**
 * Returns true when a drag carries OS files (as opposed to internal tab/file
 * reordering or text drags, which advertise our custom `application/x-nexus-*`
 * MIME types or `text/plain`).
 */
function isOsFileDrag(e: DragEvent): boolean {
  return e.dataTransfer != null && Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Global safety net for OS file drops.
 *
 * The main renderer window has no `will-navigate` guard, so a file dropped
 * anywhere Chromium does not have a more specific handler would make the whole
 * window navigate to its `file://` URL — blanking the app. We swallow file
 * drags at the document level so that only opted-in surfaces (e.g. a terminal
 * pane, which calls `stopPropagation()` and therefore never reaches here) act
 * on them. Non-file drags (internal tab/file/text DnD) are left untouched.
 */
function installGlobalFileDropGuard(): void {
  document.addEventListener("dragover", (e) => {
    if (isOsFileDrag(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (isOsFileDrag(e)) e.preventDefault();
  });
}

export async function bootstrapAppState(): Promise<void> {
  // Install the central workspace:removed listener before any async I/O —
  // registered cleanup functions sit in memory regardless, but the listener
  // itself must be live before the first user-initiated workspace removal.
  initializeWorkspaceLifecycle();

  // Neutralize stray OS file drops app-wide before any view mounts — see
  // installGlobalFileDropGuard for the file:// navigation hazard it prevents.
  installGlobalFileDropGuard();

  // Wire the OS notification click → workspace activate + tab reveal listener.
  startNotificationClickListener();

  // Wire browser tab runtime event subscriptions (navigated / loadingChanged /
  // error / titleUpdated) so useBrowserRuntimeStore stays up-to-date.
  initBrowserRuntimeSubscriptions();

  // Wire last-URL persistence: debounces currentUrl changes from the runtime
  // store and flushes them to the tabs store so the URL survives app restarts.
  // Must be called after initBrowserRuntimeSubscriptions.
  initBrowserLastUrlPersistence();

  // Wire the browser permission prompt subscription so browserPermission:prompt
  // broadcasts from main are forwarded to the PermissionPromptRoot queue.
  initBrowserPermissionSubscriptions();

  // Drag-time browser-overlay suspend is claimed/released from
  // `use-drag-source.ts` directly (React bubble-phase `onDragStart` →
  // one-shot document `dragend` + unmount cleanup).  Doing it from React's
  // handler avoids a capture-phase race against `setData` that would
  // otherwise leave the WebContentsView covering the drop zone.
  //
  // Modal / dropdown / context-menu / popover overlays are handled by the
  // MutationObserver-based auto-suspend below — it watches body for any
  // Radix portal element so callsites bypassing our wrapper (e.g. the
  // Settings dialog using RadixDialog.Root directly) still trigger suspend.
  initBrowserOverlayAutoSuspend();

  // Bootstrap is an initialization path — no recovery possible if appState is unavailable.
  const state = mustSucceed(await ipcCallResult("appState", "get", undefined));

  useUIStore.getState().hydrate({
    sidebarWidth: state.sidebarWidth,
    filesPanelWidth: state.filesPanelWidth,
    sidebarHidden: state.sidebarHidden,
    filesPanelHidden: state.filesPanelHidden,
  });

  // Hydrate theme from appState (authoritative store).
  // This overwrites the localStorage-based initial value so the two stay in sync.
  useThemeStore.getState().hydrate(state.themePreference);

  // Hydrate language from appState (authoritative store).
  // Overwrites the navigator.language-based boot approximation so the
  // persisted preference takes effect before the first user interaction.
  useLanguageStore.getState().hydrate(state.language);

  // Hydrate icon theme from appState (authoritative store).
  // Overwrites the localStorage-based boot value so the two remain in sync.
  useIconThemeStore.getState().hydrate(state.iconTheme);

  // Subscribe to language changes broadcast by main when another window (or
  // the same window via appState.set) triggers a locale switch.  Main emits
  // `appState.languageChanged` after updating its own i18n instance and
  // rebuilding the native menu, so the renderer only needs to synchronise its
  // own i18next instance and html[lang] attribute via `hydrate`.
  ipcListen("appState", "languageChanged", ({ language }) => {
    useLanguageStore.getState().hydrate(language);
  });

  // Hydrate editor font settings from appState (authoritative store).
  useEditorFontStore.getState().hydrate({
    size: state.editorFontSize,
    family: state.editorFontFamily,
    ligatures: state.editorFontLigatures,
    lineHeight: state.editorFontLineHeight,
  });

  // Hydrate terminal user settings from appState (authoritative store).
  useTerminalStore.getState().hydrate({
    fontSize: state.terminalFontSize,
    cursorStyle: state.terminalCursorStyle,
    fontFamily: state.terminalFontFamily,
    fontLigatures: state.terminalFontLigatures,
  });

  // Hydrate window opacity from appState (authoritative store).
  useWindowOpacityStore.getState().hydrate(state.windowOpacity);

  // Hydrate update preferences (channel + auto-check toggle) from appState
  // and install the statusChanged listener.
  useUpdatesStore.getState().hydrate({
    channel: state.updateChannel,
    autoCheckEnabled: state.autoCheckForUpdates,
  });
  initUpdatesSubscriptions();

  // Hydrate OS notification toggle so the Notifications panel reflects
  // persisted state on first render.
  useNotificationsStore.getState().hydrate(state.osNotificationsEnabled);

  // Hydrate browser permission global toggles so the BrowserPermissionsPanel
  // reflects persisted state on first render.
  useBrowserPermissionsStore.getState().hydrate(state.browserPermissionGrants);

  if (state.layoutByWorkspace) {
    for (const [wsId, snap] of Object.entries(state.layoutByWorkspace)) {
      try {
        const tabsMap: Record<
          string,
          (typeof snap.tabs)[number] & {
            isPreview: boolean;
            isPinned: boolean;
            defaultTitle: string;
          }
        > = {};
        for (const t of snap.tabs) {
          const isPreview =
            "isPreview" in t && typeof t.isPreview === "boolean" ? t.isPreview : false;
          const isPinned = "isPinned" in t && typeof t.isPinned === "boolean" ? t.isPinned : false;
          // 마이그레이션: defaultTitle 필드가 없는 옛 스냅샷은 현재 title을 fallback으로
          // 사용. 이후 정상 동작 — set 경로들이 같은 invariant를 유지한다.
          const defaultTitle =
            "defaultTitle" in t && typeof t.defaultTitle === "string" ? t.defaultTitle : t.title;
          tabsMap[t.id] = { ...t, isPreview, isPinned, defaultTitle };
        }
        useTabsStore.setState((s) => ({
          byWorkspace: { ...s.byWorkspace, [wsId]: tabsMap },
        }));

        const knownTabIds = new Set(snap.tabs.map((t) => t.id));
        useLayoutStore
          .getState()
          .hydrate(wsId, { root: snap.root, activeGroupId: snap.activeGroupId }, knownTabIds);
      } catch {
        // Silent repair: skip invalid snapshot for this workspace
      }
    }
  }

  registerStatePersistence();

  // Dev-only console helper for testing window transparency before a settings
  // UI exists. `__setWindowOpacity(0.5)` dual-writes localStorage + appState
  // (mirrors what a future settings control will call). The renderer surfaces
  // update live, but the OS window's `transparent` flag is fixed at
  // window-creation time — restart the app to see the window go transparent.
  if (import.meta.env?.DEV) {
    (window as unknown as { __setWindowOpacity?: (v: number) => void }).__setWindowOpacity = (
      v: number,
    ) => {
      useWindowOpacityStore.getState().setOpacity(v);
      console.info(`[dev] windowOpacity = ${v} — restart the app to apply the window flag.`);
    };
  }
}

/**
 * Load the workspace list from main, push it into the store, and
 * restore the active workspace selection.
 *
 * Does NOT call workspace:activate at startup. Main's init() is the source
 * of truth for the restored active workspace and its conditional auto-connect
 * (key-only SSH and local connect automatically; interactive SSH restores in
 * the disconnected state). Calling activate here would both trigger a
 * connection and wrongly bump the recency list on every app launch.
 */
export async function bootstrapWorkspaces(
  setAll: (list: WorkspaceMeta[]) => void,
  setActiveWorkspaceId: (id: string | null) => void,
): Promise<void> {
  // Bootstrap is an initialization path — no recovery possible if workspace list is unavailable.
  const list = mustSucceed(await ipcCallResult("workspace", "list", undefined));
  setAll(list);
  if (list.length > 0) {
    const first = list[0];
    setActiveWorkspaceId(first.id);
  }
}

/**
 * Claude 세션 상태 store를 초기화하고 status broadcast 구독을 설정한다.
 *
 * 1. snapshot call로 현재 모든 (workspaceId, tabId) 상태를 store에 로드한다.
 * 2. claude:status 이벤트를 구독해 incremental 갱신을 처리한다.
 *
 * 워크스페이스 제거 정리는 workspace-cleanup registry(registerWorkspaceCleanup)가
 * 담당하므로 여기서 별도로 구독하지 않는다.
 */
export async function bootstrapClaudeStatus(): Promise<void> {
  // 현재 모든 탭의 Claude 상태를 snapshot으로 로드한다.
  const result = await ipcCallResult("claude", "snapshot", {});
  if (result.ok) {
    useClaudeStatusStore.getState().setMany(result.value);
  }

  // 이후 상태 변경은 status broadcast로 incremental 갱신된다.
  ipcListen("claude", "status", (entry) => {
    useClaudeStatusStore.getState().set(entry);
  });

  // PTY exit / session-end 시 main이 broker entry를 제거하며 cleared를 발사한다.
  // 받는 즉시 renderer 사본에서 해당 (workspaceId, tabId) 항목을 제거해야 한다 —
  // 그러지 않으면 마지막 broadcast된 running 상태가 사이드바·탭 인디케이터에
  // 그대로 남는다.
  ipcListen("claude", "cleared", ({ workspaceId, tabId }) => {
    useClaudeStatusStore.getState().clearTab(workspaceId, tabId);
  });

  // active workspace/tab을 main에 push하는 구독 시작 + 사용자가 탭을 활성화하면
  // markSeen IPC로 completed→idle 자동 전이.
  startClaudeActiveContextSync();
}

/**
 * Hydrate the per-workspace LSP enabled-languages store for all known
 * workspaces. Must be called after `bootstrapWorkspaces` so the workspace
 * list is available, and before any `attachLspBridge` call that gates on
 * `isLspEnabledForWorkspace`.
 *
 * Queries main for each workspace's enabled list in parallel then bulk-loads
 * into the store in one shot so the sync getter sees a fully populated state
 * before any editor model fires its first didOpen.
 */
export async function bootstrapLspEnabled(workspaces: WorkspaceMeta[]): Promise<void> {
  if (workspaces.length === 0) return;

  const entries = await Promise.all(
    workspaces.map(async (ws) => {
      const result = await ipcCallResult("lsp", "getEnabledLanguages", { workspaceId: ws.id });
      if (!result.ok) return [ws.id, []] as const;
      return [ws.id, result.value.languages] as const;
    }),
  );

  const initial: Record<string, LspLanguageId[]> = {};
  for (const [wsId, langs] of entries) {
    initial[wsId] = langs as LspLanguageId[];
  }
  useLspEnabledStore.getState().hydrateAll(initial);
}
