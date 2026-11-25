import { CLAUDE_MODEL_ALIASES } from "../../../shared/agent-profiles/behavior";
import { profileDirectory } from "../../../shared/agent-profiles/env";
import {
  type AgentProfile,
  type AgentProfiles,
  defaultProfileId,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { RecordingSummarySettings } from "../../../shared/notes/summary";
import { isWindows } from "../../utils/platform";
import { claudeModelLabel } from "../chat/claude/settings-defaults";
import type { ModelInfo } from "../chat/model";
import { planUsageKey } from "../chat/plan-usage";

export interface SummaryModel {
  readonly value: string;
  readonly displayName?: string;
}

const FALLBACK_MODELS: readonly SummaryModel[] = CLAUDE_MODEL_ALIASES.map((value) => ({
  value,
  displayName: claudeModelLabel(value),
}));

export function summaryProfile(config: AgentProfiles, settings: RecordingSummarySettings) {
  const profiles = profilesOf(config, "claude");
  const defaultId = defaultProfileId("claude");
  const profileId = settings.profileId ?? defaultId;
  const profile = profiles.find(({ id }) => id === profileId);
  return { profiles, defaultId, profileId, profile };
}

export function summaryCatalogKey(profileId: string, profile: AgentProfile | undefined): string {
  return JSON.stringify([
    planUsageKey("claude", undefined, profileId),
    profile ? profileDirectory(profile, isWindows()) : "",
  ]);
}

export function summaryModels(
  profile: AgentProfile | undefined,
  discovered: readonly ModelInfo[] | undefined,
) {
  const custom = profile?.connection?.method === "custom" ? profile.connection : undefined;
  const models: readonly SummaryModel[] = custom
    ? custom.models.map(({ id, label }) => ({ value: id, displayName: label || id }))
    : (discovered ?? FALLBACK_MODELS);
  const defaultLabel = custom
    ? models.find(({ value }) => value === custom.defaultModel)?.displayName
    : models.find(({ value }) => value === "default")?.displayName;
  const choices = models.filter(({ value }) => custom || value !== "default");
  return { custom, models, defaultLabel, choices };
}
