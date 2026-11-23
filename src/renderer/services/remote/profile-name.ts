import { type AgentProfile, isDefaultProfileId } from "../../../shared/agent-profiles/profiles";

export function cliProfileName(profile: AgentProfile): string {
  return profile.name.trim() || (isDefaultProfileId(profile.id) ? "default" : profile.id);
}
