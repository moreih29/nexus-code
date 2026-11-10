// The folder's earlier sessions, for a tab to go on with one: under a new
// tab's empty conversation, or above the composer for /resume. Picking one
// goes on with it in this tab, or shows the tab that has it open.
// Under an empty conversation they start folded behind one button, so an
// empty tab fits a small panel without a scrollbar over a list nobody
// asked to see. The tab's own profile's sessions come first: with more
// than one profile keeping sessions here, the others, or all of them, are
// a click away, each marked with its own, and one taken up goes on in the
// profile that keeps it.

import { ChevronDown, ChevronUp, History, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { profilesOf } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { CodexController } from "../../services/chat/codex-controller";
import { revealTabById } from "../../services/chat/open-beside";
import {
  type ListedSession,
  sessionMatches,
  useClaudeSessions,
  useCodexThreadTabs,
  useSessionTabs,
} from "../../services/chat/sessions";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { cn } from "../../utils/cn";
import { ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { IconButton } from "../ui/icon-button";
import { relativeTime } from "./message-list";

/** How many are shown before the rest are asked for. */
const SHOWN_FIRST = 6;

interface ListProps {
  workspaceId: string;
  tabId: string;
  /** The tab's profile, whose sessions are shown first. */
  profileId: string;
  /** The title goes with it, for a tab that names itself from it. */
  onResume: (sessionId: string, profileId: string, title: string) => void;
  /** Words a session's title or first prompt has (/resume's). */
  query?: string;
  /** Shown open, with a button that closes it (/resume); folded under an empty conversation. */
  onClose?: () => void;
  /** The tab's own session, left out. */
  exceptSessionId?: string;
}

/** A Claude tab's: the sessions every Claude profile keeps of the folder. */
export function SessionList(props: ListProps & { cwd: string }) {
  const config = useAgentProfilesStore((s) => s.config);
  const profileIds = useMemo(() => profilesOf(config, "claude").map((p) => p.id), [config]);
  const listed = useClaudeSessions(props.workspaceId, props.cwd, true, profileIds);
  const openIn = useSessionTabs(props.workspaceId, props.tabId);
  return <SessionPicker {...props} agent="claude" listed={listed} openIn={openIn} />;
}

/** A Codex tab's: the threads its profile's Codex keeps of the folder. */
export function CodexSessionList(props: ListProps & { controller: CodexController }) {
  const { controller, profileId } = props;
  const [listed, setListed] = useState<ListedSession[] | null>(null);
  useEffect(() => {
    let live = true;
    controller.listThreads().then(
      (threads) => live && setListed(threads.map((thread) => ({ ...thread, profileId }))),
      () => live && setListed([]),
    );
    return () => {
      live = false;
    };
  }, [controller, profileId]);
  const openIn = useCodexThreadTabs(props.workspaceId, props.tabId);
  return <SessionPicker {...props} agent="codex" listed={listed} openIn={openIn} />;
}

function SessionPicker({
  agent,
  listed,
  openIn,
  workspaceId,
  profileId,
  onResume,
  query,
  onClose,
  exceptSessionId,
}: ListProps & {
  agent: ChatAgent;
  /** Null until read. */
  listed: readonly ListedSession[] | null;
  /** The tabs that have a session open, by its id. */
  openIn: ReadonlyMap<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const profiles = useMemo(() => profilesOf(config, agent), [config, agent]);
  const picking = onClose !== undefined;
  const [open, setOpen] = useState(picking);
  const [all, setAll] = useState(false);
  // Undefined until a profile is picked: the tab's.
  const [only, setOnly] = useState<string | null | undefined>(undefined);
  const here = (listed ?? []).filter(
    (s) => s.sessionId !== exceptSessionId && sessionMatches(s, query),
  );
  // Profiles that keep sessions here: marks and a choice only when another than the tab's does.
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
        className="mt-3 flex items-center gap-1.5 rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
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
            <span className="flex flex-1 items-center gap-1.5">
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
                  "inline-flex items-center gap-1 rounded-(--radius-pill) border px-2 py-px text-app-micro",
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
          return (
            <li key={session.sessionId}>
              <button
                type="button"
                className="flex w-full items-baseline gap-3 rounded-(--radius-control) px-2 py-1.5 text-left hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
                title={session.firstPrompt ?? session.title}
                onClick={() => {
                  if (!tab) return onResume(session.sessionId, session.profileId, session.title);
                  revealTabById(workspaceId, tab);
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
                <span className="shrink-0 truncate text-app-micro text-muted-foreground">
                  {[
                    tab ? t("chat.sessions.open") : undefined,
                    session.gitBranch,
                    relativeTime(session.lastModified, now, i18n.language, t("chat.time.now")),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
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
