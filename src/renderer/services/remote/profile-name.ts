/** A profile as the nexus command and another device name it. */

import { type AgentProfile, isDefaultProfileId } from "../../../shared/agent-profiles/profiles";

/** Its name, or "default" for the default one unnamed. */
export function cliProfileName(profile: AgentProfile): string {
  return profile.name.trim() || (isDefaultProfileId(profile.id) ? "default" : profile.id);
}
