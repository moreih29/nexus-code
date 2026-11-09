// The folder's earlier sessions, under a new Claude tab's empty conversation:
// picking one goes on with it in this tab, or shows the tab that has it open.
// They start folded behind one button, so an empty tab fits a small panel
// without a scrollbar over a list nobody asked to see. With more than one
// Claude profile, the sessions of every profile are listed, each marked with
// its own, and one taken up goes on in the profile that keeps it.

import { ChevronDown, ChevronUp, History } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { profilesOf } from "../../../shared/agent-profiles/profiles";
import { revealTabById } from "../../services/chat/open-beside";
import { useClaudeSessions, useSessionTabs } from "../../services/chat/sessions";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { cn } from "../../utils/cn";
import { ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { relativeTime } from "./message-list";

/** How many are shown before the rest are asked for. */
const SHOWN_FIRST = 6;

export function SessionList({
  workspaceId,
  tabId,
  cwd,
  onResume,
}: {
  workspaceId: string;
  tabId: string;
  cwd: string;
  onResume: (sessionId: string, profileId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const config = useAgentProfilesStore((s) => s.config);
  const profiles = useMemo(() => profilesOf(config, "claude"), [config]);
  const profileIds = useMemo(() => profiles.map((p) => p.id), [profiles]);
  const listed = useClaudeSessions(workspaceId, cwd, true, profileIds);
  const openIn = useSessionTabs(workspaceId, tabId);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  if (!listed || listed.length === 0) return null;
  // Profiles that keep sessions here: marks and a filter only when more than one does.
  const keeping = profiles.filter((p) => listed.some((s) => s.profileId === p.id));
  const marked = keeping.length > 1;
  const sessions = marked && only ? listed.filter((s) => s.profileId === only) : listed;
  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="mt-3 flex items-center gap-1.5 rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
        data-testid="chat-sessions-toggle"
      >
        <History className="size-3.5" />
        {t("chat.sessions.show", { count: sessions.length })}
        <ChevronDown className="size-3.5" />
      </button>
    );
  }
  const shown = all ? sessions : sessions.slice(0, SHOWN_FIRST);
  const now = Date.now();
  return (
    <section
      className="mt-3 flex w-full max-w-[560px] flex-col gap-1 text-left"
      data-testid="chat-sessions"
    >
      <h3 className="px-2 text-app-label uppercase text-muted-foreground">
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
      </h3>
      {marked && (
        <div className="flex flex-wrap gap-1 px-2 pb-1" data-testid="chat-sessions-profiles">
          {[null, ...keeping].map((profile) => {
            const id = profile?.id ?? null;
            return (
              <button
                key={id ?? "all"}
                type="button"
                aria-pressed={only === id}
                onClick={() => setOnly(id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-(--radius-pill) border px-2 py-px text-app-micro",
                  only === id
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
                onClick={() =>
                  tab
                    ? revealTabById(workspaceId, tab)
                    : onResume(session.sessionId, session.profileId)
                }
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
