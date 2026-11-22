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
import type { StateService } from "../../infra/storage/state-service";

import { restoreLayoutOrigins } from "./layout-origins";

const c = ipcContract.appState.call;

export interface AppStateChannelOptions {
  /** Current workspace metadata for restoring legacy layout records. */
  listWorkspaces?: () => WorkspaceMeta[];
  /**
   * Invoked synchronously after a `set` call that includes a `language`
   * field, with the newly requested language value.
   *
   * The main/index.ts wiring uses this to:
   *   (a) call getMainI18n().changeLanguage(lang) so subsequent t() calls
   *       resolve to the new locale immediately;
   *   (b) reinstall the native application menu with the updated labels;
   *   (c) broadcast `appState.languageChanged` to all renderer windows.
   */
  onLanguageChanged?: (language: AppState["language"] & string) => void;
  /**
   * Invoked synchronously after a `set` call that includes a
   * `keybindingOverrides` field, with the new override list.
   *
   * The main/index.ts wiring uses this to:
   *   (a) reinstall the native application menu so accelerator labels
   *       reflect the effective bindings;
   *   (b) broadcast `appState.keybindingsChanged` to all renderer
   *       windows so each recompiles its dispatcher tables.
   */
  onKeybindingsChanged?: (overrides: NonNullable<AppState["keybindingOverrides"]>) => void;
  /**
   * Invoked synchronously after a `set` call that includes an
   * `editorKeybindingOverrides` field, with the new override list.
   *
   * The main/index.ts wiring uses this only to broadcast
   * `appState.editorKeybindingsChanged` to all renderer windows so each
   * re-reconciles Monaco. No native-menu rebuild — editor commands are
   * not menu items.
   */
  onEditorKeybindingsChanged?: (
    overrides: NonNullable<AppState["editorKeybindingOverrides"]>,
  ) => void;
  /**
   * Invoked after a `set` call that includes `terminalShell` or
   * `terminalShells`, even to clear them. The main/index.ts wiring
   * broadcasts `appState.terminalShellsChanged` to all renderer windows.
   */
  onTerminalShellsChanged?: () => void;
  /** Invoked after a `set` call that includes `agentProfiles`. */
  onAgentProfilesChanged?: () => void;
  /**
   * Invoked after a `set` call that includes `themePreference`, with the
   * new theme. The main/index.ts wiring repaints the window controls.
   */
  onThemeChanged?: (theme: NonNullable<AppState["themePreference"]>) => void;
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
        const { instructionEdits, ...patch } = validateArgs(c.set.args, args);
        const state = stateService.getState();
        const workspaceIds =
          patch.layoutByWorkspace ||
          instructionEdits?.some(({ scope }) => scope.kind === "workspace")
            ? opts.listWorkspaces?.().map(({ id }) => id)
            : undefined;
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
          // Archive a conversation's saved session layer for opening it again from history.
          const history = rememberChatInstructions(state, patch.layoutByWorkspace, workspaceIds);
          if (history) patch.chatInstructionHistory = history;
        }
        try {
          // Only validate layouts supplied by this window, then merge them into
          // the latest state without replacing another window's layouts.
          stateService.setState(patch, { workspaceIds });
        } catch (error) {
          return ipcErr("state-write-failed", String(error), { category: "failed" });
        }

        // Detect a language change and invoke the injected callback so the
        // caller can update the main-process i18n instance, rebuild the menu,
        // and broadcast to all renderer windows — without this module needing
        // to know about i18n, menus, or IPC broadcasting directly.
        if (patch.language !== undefined && opts.onLanguageChanged !== undefined) {
          opts.onLanguageChanged(patch.language);
        }

        // Same pattern for keybinding overrides: menu rebuild + broadcast
        // are owned by the caller so this module stays IPC-only.
        if (patch.keybindingOverrides !== undefined && opts.onKeybindingsChanged !== undefined) {
          opts.onKeybindingsChanged(patch.keybindingOverrides);
        }

        // Editor (Monaco) overrides: broadcast-only, no menu involvement.
        if (
          patch.editorKeybindingOverrides !== undefined &&
          opts.onEditorKeybindingsChanged !== undefined
        ) {
          opts.onEditorKeybindingsChanged(patch.editorKeybindingOverrides);
        }

        // Shells: clearing one sends the key with no value, so test for the key.
        if ("terminalShell" in patch || "terminalShells" in patch) {
          opts.onTerminalShellsChanged?.();
        }

        if ("agentProfiles" in patch) opts.onAgentProfilesChanged?.();
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
