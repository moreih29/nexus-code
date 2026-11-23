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

function isOsFileDrag(e: DragEvent): boolean {
  return e.dataTransfer != null && Array.from(e.dataTransfer.types).includes("Files");
}

function installGlobalFileDropGuard(): void {
  document.addEventListener("dragover", (e) => {
    if (isOsFileDrag(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (isOsFileDrag(e)) e.preventDefault();
  });
}

async function bootstrapAppState(): Promise<void> {
  initializeWorkspaceLifecycle();

  installGlobalFileDropGuard();

  startNotificationClickListener();

  startTerminalExitListener();

  startNoteRemovalListener();

  initGitErrorToasts();

  initBrowserRuntimeSubscriptions();

  initBrowserPermissionSubscriptions();

  initBrowserOverlayAutoSuspend();

  initFocusResync();

  const state = mustSucceed(await ipcCallResult("appState", "get", undefined));

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

  useThemeStore.getState().hydrate(state.themePreference);

  useLanguageStore.getState().hydrate(state.language);

  useIconThemeStore.getState().hydrate(state.iconTheme);

  ipcListen("appState", "languageChanged", ({ language }) => {
    useLanguageStore.getState().hydrate(language);
  });

  useKeybindingsStore.getState().hydrate(state.keybindingOverrides);

  ipcListen("appState", "keybindingsChanged", ({ overrides }) => {
    useKeybindingsStore.getState().hydrate(overrides);
  });

  useKeybindingsStore.getState().hydrateEditor(state.editorKeybindingOverrides);

  ipcListen("appState", "editorKeybindingsChanged", ({ overrides }) => {
    useKeybindingsStore.getState().hydrateEditor(overrides);
  });

  useEditorFontStore.getState().hydrate({
    size: state.editorFontSize,
    family: state.editorFontFamily,
    ligatures: state.editorFontLigatures,
    lineHeight: state.editorFontLineHeight,
  });

  useChatFontStore.getState().hydrate(state);

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

  ipcListen("appState", "terminalShellsChanged", (shells) => {
    useTerminalStore.getState().hydrateShells(shells);
  });

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

  useWindowOpacityStore.getState().hydrate(state.windowOpacity);

  useInactivePanelDimStore.getState().hydrate(state.inactivePanelDim);

  useUpdatesStore.getState().hydrate({
    channel: state.updateChannel,
    autoCheckEnabled: state.autoCheckForUpdates,
    ignoredVersion: state.ignoredUpdateVersion,
    announcedVersion: state.announcedUpdateVersion,
  });
  initUpdatesSubscriptions();
  hydrateReleaseNotesSeen(state.lastSeenReleaseNotesVersion);

  useNotificationsStore.getState().hydrate(state);
  useVoiceStore.getState().hydrate(state);
  useAgentCliStore.getState().hydrate(state);
  useAgentListViewStore.getState().hydrate(state);
  usePreviewDefaultsStore.getState().hydrate(state.previewViewDefaults);

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

  useAgentViewStore.getState().hydrate(state.agentView, tabExists);
  startAgentViewPruning();
  startAgentViewPeerOrderSync();

  registerStatePersistence();
}

export async function bootstrapWorkspaces(): Promise<void> {
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

export function bootstrapWorkbench(
  hydrateAppState: () => Promise<void> = bootstrapAppState,
): Promise<void> {
  const ready = hydrateAppState().then(bootstrapWorkspaces);
  startCliUiListener(ready);
  return ready;
}

export async function bootstrapClaudeStatus(): Promise<void> {
  const result = await ipcCallResult("claude", "snapshot", {});
  if (result.ok) {
    useClaudeStatusStore.getState().setMany(result.value);
  }

  ipcListen("claude", "status", (entry) => {
    useClaudeStatusStore.getState().set(entry);
  });

  ipcListen("claude", "cleared", ({ workspaceId, tabId }) => {
    useClaudeStatusStore.getState().clearTab(workspaceId, tabId);
  });

  startAppFocusTracking();

  startClaudeActiveContextSync();

  startTabActivityPolling();

  startSessionEvents();
}
