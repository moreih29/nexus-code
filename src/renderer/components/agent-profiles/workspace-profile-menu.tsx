// A workspace's "Agent profiles ›" submenu in the sidebar: for each agent,
// "Follow rules" (with the profile the rules give now) or a profile of its
// own, which makes a rule for the workspace. New conversations take it.

import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentProfiles,
  PROFILE_AGENTS,
  type ProfileSource,
  profilesOf,
  resolveProfile,
  ruleOfTarget,
} from "../../../shared/agent-profiles/profiles";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { useProfileStatusStore } from "../../services/agent-profiles/status";
import {
  matchOptions,
  profileWorkspace,
  tildePath,
  useAgentProfilesStore,
} from "../../state/stores/agent-profiles";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  ContextMenuAction,
  ContextMenuChoice,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../ui/context-menu";
import { ProfileDot, profileName } from "./profile-badge";

const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;

/** Where a profile the rules give comes from, in a few words. */
export function sourceLabel(
  source: ProfileSource,
  config: AgentProfiles,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (source.kind === "default") return t("chat.profile.source.default");
  const rule = config.rules.find((r) => r.id === source.ruleId);
  const target = rule?.target;
  if (target?.kind === "folder")
    return t("chat.profile.source.folder", { path: tildePath(target.path) });
  if (target?.kind === "ssh") return t("chat.profile.source.ssh", { host: target.host });
  return t("chat.profile.source.workspace");
}

export function WorkspaceProfileMenu({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const setRule = useAgentProfilesStore((s) => s.setRule);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const statuses = useProfileStatusStore((s) => s.byId);
  const target = useMemo(
    () => ({ kind: "workspace" as const, workspaceId: workspace.id }),
    [workspace.id],
  );
  const own = ruleOfTarget(config, target);
  // What the rules give with the workspace's own rule left out.
  const withoutOwn = useMemo(
    () => (own ? { ...config, rules: config.rules.filter((r) => r.id !== own.id) } : config),
    [config, own],
  );
  const subject = profileWorkspace(workspace, workspaces);
  const options = matchOptions();
  const local = workspace.location.kind === "local";

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <span>{t("sidebar.agent_profiles")}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {PROFILE_AGENTS.map((agent, i) => {
          const chosen = own?.[agent];
          const inherited = resolveProfile(withoutOwn, agent, subject, options);
          return (
            <Fragment key={agent}>
              {i > 0 && <ContextMenuSeparator />}
              <ContextMenuLabel>{AGENT_NAMES[agent]}</ContextMenuLabel>
              <ContextMenuChoice
                checked={chosen === undefined}
                onSelect={() => setRule(target, agent, null)}
                note={`${profileName(inherited.profile, t)} · ${sourceLabel(inherited.source, withoutOwn, t)}`}
              >
                {t("sidebar.follow_rules")}
              </ContextMenuChoice>
              {profilesOf(config, agent).map((profile) => {
                const signedOut = local && statuses[profile.id]?.status?.state === "signed-out";
                return (
                  <ContextMenuChoice
                    key={profile.id}
                    checked={chosen === profile.id}
                    onSelect={() => setRule(target, agent, profile.id)}
                    note={signedOut ? t("tabBar.profile_signed_out") : undefined}
                    noteClassName="ml-4 text-[var(--state-warning-fg)]"
                  >
                    <ProfileDot color={profile.color} />
                    <span className="truncate">{profileName(profile, t)}</span>
                  </ContextMenuChoice>
                );
              })}
            </Fragment>
          );
        })}
        <ContextMenuSeparator />
        <ContextMenuAction
          onSelect={() => useSettingsUIStore.getState().openSettingsAt("profile-rules")}
        >
          <span>{t("sidebar.profile_rules_settings")}</span>
        </ContextMenuAction>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
