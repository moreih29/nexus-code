import { create } from "zustand";
import { profileDirectory } from "../../../../shared/agent-profiles/env";
import { profileOf } from "../../../../shared/agent-profiles/profiles";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { isWindows } from "../../../utils/platform";
import type { ModelInfo } from "../model";
import { planUsageKey } from "../plan-usage";

interface CatalogSource {
  tabKey: string;
  profileKey: string;
  models: readonly ModelInfo[];
}

interface ModelCatalog {
  sources: readonly CatalogSource[];
  remember(source: CatalogSource): void;
  forget(tabKey: string): void;
}

/** Model options told by this renderer's open Claude tabs, latest last. */
export const useClaudeModelCatalog = create<ModelCatalog>((set) => ({
  sources: [],
  remember: (source) =>
    set(({ sources }) => ({
      sources: [...sources.filter((s) => s.tabKey !== source.tabKey), source],
    })),
  forget: (tabKey) =>
    set((state) => {
      const sources = state.sources.filter((s) => s.tabKey !== tabKey);
      return sources.length === state.sources.length ? state : { sources };
    }),
}));

export function borrowedClaudeModels(catalog: ModelCatalog, profileKey: string, tabKey: string) {
  return catalog.sources.findLast((s) => s.profileKey === profileKey && s.tabKey !== tabKey)
    ?.models;
}

/** A profile's directory is resolved on the host where its program runs. */
export function claudeModelCatalogKey(workspaceId: string, profileId: string | undefined): string {
  const location = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId)?.location;
  const profile = profileOf(useAgentProfilesStore.getState().config, "claude", profileId);
  const directory = profileDirectory(profile, isWindows() && location?.kind === "local");
  return JSON.stringify([planUsageKey("claude", location, profileId), directory]);
}
