/**
 * Settings › Claude and Settings › Codex: the agent's profiles, each a
 * config folder with its own sign-in. The default-folder profile comes
 * first and stays; the others are added, edited and deleted here. Each row
 * says who the profile is signed in as on this machine, and offers a sign-in
 * when it is not.
 */

import { ChevronRight, LogIn, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type AgentProfile,
  isDefaultProfileId,
  profilesOf,
} from "../../../../shared/agent-profiles/profiles";
import type { AgentProfileStatus } from "../../../../shared/agent-profiles/status";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { statusSummary, useProfileStatusStore } from "../../../services/agent-profiles/status";
import {
  defaultFolderLabel,
  tildePath,
  useAgentProfilesStore,
} from "../../../state/stores/agent-profiles";
import { ProfileDot, profileName } from "../../agent-profiles/profile-badge";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { SettingsGroup, SettingsPage } from "../section";
import { LoginDialog, ProfileDialog } from "./profile-dialog";

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:opacity-40",
);

const tagClass =
  "shrink-0 rounded-(--radius-pill) border border-border px-1.5 text-app-micro text-muted-foreground";

export function AgentProfilesPanel({
  agent,
  onNavigate,
}: {
  agent: ChatAgent;
  onNavigate?: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  const config = useAgentProfilesStore((s) => s.config);
  const removeProfile = useAgentProfilesStore((s) => s.removeProfile);
  const profiles = useMemo(() => profilesOf(config, agent), [config, agent]);
  const statuses = useProfileStatusStore((s) => s.byId);
  const refresh = useProfileStatusStore((s) => s.refresh);
  const [editing, setEditing] = useState<AgentProfile | "new" | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);

  const ids = profiles.map((p) => p.id).join(",");
  useEffect(() => {
    for (const id of ids.split(",")) void refresh(id);
  }, [ids, refresh]);

  const remove = async (profile: AgentProfile) => {
    const name = profileName(profile, t);
    const ok = await showConfirmDialog({
      title: t("profiles.removeConfirm.title", { name }),
      description: t("profiles.removeConfirm.description", { dir: profile.dir }),
      confirmLabel: t("profiles.removeConfirm.confirm"),
      variant: "destructive",
    });
    if (ok) removeProfile(profile.id);
  };

  return (
    <SettingsPage>
      <SettingsGroup
        title={t("profiles.heading")}
        description={t(`profiles.description.${agent}`)}
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
            {t("profiles.add")}
          </Button>
        }
      >
        <div className="flex flex-col gap-0.5" data-testid={`profiles-${agent}`}>
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              agent={agent}
              profile={profile}
              profiles={profiles}
              statuses={statuses}
              onRefresh={() => void refresh(profile.id)}
              onEdit={() => setEditing(profile)}
              onRemove={isDefaultProfileId(profile.id) ? undefined : () => void remove(profile)}
              onLogin={() => setLoggingIn(profile.id)}
            />
          ))}
        </div>
        {agent === "codex" && (
          <p className="text-app-ui-sm text-muted-foreground">{t("profiles.codexNote")}</p>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <button
          type="button"
          onClick={() => onNavigate?.("profile-rules")}
          className="flex w-full items-center justify-between gap-4 rounded-(--radius-control) border border-border px-3 py-2 text-left hover:bg-[var(--state-hover-bg)]"
          data-testid="profiles-rules-link"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-app-body text-foreground">{t("profiles.rulesLink.label")}</span>
            <span className="text-app-ui-sm text-muted-foreground">
              {t("profiles.rulesLink.description")}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </SettingsGroup>

      {editing !== null && (
        <ProfileDialog
          agent={agent}
          profile={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(id) => {
            setEditing(null);
            setLoggingIn(id);
          }}
        />
      )}
      {loggingIn !== null && (
        <LoginDialog
          profileId={loggingIn}
          agent={agent}
          onClose={() => {
            void refresh(loggingIn);
            setLoggingIn(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

function ProfileRow({
  agent,
  profile,
  profiles,
  statuses,
  onRefresh,
  onEdit,
  onRemove,
  onLogin,
}: {
  agent: ChatAgent;
  profile: AgentProfile;
  profiles: readonly AgentProfile[];
  statuses: Readonly<Record<string, { status?: AgentProfileStatus; loading: boolean }>>;
  onRefresh: () => void;
  onEdit: () => void;
  onRemove: (() => void) | undefined;
  onLogin: () => void;
}) {
  const { t } = useTranslation("settings");
  const name = profileName(profile, t);
  const isDefault = isDefaultProfileId(profile.id);
  const entry = statuses[profile.id];
  const shared = profile.shared?.length ?? 0;
  const defaultFolder = useAgentProfilesStore((s) => defaultFolderLabel(agent, s));
  const folder = isDefault ? defaultFolder : tildePath(profile.dir);

  return (
    <div
      className="flex items-center gap-3 rounded-(--radius-control) px-2 py-1.5 hover:bg-[var(--state-hover-bg)]"
      data-testid="profile-row"
    >
      <ProfileDot color={profile.color} className="size-2.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-app-body text-foreground">{name}</span>
          {isDefault && <span className={tagClass}>{t("profiles.defaultFolder")}</span>}
          {!isDefault && shared > 0 && (
            <span className={tagClass} title={profile.shared?.join(", ")}>
              {t("profiles.shared", { count: shared })}
            </span>
          )}
        </span>
        <span className="truncate font-mono text-app-micro text-muted-foreground" title={folder}>
          {folder}
        </span>
      </div>
      <ProfileStatusText
        agent={agent}
        profile={profile}
        profiles={profiles}
        statuses={statuses}
        onLogin={onLogin}
      />
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label={t("profiles.refresh")}
          title={t("profiles.refresh")}
          onClick={onRefresh}
          disabled={entry?.loading === true}
          className={iconButtonClass}
        >
          <RefreshCw
            className={cn("size-3.5", entry?.loading && "animate-spin")}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-label={t("profiles.edit", { name })}
          title={t("common:action.edit")}
          onClick={onEdit}
          className={iconButtonClass}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("profiles.remove", { name })}
          title={t("common:action.delete")}
          onClick={onRemove}
          disabled={!onRemove}
          className={cn(iconButtonClass, !onRemove && "invisible")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** What asks an agent who is signed in, as a row names it when it gives no answer. */
const STATUS_COMMAND: Record<ChatAgent, string> = {
  claude: "claude auth status",
  codex: "codex login status",
};

/** Who the profile is signed in as, or a sign-in button. */
export function ProfileStatusText({
  agent,
  profile,
  profiles,
  statuses,
  onLogin,
}: {
  agent: ChatAgent;
  profile: AgentProfile;
  profiles: readonly AgentProfile[];
  statuses: Readonly<Record<string, { status?: AgentProfileStatus; loading: boolean }>>;
  onLogin: () => void;
}) {
  const { t } = useTranslation("settings");
  const status = statuses[profile.id]?.status;
  if (!status) {
    return (
      <span className="shrink-0 text-app-ui-sm text-muted-foreground">
        {t("profiles.status.checking")}
      </span>
    );
  }
  if (status.state === "unavailable") {
    return (
      <span
        className="max-w-[14rem] shrink-0 truncate text-app-ui-sm text-muted-foreground"
        title={status.message}
      >
        {status.reason === "missing"
          ? t("profiles.status.unavailable", { program: agent })
          : status.reason === "no-answer"
            ? t("profiles.status.noAnswer", { command: STATUS_COMMAND[agent] })
            : t("profiles.status.unchecked")}
      </span>
    );
  }
  if (status.state === "signed-out") {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
          {t("profiles.status.signedOut")}
        </span>
        <Button variant="outline" size="sm" onClick={onLogin}>
          <LogIn aria-hidden="true" />
          {t("profiles.login")}
        </Button>
      </span>
    );
  }
  const { text, title } = statusSummary(agent, status, {
    personal: t("profiles.status.personalOrg"),
    apiKey: t("profiles.status.apiKey"),
    signedIn: t("profiles.status.signedIn"),
  });
  const twin = twinOf(agent, profile, profiles, statuses);
  return (
    <span className="flex min-w-0 shrink-0 flex-col items-end">
      <span
        className="max-w-[14rem] truncate text-app-ui-sm text-foreground"
        title={title || undefined}
      >
        {text}
      </span>
      {twin && (
        <span className="text-app-micro text-[var(--state-warning-fg)]">
          {t(agent === "claude" ? "profiles.status.sameOrg" : "profiles.status.sameAccount", {
            name: profileName(twin, t),
          })}
        </span>
      )}
    </span>
  );
}

/**
 * An earlier profile signed in to the same Claude organization, or the same
 * ChatGPT account: two profiles that only split the history, not the usage.
 */
export function twinOf(
  agent: ChatAgent,
  profile: AgentProfile,
  profiles: readonly AgentProfile[],
  statuses: Readonly<Record<string, { status?: AgentProfileStatus }>>,
): AgentProfile | undefined {
  const mine = statuses[profile.id]?.status;
  if (mine?.state !== "signed-in") return undefined;
  const key = agent === "claude" ? mine.orgId : mine.accountId;
  if (!key) return undefined;
  for (const other of profiles) {
    if (other.id === profile.id) return undefined;
    const theirs = statuses[other.id]?.status;
    if (theirs?.state !== "signed-in") continue;
    if ((agent === "claude" ? theirs.orgId : theirs.accountId) === key) return other;
  }
  return undefined;
}
