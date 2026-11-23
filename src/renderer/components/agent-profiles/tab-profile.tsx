import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  DEFAULT_PROFILE_DIR,
  isDefaultProfileId,
  profileOf,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { statusSummary, useProfileStatusStore } from "../../services/agent-profiles/status";
import {
  defaultFolderLabel,
  resolveWorkspaceProfile,
  tildePath,
  useAgentProfilesStore,
} from "../../state/stores/agent-profiles";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { showToast } from "../ui/toast";
import { hasProfileChoice, ProfileDot, profileName } from "./profile-badge";
import { ProfileChipView } from "./profile-chip-view";
import { sourceLabel } from "./workspace-profile-menu";

export function TabProfileMark({
  agent,
  profileId,
  nameClassName,
}: {
  agent: ChatAgent;
  profileId?: string;
  nameClassName?: string;
}) {
  const { t } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  if (!hasProfileChoice(config, agent)) return null;
  const profile = profileOf(config, agent, profileId);
  const name = profileName(profile, t);
  return (
    <span
      className="flex max-w-24 shrink-0 items-center gap-1 text-app-micro text-muted-foreground"
      title={name}
      data-testid="tab-profile"
    >
      <ProfileDot color={profile.color} className="size-1.5" />
      <span className={cn("truncate", nameClassName)}>{name}</span>
    </span>
  );
}

export type TabUse = "empty" | "conversation" | "running";

export function ProfileUsageChip({
  agent,
  workspaceId,
  profileId,
  use,
  onSwitch,
  onContinue,
  compact = false,
}: {
  agent: ChatAgent;
  workspaceId: string;
  profileId?: string;
  use: TabUse;
  onSwitch: (profileId: string) => void;
  onContinue: (profileId: string) => void;
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
  const moving = useRef<string | null>(null);
  const movedTo = profile.id;
  const movedName = profileName(profile, t);
  useEffect(() => {
    if (moving.current !== movedTo) return;
    moving.current = null;
    showToast({ kind: "info", message: t("chat.profile.moved", { name: movedName }) });
  }, [movedTo, movedName, t]);
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

  const conversation = use !== "empty";
  const details = [
    ...(account ? [{ label: t("chat.profile.account"), value: account }] : []),
    { label: t("chat.profile.folder"), value: folder, mono: true },
    { label: t("chat.profile.rule"), value: rule },
  ];

  return (
    <ProfileChipView
      name={name}
      color={profile.color}
      details={details}
      others={others.map((other) => ({
        id: other.id,
        name: profileName(other, t),
        color: other.color,
      }))}
      conversation={conversation}
      busy={use === "running" ? "stops" : null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && local) void refresh(profile.id);
      }}
      onPick={(id, fresh) => {
        if (fresh) {
          onSwitch(id);
          return;
        }
        moving.current = id;
        onContinue(id);
      }}
      compact={compact}
      testIdPrefix="chat-profile"
    />
  );
}
