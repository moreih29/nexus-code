/**
 * The nexus command's settings, mirrored from AppState for the Agent CLI
 * settings panel. Hydrated at bootstrap; the panel persists changes through
 * appState.set, and main reads AppState on every nexus command.
 */

import { create } from "zustand";
import type { AppState } from "../../../shared/types/app-state";

export type CrossWorkspacePolicy = AppState["cliCrossWorkspace"];

interface AgentCliSettings {
  enabled: boolean;
  crossWorkspace: CrossWorkspacePolicy;
  agentContext: boolean;
}

interface AgentCliState extends AgentCliSettings {
  hydrate(
    state: Partial<Pick<AppState, "cliEnabled" | "cliCrossWorkspace" | "cliAgentContext">>,
  ): void;
  set(patch: Partial<AgentCliSettings>): void;
}

export const useAgentCliStore = create<AgentCliState>((set) => ({
  enabled: true,
  crossWorkspace: "ask",
  agentContext: true,

  hydrate(state) {
    set({
      enabled: state.cliEnabled ?? true,
      crossWorkspace: state.cliCrossWorkspace ?? "ask",
      agentContext: state.cliAgentContext ?? true,
    });
  },

  set(patch) {
    set(patch);
  },
}));
