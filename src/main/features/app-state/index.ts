import { EMPTY_AGENT_PROFILES, isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import {
  chatInstructionHistoryKey,
  EMPTY_INSTRUCTIONS,
  withInstruction,
} from "../../../shared/chat/instructions";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { AppState } from "../../../shared/types/app-state";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import {
  isPlainRecord,
  pickWorkspaceLayouts,
  type StateService,
} from "../../infra/storage/state-service";

import { restoreLayoutOrigins } from "./layout-origins";

const c = ipcContract.appState.call;

export interface AppStateChannelOptions {
  listWorkspaces?: () => WorkspaceMeta[];
  onLanguageChanged?: (language: AppState["language"] & string) => void;
  onKeybindingsChanged?: (overrides: NonNullable<AppState["keybindingOverrides"]>) => void;
  onEditorKeybindingsChanged?: (
    overrides: NonNullable<AppState["editorKeybindingOverrides"]>,
  ) => void;
  onTerminalShellsChanged?: () => void;
  onAgentProfilesChanged?: () => void;
  onThemeChanged?: (theme: NonNullable<AppState["themePreference"]>) => void;
  onLayoutsChanged?: (state: Readonly<AppState>) => void;
}

export function registerAppStateChannel(
  stateService: Pick<StateService, "getState" | "setState">,
  opts: AppStateChannelOptions = {},
): void {
  register("appState", {
    keepOnRendererClose: ["set"],
    call: {
      get: (_args: unknown) => {
        const state = stateService.getState();
        return opts.listWorkspaces ? restoreLayoutOrigins(state, opts.listWorkspaces()) : state;
      },
      set: (args: unknown) => {
        const input = isPlainRecord(args) ? args : undefined;
        const rawLayouts = input?.layoutByWorkspace;
        const layouts = isPlainRecord(rawLayouts) ? rawLayouts : undefined;
        const layoutWorkspaceIds = layouts && opts.listWorkspaces?.().map(({ id }) => id);
        const { instructionEdits, ...patch } = validateArgs(
          c.set.args,
          layoutWorkspaceIds && layouts
            ? {
                ...input,
                layoutByWorkspace: pickWorkspaceLayouts(layouts, layoutWorkspaceIds),
              }
            : args,
        );
        const state = stateService.getState();
        const workspaceIds =
          layoutWorkspaceIds ??
          (patch.layoutByWorkspace ||
          instructionEdits?.some(({ scope }) => scope.kind === "workspace")
            ? opts.listWorkspaces?.().map(({ id }) => id)
            : undefined);
        const profiles = (patch.agentProfiles ?? state.agentProfiles ?? EMPTY_AGENT_PROFILES)
          .profiles;
        const hasProfile = (id: string) =>
          isDefaultProfileId(id) || profiles.some((profile) => profile.id === id);
        if (
          instructionEdits?.some(
            ({ scope }) =>
              (scope.kind === "profile" && !hasProfile(scope.id)) ||
              (scope.kind === "workspace" && workspaceIds && !workspaceIds.includes(scope.id)),
          )
        )
          return ipcErr("not-found", "The instruction layer was removed.", { category: "failed" });
        if (
          instructionEdits?.length ||
          (patch.agentProfiles && state.agentInstructions?.profiles)
        ) {
          let config = state.agentInstructions ?? EMPTY_INSTRUCTIONS;
          if (patch.agentProfiles && config.profiles) {
            config = {
              ...config,
              profiles: Object.fromEntries(
                Object.entries(config.profiles).filter(([id]) => hasProfile(id)),
              ),
            };
          }
          patch.agentInstructions = instructionEdits?.reduce(withInstruction, config) ?? config;
        }
        if (patch.layoutByWorkspace) {
          const history = rememberChatInstructions(state, patch.layoutByWorkspace, workspaceIds);
          if (history) patch.chatInstructionHistory = history;
        }
        try {
          stateService.setState(patch, { workspaceIds });
        } catch (error) {
          return ipcErr("state-write-failed", String(error), { category: "failed" });
        }

        if (patch.layoutByWorkspace) opts.onLayoutsChanged?.(stateService.getState());

        if (patch.language !== undefined && opts.onLanguageChanged !== undefined) {
          opts.onLanguageChanged(patch.language);
        }

        if (patch.keybindingOverrides !== undefined && opts.onKeybindingsChanged !== undefined) {
          opts.onKeybindingsChanged(patch.keybindingOverrides);
        }

        if (
          patch.editorKeybindingOverrides !== undefined &&
          opts.onEditorKeybindingsChanged !== undefined
        ) {
          opts.onEditorKeybindingsChanged(patch.editorKeybindingOverrides);
        }

        if ("terminalShell" in patch || "terminalShells" in patch) {
          opts.onTerminalShellsChanged?.();
        }

        if ("agentProfiles" in patch) opts.onAgentProfilesChanged?.();
        if (patch.noteSummary) broadcast("appState", "noteSummaryChanged", patch.noteSummary);
        if (patch.agentInstructions) {
          broadcast("appState", "agentInstructionsChanged", { config: patch.agentInstructions });
        }
        if (patch.chatInstructionHistory) {
          broadcast("appState", "chatInstructionHistoryChanged", patch.chatInstructionHistory);
        }

        if (patch.themePreference !== undefined) {
          opts.onThemeChanged?.(patch.themePreference);
        }
        return ipcOk(undefined);
      },
    },
    listen: {},
  });
}

function rememberChatInstructions(
  state: AppState,
  changed: NonNullable<AppState["layoutByWorkspace"]>,
  workspaceIds: readonly string[] | undefined,
): AppState["chatInstructionHistory"] {
  const history = { ...state.chatInstructionHistory };
  let dirty = false;
  for (const [id, layout] of Object.entries(changed)) {
    if (workspaceIds && !workspaceIds.includes(id)) continue;
    const previous = new Map(state.layoutByWorkspace?.[id]?.tabs.map((tab) => [tab.id, tab]));
    let remembered = history[id];
    for (const tab of layout.tabs) {
      if (tab.type !== "claude" && tab.type !== "codex") continue;
      const conversationId = tab.type === "claude" ? tab.props.sessionId : tab.props.threadId;
      const text = tab.props.instructions;
      if (!conversationId || text === undefined) continue;
      const old = previous.get(tab.id);
      if (
        old?.type === tab.type &&
        old.props.instructions === text &&
        (old.type === "claude" ? old.props.sessionId : old.props.threadId) === conversationId
      )
        continue;
      const key = chatInstructionHistoryKey(tab.type, conversationId);
      if ((remembered?.[key] ?? "") === text) continue;
      remembered = { ...remembered };
      if (text.trim()) remembered[key] = text;
      else delete remembered[key];
      dirty = true;
    }
    if (remembered && Object.keys(remembered).length > 0) history[id] = remembered;
    else delete history[id];
  }
  return dirty ? history : undefined;
}
