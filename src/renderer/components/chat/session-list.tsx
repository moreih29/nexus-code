// The folder's earlier sessions, under a new Claude tab's empty conversation:
// picking one goes on with it in this tab, or shows the tab that has it open.

import { History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { revealTabById } from "../../services/chat/open-beside";
import { useClaudeSessions, useSessionTabs } from "../../services/chat/sessions";
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
  onResume: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const sessions = useClaudeSessions(workspaceId, cwd, true);
  const openIn = useSessionTabs(workspaceId, tabId);
  const [all, setAll] = useState(false);
  if (!sessions || sessions.length === 0) return null;
  const shown = all ? sessions : sessions.slice(0, SHOWN_FIRST);
  const now = Date.now();
  return (
    <section
      className="mt-6 flex w-full max-w-[560px] flex-col gap-1 text-left"
      data-testid="chat-sessions"
    >
      <h3 className="flex items-center gap-1.5 px-2 text-app-label uppercase text-muted-foreground">
        <History className="size-3.5" />
        {t("chat.sessions.title")}
      </h3>
      <ul className="flex flex-col">
        {shown.map((session) => {
          const tab = openIn.get(session.sessionId);
          return (
            <li key={session.sessionId}>
              <button
                type="button"
                className="flex w-full items-baseline gap-3 rounded-(--radius-control) px-2 py-1.5 text-left hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
                title={session.firstPrompt ?? session.title}
                onClick={() =>
                  tab ? revealTabById(workspaceId, tab) : onResume(session.sessionId)
                }
              >
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
