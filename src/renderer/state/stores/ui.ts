import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

const log = createLogger("ui");

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;

export const FILES_PANEL_WIDTH_MIN = 160;
export const FILES_PANEL_WIDTH_MAX = 600;
export const FILES_PANEL_WIDTH_DEFAULT = 240;

export const NOTE_TRANSCRIPT_WIDTH_MIN = 220;
export const NOTE_TRANSCRIPT_WIDTH_MAX = 900;
export const NOTE_TRANSCRIPT_WIDTH_DEFAULT = 340;
export const NOTE_TRANSCRIPT_SHARE_MIN = 0.15;
export const NOTE_TRANSCRIPT_SHARE_MAX = 0.85;
export const NOTE_TRANSCRIPT_SHARE_DEFAULT = 0.45;

function clampSidebar(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
}

function clampFilesPanel(value: number): number {
  return Math.min(FILES_PANEL_WIDTH_MAX, Math.max(FILES_PANEL_WIDTH_MIN, value));
}

function clampTranscriptWidth(value: number): number {
  return Math.round(
    Math.min(NOTE_TRANSCRIPT_WIDTH_MAX, Math.max(NOTE_TRANSCRIPT_WIDTH_MIN, value)),
  );
}

function clampTranscriptShare(value: number): number {
  return Math.min(NOTE_TRANSCRIPT_SHARE_MAX, Math.max(NOTE_TRANSCRIPT_SHARE_MIN, value));
}

function saved(partial: Partial<AppState>): void {
  void ipcCallResult("appState", "set", partial).then((result) => {
    if (!result.ok) log.warn(`appState set failed: ${result.message}`);
  });
}

interface HydrateOpts {
  sidebarWidth?: number;
  filesPanelWidth?: number;
  noteTranscriptWidth?: number;
  noteTranscriptShare?: number;
  sidebarHidden?: boolean;
  filesPanelHidden?: boolean;
  agentListFoldedGroups?: readonly string[];
  agentListUnfoldedTasks?: readonly string[];
  filesPanelModeByWorkspace?: Readonly<Record<string, string>>;
}

export type FilesPanelMode = "tree" | "search" | "git" | "agents" | "notes";

const FILES_PANEL_MODES: readonly FilesPanelMode[] = ["tree", "search", "git", "agents", "notes"];

function isFilesPanelMode(value: string): value is FilesPanelMode {
  return (FILES_PANEL_MODES as readonly string[]).includes(value);
}

function restoredModes(
  stored: Readonly<Record<string, string>> | undefined,
): Map<string, FilesPanelMode> {
  const modes = new Map<string, FilesPanelMode>();
  for (const [workspaceId, mode] of Object.entries(stored ?? {})) {
    if (isFilesPanelMode(mode)) modes.set(workspaceId, mode);
  }
  return modes;
}

export const FILES_PANEL_MODE_DEFAULT: FilesPanelMode = "tree";

interface UIState {
  sidebarWidth: number;
  filesPanelWidth: number;
  noteTranscriptWidth: number;
  noteTranscriptShare: number;
  sidebarHidden: boolean;
  filesPanelHidden: boolean;
  agentListFoldedGroups: ReadonlySet<string>;
  agentListUnfoldedTasks: ReadonlySet<string>;
  filesPanelModes: Map<string, FilesPanelMode>;
  hydrate(opts: HydrateOpts): void;
  setSidebarWidth(width: number, persist?: boolean): void;
  setFilesPanelWidth(width: number, persist?: boolean): void;
  setNoteTranscriptWidth(width: number, persist?: boolean): void;
  setNoteTranscriptShare(share: number, persist?: boolean): void;
  toggleAgentListGroup(group: string): void;
  toggleAgentListTask(workspaceId: string): void;
  setFilesPanelMode(workspaceId: string, mode: FilesPanelMode): void;
  toggleFilesPanel(): void;
  setPanelHidden(panel: "sidebar" | "files", hidden: boolean): void;
  toggleSidebar(): void;
}

export const useUIStore = create<UIState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    set((state) => {
      if (!state.filesPanelModes.has(id)) return state;
      const next = new Map(state.filesPanelModes);
      next.delete(id);
      return { filesPanelModes: next };
    });
  });

  return {
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    noteTranscriptWidth: NOTE_TRANSCRIPT_WIDTH_DEFAULT,
    noteTranscriptShare: NOTE_TRANSCRIPT_SHARE_DEFAULT,
    sidebarHidden: false,
    filesPanelHidden: false,
    agentListFoldedGroups: new Set(),
    agentListUnfoldedTasks: new Set(),
    filesPanelModes: new Map(),

    hydrate({
      sidebarWidth,
      filesPanelWidth,
      noteTranscriptWidth,
      noteTranscriptShare,
      sidebarHidden,
      filesPanelHidden,
      agentListFoldedGroups,
      agentListUnfoldedTasks,
      filesPanelModeByWorkspace,
    }) {
      set({
        sidebarWidth:
          sidebarWidth !== undefined ? clampSidebar(sidebarWidth) : SIDEBAR_WIDTH_DEFAULT,
        filesPanelWidth:
          filesPanelWidth !== undefined
            ? clampFilesPanel(filesPanelWidth)
            : FILES_PANEL_WIDTH_DEFAULT,
        noteTranscriptWidth:
          noteTranscriptWidth !== undefined
            ? clampTranscriptWidth(noteTranscriptWidth)
            : NOTE_TRANSCRIPT_WIDTH_DEFAULT,
        noteTranscriptShare:
          noteTranscriptShare !== undefined
            ? clampTranscriptShare(noteTranscriptShare)
            : NOTE_TRANSCRIPT_SHARE_DEFAULT,
        sidebarHidden: sidebarHidden ?? false,
        filesPanelHidden: filesPanelHidden ?? false,
        agentListFoldedGroups: new Set(agentListFoldedGroups ?? []),
        agentListUnfoldedTasks: new Set(agentListUnfoldedTasks ?? []),
        filesPanelModes: restoredModes(filesPanelModeByWorkspace),
      });
    },

    setSidebarWidth(width, persist) {
      const next = clampSidebar(width);
      set({ sidebarWidth: next });
      if (persist) {
        void ipcCallResult("appState", "set", { sidebarWidth: next }).then((result) => {
          if (!result.ok) log.warn(`appState set failed: ${result.message}`);
        });
      }
    },

    setFilesPanelWidth(width, persist) {
      const next = clampFilesPanel(width);
      set({ filesPanelWidth: next });
      if (persist) {
        void ipcCallResult("appState", "set", { filesPanelWidth: next }).then((result) => {
          if (!result.ok) log.warn(`appState set failed: ${result.message}`);
        });
      }
    },

    setNoteTranscriptWidth(width, persist) {
      const next = clampTranscriptWidth(width);
      set({ noteTranscriptWidth: next });
      if (persist) saved({ noteTranscriptWidth: next });
    },

    setNoteTranscriptShare(share, persist) {
      const next = clampTranscriptShare(share);
      set({ noteTranscriptShare: next });
      if (persist) saved({ noteTranscriptShare: next });
    },

    toggleAgentListGroup(group) {
      const next = new Set(get().agentListFoldedGroups);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      set({ agentListFoldedGroups: next });
      void ipcCallResult("appState", "set", { agentListFoldedGroups: [...next] }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },

    toggleAgentListTask(workspaceId) {
      const next = new Set(get().agentListUnfoldedTasks);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      set({ agentListUnfoldedTasks: next });
      void ipcCallResult("appState", "set", { agentListUnfoldedTasks: [...next] }).then(
        (result) => {
          if (!result.ok) log.warn(`appState set failed: ${result.message}`);
        },
      );
    },

    setFilesPanelMode(workspaceId, mode) {
      const modes = get().filesPanelModes;
      if ((modes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT) === mode) return;
      const next = new Map(modes);
      next.set(workspaceId, mode);
      set({ filesPanelModes: next });
      void ipcCallResult("appState", "set", {
        filesPanelModeByWorkspace: Object.fromEntries(next),
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },

    toggleFilesPanel() {
      let next = false;
      set((state) => {
        next = !state.filesPanelHidden;
        return { filesPanelHidden: next };
      });
      void ipcCallResult("appState", "set", { filesPanelHidden: next }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },

    setPanelHidden(panel, hidden) {
      const patch = panel === "sidebar" ? { sidebarHidden: hidden } : { filesPanelHidden: hidden };
      set(patch);
      void ipcCallResult("appState", "set", patch).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },

    toggleSidebar() {
      let nextSidebarHidden = false;
      let nextFilesPanelHidden = false;
      set((state) => {
        const anythingHidden = state.sidebarHidden || state.filesPanelHidden;
        nextSidebarHidden = !anythingHidden;
        nextFilesPanelHidden = !anythingHidden;
        return {
          sidebarHidden: nextSidebarHidden,
          filesPanelHidden: nextFilesPanelHidden,
        };
      });
      void ipcCallResult("appState", "set", {
        sidebarHidden: nextSidebarHidden,
        filesPanelHidden: nextFilesPanelHidden,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },
  };
});
