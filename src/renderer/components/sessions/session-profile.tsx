// A conversation's profile in the agents tab: the one its tab runs with,
// for a Claude or Codex tab; none for a terminal's agent, whose profile the
// app does not know.

import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import type { AgentSession } from "../../services/sessions/model";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { hasProfileChoice } from "../agent-profiles/profile-badge";
import { TabProfileMark } from "../agent-profiles/tab-profile";

/** The profile id the session's tab runs with; undefined for its agent's default, or a terminal. */
export function useTabProfileId(session: AgentSession): string | undefined {
  return useTabsStore((s) => {
    const tab = s.byWorkspace[session.workspaceId]?.[session.tabId];
    return tab?.type === "claude" || tab?.type === "codex" ? tab.props.profileId : undefined;
  });
}

/**
 * The session's profile, when its agent has more than its default one to
 * tell it from; undefined for a terminal's agent.
 */
export function useSessionProfile(session: AgentSession): AgentProfile | undefined {
  const profileId = useTabProfileId(session);
  const config = useAgentProfilesStore((s) => s.config);
  if (session.kind === "terminal" || !hasProfileChoice(config, session.kind)) return undefined;
  return profileOf(config, session.kind, profileId);
}

/** The profile's dot and name, as the session's tab shows them. */
export function SessionProfileMark({ session }: { session: AgentSession }) {
  const profileId = useTabProfileId(session);
  if (session.kind === "terminal") return null;
  return <TabProfileMark agent={session.kind} profileId={profileId} />;
}
