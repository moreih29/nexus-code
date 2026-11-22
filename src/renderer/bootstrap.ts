/**
 * App bootstrap sequences run once on mount. Extracted from App.tsx to
 * keep the component focused on rendering and workspace lifecycle.
 *
 * Functions here are plain async — callers own the `useEffect` wrapper.
 */

import { EMPTY_INSTRUCTIONS } from "../shared/chat/instructions";
import { createLogger } from "../shared/log/renderer";
import { lspSettingsFromState } from "../shared/lsp/settings";
import { ipcCallResult, ipcListen, mustSucceed } from "./ipc/client";
import { startTabActivityPolling } from "./services/agent-sessions/activity-poll";
import { startSessionEvents } from "./services/agent-sessions/session-events";
import { startAgentViewPruning, tabExists } from "./services/agent-view/show";
import { initBrowserOverlayAutoSuspend } from "./services/browser/suspend-auto";
import { refreshClaudeProfileConnection } from "./services/chat/claude/controller";
import { refreshCodexProfileConnection } from "./services/chat/codex/controller";
import { startCliUiListener } from "./services/cli/ui-requests";
import { initGitErrorToasts } from "./services/error-surface/git-error-toasts";
import { initUpdatesSubscriptions } from "./services/updates/operations";
import { startClaudeActiveContextSync } from "./state/claude-active-context-sync";
import { startNoteRemovalListener } from "./state/note-removal";
import { startNotificationClickListener } from "./state/notification-click";
import { initBrowserRuntimeSubscriptions } from "./state/operations/browser";
import { initBrowserPermissionSubscriptions } from "./state/operations/browser-permission";
import { initFocusResync } from "./state/operations/focus-resync";
import { initLspSettingsSync } from "./state/operations/lsp-settings";
import { initLspStatusSync } from "./state/operations/lsp-status";
import { initPortsSync } from "./state/operations/ports";
import { hydrateReleaseNotesSeen } from "./state/operations/release-notes";
import { focusWorkspace } from "./state/operations/workspace-selection";
import { hydrateLayoutSnapshots, registerStatePersistence } from "./state/persistence";
import { useActiveStore } from "./state/stores/active";
import { useAgentCliStore } from "./state/stores/agent-cli";
import { useAgentInstructionsStore } from "./state/stores/agent-instructions";
import { useAgentListViewStore } from "./state/stores/agent-list-view";
import { loadProfilesHome, useAgentProfilesStore } from "./state/stores/agent-profiles";
import { startAgentViewPeerOrderSync, useAgentViewStore } from "./state/stores/agent-view";
import { startAppFocusTracking } from "./state/stores/app-focus";
import { useBrowserPermissionsStore } from "./state/stores/browser-permissions";
import { useChatFontStore } from "./state/stores/chat-font";
import { useClaudeStatusStore } from "./state/stores/claude-status";
import { useEditorFontStore } from "./state/stores/editor-font";
import { useIconThemeStore } from "./state/stores/icon-theme";
import { useInactivePanelDimStore } from "./state/stores/inactive-panel-dim";
import { useKeybindingsStore } from "./state/stores/keybindings";
import { useLanguageStore } from "./state/stores/language";
import { useLspSettingsStore } from "./state/stores/lsp-settings";
import { useNoteSummarySettings } from "./state/stores/note-summary";
import { useNotificationsStore } from "./state/stores/notifications";
import { usePeerWorkspaceStore } from "./state/stores/peer-workspace";
import { usePreviewDefaultsStore } from "./state/stores/preview-defaults";
import { useTerminalStore } from "./state/stores/terminal";
import { useThemeStore } from "./state/stores/theme";
import { useUIStore } from "./state/stores/ui";
import { useUpdatesStore } from "./state/stores/updates";
import { useVoiceStore } from "./state/stores/voice";
import { useWindowOpacityStore } from "./state/stores/window-opacity";
import { useWorkspaceSidebarFolds } from "./state/stores/workspace-sidebar-folds";
import { restoredWorkspace, useWorkspacesStore } from "./state/stores/workspaces";
import { startTerminalExitListener } from "./state/terminal-exit";
import { initializeWorkspaceLifecycle } from "./state/workspace-cleanup";

const log = createLogger("bootstrap");

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

async function bootstrapAppState(): Promise<void> {
  // Install the central workspace:removed listener before any async I/O —
  // registered cleanup functions sit in memory regardless, but the listener
  // itself must be live before the first user-initiated workspace removal.
  initializeWorkspaceLifecycle();

  // Neutralize stray OS file drops app-wide before any view mounts — see
  // installGlobalFileDropGuard for the file:// navigation hazard it prevents.
  installGlobalFileDropGuard();

  // Reveal the tab a clicked OS notification points to.
  startNotificationClickListener();

  // Mark terminal tabs dead on PTY exit even while their view is unmounted.
  startTerminalExitListener();

  // Close the tabs of notes removed elsewhere (Settings, another window).
  startNoteRemovalListener();

  // Toast git failures the Source Control panel does not show itself.
  initGitErrorToasts();

  // Wire browser tab runtime event subscriptions (navigated / loadingChanged /
  // error / titleUpdated) so useBrowserRuntimeStore stays up-to-date.
  initBrowserRuntimeSubscriptions();

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

  // Re-read the active workspace's file tree and git status on app focus /
  // workspace switch — the safety net for changes the watchers can't see.
  initFocusResync();

  // Bootstrap is an initialization path — no recovery possible if appState is unavailable.
  const state = mustSucceed(await ipcCallResult("appState", "get", undefined));

  // Before anything opens a document: which language servers run.
  useLspSettingsStore.getState().hydrate(lspSettingsFromState(state));
  initLspSettingsSync();
  initLspStatusSync();
  initPortsSync();

  useWorkspaceSidebarFolds.getState().hydrate(state.workspaceSidebarFoldedPeers ?? []);
  useUIStore.getState().hydrate({
    sidebarWidth: state.sidebarWidth,
    filesPanelWidth: state.filesPanelWidth,
    noteTranscriptWidth: state.noteTranscriptWidth,
    noteTranscriptShare: state.noteTranscriptShare,
    sidebarHidden: state.sidebarHidden,
    filesPanelHidden: state.filesPanelHidden,
    agentListFoldedGroups: state.agentListFoldedGroups,
    agentListUnfoldedTasks: state.agentListUnfoldedTasks,
    filesPanelModeByWorkspace: state.filesPanelModeByWorkspace,
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

  // Hydrate user keybinding overrides — recompiles the dispatcher's
  // match tables so customized shortcuts are live before first input.
  useKeybindingsStore.getState().hydrate(state.keybindingOverrides);

  // Mirror of languageChanged: another window edited a binding → main
  // persisted it and broadcast the full override list. Hydration is
  // idempotent and does not write back, so windows converge.
  ipcListen("appState", "keybindingsChanged", ({ overrides }) => {
    useKeybindingsStore.getState().hydrate(overrides);
  });

  // Hydrate editor (Monaco) keybinding overrides. Reconciliation is a
  // no-op here when Monaco has not mounted yet — initializeEditorServices
  // re-applies from the store once the singleton is live.
  useKeybindingsStore.getState().hydrateEditor(state.editorKeybindingOverrides);

  // Mirror of keybindingsChanged for editor overrides — another window
  // edited an editor binding; re-reconcile Monaco. Idempotent.
  ipcListen("appState", "editorKeybindingsChanged", ({ overrides }) => {
    useKeybindingsStore.getState().hydrateEditor(overrides);
  });

  // Hydrate editor font settings from appState (authoritative store).
  useEditorFontStore.getState().hydrate({
    size: state.editorFontSize,
    family: state.editorFontFamily,
    ligatures: state.editorFontLigatures,
    lineHeight: state.editorFontLineHeight,
  });

  // The chat tabs' text size and font.
  useChatFontStore.getState().hydrate(state);

  // Hydrate terminal user settings from appState (authoritative store).
  useTerminalStore.getState().hydrate({
    fontSize: state.terminalFontSize,
    cursorStyle: state.terminalCursorStyle,
    fontFamily: state.terminalFontFamily,
    fontLigatures: state.terminalFontLigatures,
    shell: state.terminalShell,
    customShells: state.terminalShells,
    taskAgent: state.taskAgent,
    taskAgentCommand: state.taskAgentCommand,
  });

  // Another window changed the shells: take the saved list, so an edit made
  // here next doesn't write back this window's stale copy over it.
  ipcListen("appState", "terminalShellsChanged", (shells) => {
    useTerminalStore.getState().hydrateShells(shells);
  });

  // The Claude and Codex profiles, and their rules; another window's edits too.
  useAgentProfilesStore.getState().hydrate(state.agentProfiles);
  useNoteSummarySettings.setState(state.noteSummary, true);
  ipcListen("appState", "noteSummaryChanged", (settings) =>
    useNoteSummarySettings.setState(settings, true),
  );
  void loadProfilesHome();
  ipcListen("appState", "agentProfilesChanged", ({ config, connectionChangedProfileId }) => {
    useAgentProfilesStore.getState().hydrate(config);
    if (connectionChangedProfileId) {
      refreshClaudeProfileConnection(connectionChangedProfileId);
      refreshCodexProfileConnection(connectionChangedProfileId);
    }
  });

  // Hydrate window opacity from appState (authoritative store).
  useWindowOpacityStore.getState().hydrate(state.windowOpacity);

  // Hydrate inactive-panel dim multiplier from appState (authoritative store).
  useInactivePanelDimStore.getState().hydrate(state.inactivePanelDim);

  // Hydrate update preferences (channel, auto-check toggle, the versions
  // skipped and told of) from appState and install the statusChanged
  // listener.
  useUpdatesStore.getState().hydrate({
    channel: state.updateChannel,
    autoCheckEnabled: state.autoCheckForUpdates,
    ignoredVersion: state.ignoredUpdateVersion,
    announcedVersion: state.announcedUpdateVersion,
  });
  initUpdatesSubscriptions();
  hydrateReleaseNotesSeen(state.lastSeenReleaseNotesVersion);

  // Hydrate OS notification toggle so the Notifications panel reflects
  // persisted state on first render.
  useNotificationsStore.getState().hydrate(state);
  useVoiceStore.getState().hydrate(state);
  useAgentCliStore.getState().hydrate(state);
  useAgentListViewStore.getState().hydrate(state);
  usePreviewDefaultsStore.getState().hydrate(state.previewViewDefaults);

  // Hydrate browser permission global toggles so the BrowserPermissionsPanel
  // reflects persisted state on first render.
  useBrowserPermissionsStore.getState().hydrate(state.browserPermissionGrants);

  useAgentInstructionsStore.setState({
    config: state.agentInstructions ?? EMPTY_INSTRUCTIONS,
    history: state.chatInstructionHistory ?? {},
  });
  ipcListen("appState", "agentInstructionsChanged", ({ config }) =>
    useAgentInstructionsStore.setState({ config }),
  );
  ipcListen("appState", "chatInstructionHistoryChanged", (history) =>
    useAgentInstructionsStore.setState({ history }),
  );
  hydrateLayoutSnapshots(state.layoutByWorkspace);

  // The agent view's panels hold tabs, so they come back after the tabs,
  // keeping those that still exist, and let go of each tab as it closes.
  useAgentViewStore.getState().hydrate(state.agentView, tabExists);
  startAgentViewPruning();
  startAgentViewPeerOrderSync();

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
      log.info(`[dev] windowOpacity = ${v} — restart the app to apply the window flag.`);
    };
  }
}

/**
 * Load the workspace list and restore the selection main recorded. Main
 * owns startup connection policy, including interactive SSH workspaces
 * that wait for a user to connect.
 */
export async function bootstrapWorkspaces(): Promise<void> {
  // Bootstrap is an initialization path — no recovery possible if workspace list is unavailable.
  const [workspaces, connections] = await Promise.all([
    ipcCallResult("workspace", "list", undefined),
    ipcCallResult("workspace", "connectionSnapshot", undefined).catch((error: unknown) => {
      log.warn(`Workspace connection snapshot failed: ${String(error)}`);
    }),
  ]);
  if (connections && !connections.ok)
    log.warn(`Workspace connection snapshot failed: ${connections.message}`);
  const list = mustSucceed(workspaces);
  useWorkspacesStore.getState().setAll(list, connections?.ok ? connections.value : undefined);
  const active = await ipcCallResult("workspace", "active", undefined);

  // The sidebar can already be used while the active-ID reply is pending.
  if (useActiveStore.getState().activeWorkspaceId !== null) return;
  const currentList = useWorkspacesStore.getState().workspaces;
  const selected = restoredWorkspace(currentList, active.ok ? active.value : null);
  const peer = usePeerWorkspaceStore.getState();
  if (peer.active) {
    if (peer.lastLocalId === null && selected) {
      usePeerWorkspaceStore.setState({ lastLocalId: selected.id });
    }
    return;
  }
  if (selected) focusWorkspace(selected.id, "preserve");
}

/**
 * Restore tabs before the workspace can mount and seed a terminal. CLI
 * requests can arrive throughout startup and wait for both restorations.
 */
export function bootstrapWorkbench(
  hydrateAppState: () => Promise<void> = bootstrapAppState,
): Promise<void> {
  const ready = hydrateAppState().then(bootstrapWorkspaces);
  startCliUiListener(ready);
  return ready;
}

/**
 * Initializes the Claude session status store and sets up the status broadcast subscription.
 *
 * 1. A snapshot call loads the current status of every (workspaceId, tabId) into the store.
 * 2. Subscribes to claude:status events and handles incremental updates.
 *
 * Workspace-removal cleanup is handled by the workspace-cleanup registry
 * (registerWorkspaceCleanup), so it is not subscribed to separately here.
 */
export async function bootstrapClaudeStatus(): Promise<void> {
  // Load the Claude status of every tab as a snapshot.
  const result = await ipcCallResult("claude", "snapshot", {});
  if (result.ok) {
    useClaudeStatusStore.getState().setMany(result.value);
  }

  // Later status changes are applied incrementally through the status broadcast.
  ipcListen("claude", "status", (entry) => {
    useClaudeStatusStore.getState().set(entry);
  });

  // On PTY exit / session-end, main removes the broker entry and fires cleared.
  // On receipt the renderer must immediately remove that (workspaceId, tabId) entry from its copy —
  // otherwise the last broadcast running status
  // stays in the sidebar and tab indicators.
  ipcListen("claude", "cleared", ({ workspaceId, tabId }) => {
    useClaudeStatusStore.getState().clearTab(workspaceId, tabId);
  });

  // Whether the window is in front of the user; the sync below and the inbox
  // count the active tab as looked at only while it is.
  startAppFocusTracking();

  // Start the subscription that pushes the active workspace/tab to main + when the user activates a tab,
  // automatic completed→idle transition through the markSeen IPC.
  startClaudeActiveContextSync();

  // Codex and other agents' output activity, for the tab bar, the sidebar
  // and the inbox.
  startTabActivityPolling();

  // The sessions' state changes, for nexus events.
  startSessionEvents();
}
