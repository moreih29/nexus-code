// The tab bar's "New Claude conversation" and "New Codex conversation"
// items: with more than the default profile, the item shows the profile the
// workspace gives, and a submenu opens one with another profile.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { profilesOf } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { statusSummary, useProfileStatusStore } from "../../services/agent-profiles/status";
import { resolveWorkspaceProfile, useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { ProfileChip, ProfileDot, profileName } from "./profile-badge";

export function NewChatMenuItems({
  workspaceId,
  agent,
  onOpen,
}: {
  workspaceId: string;
  agent: ChatAgent;
  onOpen: (profileId?: string) => void;
}) {
  const { t } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const statuses = useProfileStatusStore((s) => s.byId);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const profiles = useMemo(() => profilesOf(config, agent), [config, agent]);
  const resolved = useMemo(
    () =>
      workspace ? resolveWorkspaceProfile(agent, workspace, workspaces, config).profile : null,
    [agent, workspace, workspaces, config],
  );
  const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
  const choice = profiles.length > 1;
  // What Settings last read of each sign-in is this machine's: a local workspace's.
  const local = workspace?.location.kind === "local";

  return (
    <>
      <DropdownMenuItem onSelect={() => onOpen()}>
        <Icon aria-hidden className="size-3.5 mr-1.5 shrink-0" />
        <span className="flex-1">
          {t(agent === "claude" ? "tabBar.new_claude" : "tabBar.new_codex")}
        </span>
        {choice && resolved && <ProfileChip profile={resolved} t={t} className="ml-3" />}
      </DropdownMenuItem>
      {choice && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon aria-hidden className="size-3.5 mr-1.5 shrink-0" />
            <span className="flex-1">
              {t(agent === "claude" ? "tabBar.new_claude_with" : "tabBar.new_codex_with")}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {profiles.map((profile) => {
              const status = local ? statuses[profile.id]?.status : undefined;
              const note =
                profile.id === resolved?.id
                  ? t("tabBar.profile_here")
                  : status?.state === "signed-out"
                    ? t("tabBar.profile_signed_out")
                    : status?.state === "signed-in"
                      ? statusSummary(agent, status, {
                          personal: t("settings:profiles.status.personalOrg"),
                          apiKey: t("settings:profiles.status.apiKey"),
                          signedIn: t("settings:profiles.status.signedIn"),
                        }).text
                      : undefined;
              return (
                <DropdownMenuItem key={profile.id} onSelect={() => onOpen(profile.id)}>
                  <span className="flex flex-1 items-center gap-2">
                    <ProfileDot color={profile.color} />
                    {profileName(profile, t)}
                  </span>
                  {note && (
                    <span
                      className={
                        status?.state === "signed-out" && profile.id !== resolved?.id
                          ? "ml-4 text-[var(--state-warning-fg)]"
                          : "ml-4 text-muted-foreground"
                      }
                    >
                      {note}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => useSettingsUIStore.getState().openSettingsAt(agent)}>
              <span className="flex-1">{t("tabBar.manage_profiles")}</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </>
  );
}
