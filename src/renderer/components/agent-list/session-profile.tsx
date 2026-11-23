import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import type { AgentSession } from "../../services/agent-sessions/model";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { hasProfileChoice } from "../agent-profiles/profile-badge";
import { TabProfileMark } from "../agent-profiles/tab-profile";

export function useTabProfileId(session: AgentSession): string | undefined {
  return useTabsStore((s) => {
    const tab = s.byWorkspace[session.workspaceId]?.[session.tabId];
    return tab?.type === "claude" || tab?.type === "codex" ? tab.props.profileId : undefined;
  });
}

export function useSessionProfile(session: AgentSession): AgentProfile | undefined {
  const profileId = useTabProfileId(session);
  const config = useAgentProfilesStore((s) => s.config);
  if (session.kind === "terminal" || !hasProfileChoice(config, session.kind)) return undefined;
  return profileOf(config, session.kind, profileId);
}

export function SessionProfileMark({
  session,
  nameClassName,
}: {
  session: AgentSession;
  nameClassName?: string;
}) {
  const profileId = useTabProfileId(session);
  if (session.kind === "terminal") return null;
  return (
    <TabProfileMark agent={session.kind} profileId={profileId} nameClassName={nameClassName} />
  );
}
