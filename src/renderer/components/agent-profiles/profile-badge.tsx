import type { TFunction } from "i18next";
import {
  type AgentProfile,
  type AgentProfiles,
  isDefaultProfileId,
  PROFILE_COLORS,
  type ProfileColor,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { cn } from "../../utils/cn";

const COLOR_VALUES: Record<ProfileColor, string> = {
  blue: "#4c8dff",
  violet: "#a77bf3",
  green: "#3fb27f",
  amber: "#e0a43a",
  rose: "#e8679a",
  cyan: "#2fb8c6",
  gray: "#8b949e",
};

export function profileColor(color: string): string {
  return COLOR_VALUES[
    (PROFILE_COLORS as readonly string[]).includes(color) ? (color as ProfileColor) : "gray"
  ];
}

export function profileName(profile: AgentProfile, t: TFunction): string {
  if (profile.name.trim() !== "") return profile.name;
  return isDefaultProfileId(profile.id)
    ? t("settings:profiles.default_name")
    : t("settings:profiles.unnamed");
}

export function hasProfileChoice(config: AgentProfiles, agent: ChatAgent): boolean {
  return profilesOf(config, agent).length > 1;
}

export function ProfileDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: profileColor(color) }}
    />
  );
}

export function ProfileChip({
  profile,
  t,
  className,
}: {
  profile: AgentProfile;
  t: TFunction;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[12rem] shrink-0 items-center gap-1 rounded-(--radius-pill) border border-border px-1.5 py-px text-app-micro text-muted-foreground",
        className,
      )}
      data-testid="profile-chip"
    >
      <ProfileDot color={profile.color} className="size-1.5" />
      <span className="truncate">{profileName(profile, t)}</span>
    </span>
  );
}
