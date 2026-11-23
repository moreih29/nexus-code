import { ChevronDown, ChevronUp, History, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentProfile, profilesOf } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { formatBytes } from "../../../shared/util/format-bytes";
import { deleteClaudeSession, useClaudeSessions } from "../../services/chat/claude/sessions";
import type { CodexController } from "../../services/chat/codex/controller";
import { revealTabById } from "../../services/chat/open-beside";
import {
  type ListedSession,
  sessionMatches,
  useCodexThreadTabs,
  useSessionTabs,
  withTranscriptSizes,
} from "../../services/chat/sessions";
import { codexThreads } from "../../services/remote/history";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { cn } from "../../utils/cn";
import { relativeTime } from "../../utils/time-format";
import { ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";

const SHOWN_FIRST = 6;

interface ListProps {
  workspaceId: string;
  tabId: string;
  profileId: string;
  onResume: (sessionId: string, profileId: string, title: string) => void;
  query?: string;
  onClose?: () => void;
  exceptSessionId?: string;
}

type DeleteSession = (session: ListedSession) => Promise<void>;

const CONFIRM_BUTTON_CLASS =
  "h-6 shrink-0 whitespace-nowrap px-2 text-app-ui-sm focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/60";

export function SessionList(props: ListProps & { cwd: string }) {
  const config = useAgentProfilesStore((s) => s.config);
  const profileIds = useMemo(() => profilesOf(config, "claude").map((p) => p.id), [config]);
  const listed = useClaudeSessions(props.workspaceId, props.cwd, true, profileIds);
  const openIn = useSessionTabs(props.workspaceId, props.tabId);
  return (
    <SessionPicker
      {...props}
      agent="claude"
      listed={listed}
      openIn={openIn}
      onDelete={(session) => deleteClaudeSession(props.workspaceId, props.cwd, session)}
    />
  );
}

export function CodexSessionList(props: ListProps & { controller: CodexController; cwd: string }) {
  const { controller, profileId, workspaceId, cwd } = props;
  const config = useAgentProfilesStore((s) => s.config);
  const profileIds = useMemo(() => profilesOf(config, "codex").map((p) => p.id), [config]);
  const [listed, setListed] = useState<ListedSession[] | null>(null);
  useEffect(() => {
    let live = true;
    void codexThreads(workspaceId, cwd, profileIds, controller).then(
      (sessions) => {
        if (!live) return;
        setListed(sessions);
        withTranscriptSizes(workspaceId, sessions).then(
          (sized) => live && setListed(sized),
          () => {},
        );
      },
      () => live && setListed([]),
    );
    return () => {
      live = false;
    };
  }, [controller, workspaceId, cwd, profileIds]);
  const openIn = useCodexThreadTabs(props.workspaceId, props.tabId);
  return (
    <SessionPicker
      {...props}
      agent="codex"
      listed={listed}
      openIn={openIn}
      onDelete={(session) => controller.deleteThread(session.sessionId)}
      canDelete={(session) => session.profileId === profileId}
    />
  );
}

export function SessionPicker({
  agent,
  listed,
  openIn,
  workspaceId,
  profileId,
  onResume,
  query,
  onClose,
  exceptSessionId,
  onDelete,
  canDelete,
  profiles: theirProfiles,
  onShowTab,
}: ListProps & {
  agent: ChatAgent;
  listed: readonly ListedSession[] | null;
  openIn: ReadonlyMap<string, string>;
  onDelete?: DeleteSession;
  canDelete?: (session: ListedSession) => boolean;
  profiles?: readonly AgentProfile[];
  onShowTab?: (tabId: string, session: ListedSession) => void;
}) {
  const { t, i18n } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const own = useMemo(() => profilesOf(config, agent), [config, agent]);
  const profiles = theirProfiles ?? own;
  const picking = onClose !== undefined;
  const [open, setOpen] = useState(picking);
  const [all, setAll] = useState(false);
  const [only, setOnly] = useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const here = (listed ?? []).filter(
    (s) => s.sessionId !== exceptSessionId && !deleted.has(s.sessionId) && sessionMatches(s, query),
  );
  const ask = (sessionId: string | null) => {
    setConfirming(sessionId);
    setFailed(null);
  };
  const remove = async (session: ListedSession) => {
    if (!onDelete) return;
    setDeleting(true);
    setFailed(null);
    try {
      await onDelete(session);
      setDeleted((prev) => new Set(prev).add(session.sessionId));
      setConfirming(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFailed(t("chat.sessions.delete_failed", { message }));
    } finally {
      setDeleting(false);
    }
  };
  const keeping = profiles.filter((p) => here.some((s) => s.profileId === p.id));
  const marked = keeping.some((p) => p.id !== profileId);
  const choices = marked
    ? profiles.filter((p) => p.id === profileId || keeping.some((k) => k.id === p.id))
    : [];
  const shownProfile = marked ? (only === undefined ? profileId : only) : null;
  const sessions = shownProfile ? here.filter((s) => s.profileId === shownProfile) : here;

  if (!picking && (!listed || here.length === 0)) return null;
  if (!open) {
    const others = sessions.length === 0;
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="mt-3 flex max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
        data-testid="chat-sessions-toggle"
      >
        <History className="size-3.5" />
        {others
          ? t("chat.sessions.show_others", { count: here.length })
          : t("chat.sessions.show", { count: sessions.length })}
        <ChevronDown className="size-3.5" />
      </button>
    );
  }
  const shown = all ? sessions : sessions.slice(0, SHOWN_FIRST);
  const now = Date.now();
  return (
    <section
      className={cn(
        "flex w-full flex-col gap-1 text-left",
        picking
          ? "rounded-(--radius-control) border border-border bg-background p-1"
          : "mt-3 max-w-[560px]",
      )}
      data-testid="chat-sessions"
    >
      <h3 className="flex items-center px-2 text-app-label uppercase text-muted-foreground">
        {picking ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
              <History className="size-3.5" />
              {query ? t("chat.sessions.title_query", { query }) : t("chat.sessions.title")}
            </span>
            <IconButton label={t("action.close")} size="sm" onClick={onClose}>
              <X className="size-3.5" />
            </IconButton>
          </>
        ) : (
          <button
            type="button"
            aria-expanded
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 rounded-(--radius-control) hover:text-foreground"
          >
            <History className="size-3.5" />
            {t("chat.sessions.title")}
            <ChevronUp className="size-3.5" />
          </button>
        )}
      </h3>
      {marked && (
        <div className="flex flex-wrap gap-1 px-2 pb-1" data-testid="chat-sessions-profiles">
          {[...choices, null].map((profile) => {
            const id = profile?.id ?? null;
            return (
              <button
                key={id ?? "all"}
                type="button"
                aria-pressed={shownProfile === id}
                onClick={() => setOnly(id)}
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap rounded-(--radius-pill) border px-2 py-px text-app-micro",
                  shownProfile === id
                    ? "border-foreground/40 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {profile && <ProfileDot color={profile.color} className="size-1.5" />}
                {profile ? profileName(profile, t) : t("chat.sessions.all_profiles")}
              </button>
            );
          })}
        </div>
      )}
      {sessions.length === 0 && (
        <div className="px-2 py-1.5 text-app-ui-sm text-muted-foreground">
          {listed === null
            ? t("chat.sessions.loading")
            : here.length > 0
              ? t("chat.sessions.none_in_profile")
              : t("chat.sessions.none")}
        </div>
      )}
      <ul className="flex flex-col">
        {shown.map((session) => {
          const tab = openIn.get(session.sessionId);
          const profile = marked ? profiles.find((p) => p.id === session.profileId) : undefined;
          if (confirming === session.sessionId) {
            return (
              <li key={session.sessionId} className="flex items-center gap-1">
                <fieldset
                  aria-label={t("chat.sessions.delete")}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-(--radius-control) bg-destructive/10 px-2 py-1"
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.stopPropagation();
                    ask(null);
                  }}
                  data-testid="chat-session-delete-confirm"
                >
                  <span className="min-w-20 flex-1">
                    <span className="block truncate text-app-body text-foreground">
                      {session.title}
                    </span>
                    <span
                      className={cn(
                        "block text-app-micro",
                        failed
                          ? "line-clamp-2 break-all text-destructive"
                          : "text-muted-foreground",
                      )}
                      title={failed ?? undefined}
                    >
                      {failed ?? t("chat.sessions.delete_hint")}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={CONFIRM_BUTTON_CLASS}
                    disabled={deleting}
                    onClick={() => ask(null)}
                  >
                    {t("action.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className={CONFIRM_BUTTON_CLASS}
                    autoFocus
                    disabled={deleting}
                    onClick={() => void remove(session)}
                  >
                    {deleting ? t("chat.sessions.deleting") : t("action.delete")}
                  </Button>
                </fieldset>
                <span aria-hidden className="size-6 shrink-0" />
              </li>
            );
          }
          return (
            <li key={session.sessionId} className="group flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-baseline gap-3 rounded-(--radius-control) px-2 py-1.5 text-left hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
                title={session.firstPrompt ?? session.title}
                onClick={() => {
                  if (!tab) return onResume(session.sessionId, session.profileId, session.title);
                  if (onShowTab) onShowTab(tab, session);
                  else revealTabById(workspaceId, tab);
                  onClose?.();
                }}
              >
                {profile && (
                  <span title={profileName(profile, t)} className="self-center">
                    <ProfileDot color={profile.color} />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-app-body text-foreground">
                  {session.title}
                </span>
                <span className="min-w-0 max-w-[50%] shrink truncate text-app-micro text-muted-foreground">
                  {[
                    tab ? t("chat.sessions.open") : undefined,
                    session.gitBranch,
                    session.size !== undefined ? formatBytes(session.size) : undefined,
                    relativeTime(session.lastModified, now, i18n.language),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
              {onDelete &&
                (canDelete?.(session) ?? true) &&
                (tab ? (
                  <span aria-hidden className="size-6 shrink-0" />
                ) : (
                  <IconButton
                    label={t("chat.sessions.delete")}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => ask(session.sessionId)}
                    data-testid="chat-session-delete"
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                ))}
            </li>
          );
        })}
      </ul>
      {!all && sessions.length > SHOWN_FIRST && (
        <button
          type="button"
          className="self-start rounded-(--radius-control) px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          onClick={() => setAll(true)}
        >
          {t("chat.sessions.more", { count: sessions.length - SHOWN_FIRST })}
        </button>
      )}
    </section>
  );
}
