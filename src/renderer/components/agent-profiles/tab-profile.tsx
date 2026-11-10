// What a chat tab shows of its profile: its dot and name after the tab's
// title, and under the composer a chip that tells the account, the folder
// and the rule that gave it, and opens a conversation with another profile;
// in a narrow tab the chip is the dot alone, its name told on hover.
// Neither shows while the agent has only its default profile.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PROFILE_DIR,
  isDefaultProfileId,
  profileOf,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { statusSummary, useProfileStatusStore } from "../../services/agent-profiles/status";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import {
  defaultFolderLabel,
  resolveWorkspaceProfile,
  tildePath,
  useAgentProfilesStore,
} from "../../state/stores/agent-profiles";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Popover } from "../ui/popover";
import { tooltipProps } from "../ui/tooltip";
import { hasProfileChoice, ProfileDot, profileName } from "./profile-badge";
import { sourceLabel } from "./workspace-profile-menu";

export function TabProfileMark({ agent, profileId }: { agent: ChatAgent; profileId?: string }) {
  const { t } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  if (!hasProfileChoice(config, agent)) return null;
  const profile = profileOf(config, agent, profileId);
  return (
    <span
      className="flex max-w-24 shrink-0 items-center gap-1 text-app-micro text-muted-foreground"
      data-testid="tab-profile"
    >
      <ProfileDot color={profile.color} className="size-1.5" />
      <span className="truncate">{profileName(profile, t)}</span>
    </span>
  );
}

export function ProfileUsageChip({
  agent,
  workspaceId,
  cwd,
  profileId,
  compact = false,
}: {
  agent: ChatAgent;
  workspaceId: string;
  cwd: string;
  profileId?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const localDefault = useAgentProfilesStore((s) => defaultFolderLabel(agent, s));
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const statuses = useProfileStatusStore((s) => s.byId);
  const refresh = useProfileStatusStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const profile = profileOf(config, agent, profileId);
  const resolved = useMemo(
    () => (workspace ? resolveWorkspaceProfile(agent, workspace, workspaces, config) : null),
    [agent, workspace, workspaces, config],
  );
  if (!hasProfileChoice(config, agent)) return null;
  const local = workspace?.location.kind === "local";
  const status = local ? statuses[profile.id]?.status : undefined;
  const account =
    status?.state === "signed-in"
      ? statusSummary(agent, status, {
          personal: t("settings:profiles.status.personalOrg"),
          apiKey: t("settings:profiles.status.apiKey"),
          signedIn: t("settings:profiles.status.signedIn"),
        }).text
      : status?.state === "signed-out"
        ? t("tabBar.profile_signed_out")
        : undefined;
  // An SSH host's default folder is its own, which only its agent knows.
  const folder = isDefaultProfileId(profile.id)
    ? local
      ? localDefault
      : DEFAULT_PROFILE_DIR[agent]
    : tildePath(profile.dir);
  const rule =
    resolved && resolved.profile.id === profile.id
      ? sourceLabel(resolved.source, config, t)
      : t("chat.profile.source.chosen");
  const others = profilesOf(config, agent).filter((p) => p.id !== profile.id);
  const name = profileName(profile, t);

  const openWith = (id: string) => {
    setOpen(false);
    const props = { cwd, profileId: id };
    if (agent === "claude") openClaudeTab(workspaceId, props);
    else openCodexTab(workspaceId, props);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && local) void refresh(profile.id);
      }}
      label={t("chat.profile.title")}
      side="top"
      align="end"
      className="w-72"
      testId="chat-profile-popover"
      trigger={
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1 hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          data-testid="chat-profile-chip"
          {...(compact ? { "aria-label": name, ...tooltipProps(name) } : {})}
        >
          <ProfileDot color={profile.color} className="size-1.5" />
          {!compact && <span className="max-w-28 truncate">{name}</span>}
        </button>
      }
    >
      <div className="flex flex-col gap-2 px-2 py-1.5 text-app-ui-sm">
        <div className="flex items-center gap-1.5 text-app-body text-foreground">
          <ProfileDot color={profile.color} />
          <span className="truncate">{name}</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {account && (
            <>
              <dt className="text-muted-foreground">{t("chat.profile.account")}</dt>
              <dd className="truncate">{account}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("chat.profile.folder")}</dt>
          <dd className="truncate font-mono" title={folder}>
            {folder}
          </dd>
          <dt className="text-muted-foreground">{t("chat.profile.rule")}</dt>
          <dd className="truncate">{rule}</dd>
        </dl>
        <p className="text-muted-foreground">{t("chat.profile.locked")}</p>
        {others.length > 0 && (
          <div className="flex flex-col border-t border-border pt-1.5">
            <span className="pb-0.5 text-app-micro text-muted-foreground">
              {t("chat.profile.newWith")}
            </span>
            {others.map((other) => (
              <button
                key={other.id}
                type="button"
                onClick={() => openWith(other.id)}
                className="-mx-1 flex items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-left hover:bg-[var(--state-hover-bg)]"
              >
                <ProfileDot color={other.color} />
                <span className="truncate">{profileName(other, t)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
