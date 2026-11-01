// Sessions tab — detail panel: the chosen session's state, what it was asked
// and last said, its terminal's screen, and its worktree's changes, with
// the actions on it. A worktree with no session shows its changes alone.
//
// A permission request is answered in the terminal, not here: the panel
// does not press keys in a Claude Code dialog on the user's behalf.

import { GitBranch } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";
import {
  interrupt,
  removeTask,
  sendLine,
  showChanges,
  showTerminal,
} from "../../services/sessions/actions";
import {
  type AgentSession,
  allSessions,
  type SessionFamily,
  type WorktreeEntry,
} from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { getTerminalController } from "../../services/terminal/terminal-registry";
import { Button } from "../ui/button";
import type { SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

const SCREEN_LINES = 20;
const SCREEN_POLL_MS = 1_000;
const FILES_SHOWN = 50;

interface SessionDetailProps {
  family: SessionFamily;
  selection: SessionsSelection;
  changes: ReadonlyMap<string, WorktreeChanges>;
  now: number;
  visible: boolean;
}

export function SessionDetail({ family, selection, changes, now, visible }: SessionDetailProps) {
  const { t } = useTranslation();
  const session =
    selection.kind === "session"
      ? allSessions(family).find((s) => s.key === selection.key)
      : undefined;
  const workspaceId =
    session?.workspaceId ?? (selection.kind === "worktree" ? selection.workspaceId : "");
  const worktree = family.worktrees.find((w) => w.workspace.id === workspaceId);
  if (!worktree) return null;
  const worktreeChanges = changes.get(worktree.workspace.id);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <DetailHeader worktree={worktree} branch={worktree.branch ?? worktreeChanges?.branch}>
        {session && (
          <span className="flex min-w-0 items-center gap-2">
            <AgentBadge agent={session.agent} />
            <SessionState session={session} now={now} />
          </span>
        )}
      </DetailHeader>
      <DetailActions worktree={worktree} session={session} />
      {session ? (
        <SessionBody session={session} visible={visible} />
      ) : (
        <p className="text-app-ui-sm text-muted-foreground">{t("sessions.detail.no_session")}</p>
      )}
      <ChangedFiles changes={worktreeChanges} />
    </div>
  );
}

function DetailHeader({
  worktree,
  branch,
  children,
}: {
  worktree: WorktreeEntry;
  branch: string | undefined;
  children: React.ReactNode;
}) {
  const path = worktree.workspace.task?.worktreePath ?? worktree.workspace.rootPath;
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="truncate text-app-body-emphasis text-foreground">
          {worktree.workspace.name}
        </h2>
        <span className="flex min-w-0 items-center gap-1 font-mono text-app-micro text-muted-foreground">
          {branch && (
            <>
              <GitBranch aria-hidden className="size-3 shrink-0" />
              <span className="shrink-0">{branch}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="truncate" title={path}>
            {path}
          </span>
        </span>
      </div>
      {children}
    </header>
  );
}

function DetailActions({
  worktree,
  session,
}: {
  worktree: WorktreeEntry;
  session: AgentSession | undefined;
}) {
  const { t } = useTranslation();
  const canInterrupt = session && (session.state === "running" || session.state === "busy");
  return (
    <div className="flex flex-wrap gap-2">
      {session && (
        <Button size="sm" onClick={() => showTerminal(session)}>
          {t("sessions.detail.show_terminal")}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => showChanges(worktree.workspace.id)}>
        {t("sessions.detail.show_changes")}
      </Button>
      {canInterrupt && (
        <Button size="sm" variant="outline" onClick={() => void interrupt(session)}>
          {t("sessions.detail.interrupt")}
        </Button>
      )}
      {!worktree.isRoot && (
        <Button
          size="sm"
          variant="outline"
          className="text-(--state-error-fg)"
          onClick={() => removeTask(worktree.workspace.id)}
        >
          {t("sessions.detail.remove_task")}
        </Button>
      )}
    </div>
  );
}

function SessionBody({ session, visible }: { session: AgentSession; visible: boolean }) {
  const { t } = useTranslation();
  const screen = useTerminalScreen(session.tabId, visible);
  return (
    <>
      {session.state === "permissionPending" ? (
        <p className="text-app-ui-sm text-(--state-warning-fg)">
          {t("sessions.detail.permission_hint")}
        </p>
      ) : (
        // Keyed by the session, so a draft never carries over to another one.
        session.state !== "exited" && <SendLine key={session.key} session={session} />
      )}
      {session.prompt && (
        <DetailSection title={t("sessions.detail.prompt")}>
          <p className="whitespace-pre-wrap break-words text-app-body text-foreground">
            {session.prompt}
          </p>
        </DetailSection>
      )}
      {session.message && (
        <DetailSection title={t("sessions.detail.message")}>
          <p className="whitespace-pre-wrap break-words text-app-body text-foreground">
            {session.message}
          </p>
        </DetailSection>
      )}
      <DetailSection title={t("sessions.detail.screen")}>
        {screen === null ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {t("sessions.detail.screen_not_started")}
          </p>
        ) : (
          <ScreenText text={screen} />
        )}
      </DetailSection>
    </>
  );
}

/** The screen's lines, kept scrolled to the latest unless scrolled up. */
function ScreenText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="app-scrollbar max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-(--radius-control) border border-border bg-background p-2 font-mono text-app-micro leading-relaxed text-foreground"
    >
      {text}
    </pre>
  );
}

/** The last lines of a terminal's screen, read every second while `visible`. */
function useTerminalScreen(tabId: string, visible: boolean): string | null {
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const controller = getTerminalController(tabId);
      if (!controller) {
        setScreen(null);
        return;
      }
      const lines = controller
        .readText(SCREEN_LINES * 2)
        .replace(/\s+$/, "")
        .split("\n");
      setScreen(lines.slice(-SCREEN_LINES).join("\n"));
    };
    read();
    const timer = setInterval(read, SCREEN_POLL_MS);
    return () => clearInterval(timer);
  }, [tabId, visible]);
  return screen;
}

function SendLine({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendLine(session, text);
      setText("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
    }
  };
  // Enter sends and Shift+Enter starts a new line, as in Claude Code; the
  // lines are typed with Ctrl+J between them, so the session takes them as
  // one input.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("sessions.detail.send_placeholder")}
          aria-label={t("sessions.detail.send_placeholder")}
          className={cn(
            "app-scrollbar field-sizing-content max-h-40 min-w-0 flex-1 resize-none overflow-y-auto",
            "rounded-(--radius-control) border border-border bg-background px-2 py-1.5",
            "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring",
          )}
        />
        <Button size="sm" type="submit" variant="outline" loading={sending}>
          {t("sessions.detail.send")}
        </Button>
      </div>
      {error && <p className="text-app-ui-sm text-(--state-error-fg)">{error}</p>}
    </form>
  );
}

function ChangedFiles({ changes }: { changes: WorktreeChanges | undefined }) {
  const { t } = useTranslation();
  if (!changes) return null;
  const shown = changes.files.slice(0, FILES_SHOWN);
  return (
    <DetailSection title={t("sessions.detail.changes", { count: changes.files.length })}>
      {changes.files.length === 0 ? (
        <p className="text-app-ui-sm text-muted-foreground">{t("sessions.detail.no_changes")}</p>
      ) : (
        <ul className="flex flex-col rounded-(--radius-control) border border-border">
          {shown.map((file) => (
            <li
              key={file.relPath}
              className="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0"
            >
              <span className="w-3 shrink-0 font-mono text-app-micro text-muted-foreground">
                {file.code}
              </span>
              <span
                className="truncate font-mono text-app-micro text-foreground"
                title={file.relPath}
              >
                {file.relPath}
              </span>
            </li>
          ))}
          {changes.files.length > shown.length && (
            <li className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("sessions.detail.more_changes", { count: changes.files.length - shown.length })}
            </li>
          )}
        </ul>
      )}
    </DetailSection>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-app-label uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
