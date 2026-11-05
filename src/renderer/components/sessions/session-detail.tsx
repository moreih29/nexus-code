// Sessions tab — detail panel: the chosen session's state; for a Claude
// session, what its turn does now, its todo list, the agents it runs and the
// tools it ran; what it was asked and last said, its terminal's screen
// (folded away when its hooks tell the rest), and its worktree's changes,
// with the actions on it. A worktree with no session shows its changes
// alone.
//
// A permission request is answered in the terminal, not here: the panel
// does not press keys in a Claude Code dialog on the user's behalf.

import { ChevronRight, GitBranch } from "lucide-react";
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
import { type ActivityByKey, findAgent } from "../../services/sessions/agents";
import { type ScreenLineKind, screenLines } from "../../services/sessions/screen-lines";
import {
  type AgentSession,
  allSessions,
  type SessionFamily,
  type WorktreeEntry,
} from "../../services/sessions/model";
import { useNow, type WorktreeChanges } from "../../services/sessions/use-family";
import { getTerminalController } from "../../services/terminal/terminal-registry";
import { existingChatController } from "../../services/chat/controller";
import { useChatTab } from "../../services/chat/store";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { PermissionCard } from "../chat/permission-card";
import { Button } from "../ui/button";
import { showToast } from "../ui/toast";
import { AgentDetail } from "./agent-detail";
import { PermissionAsks } from "./permission-asks";
import { AgentsSection, NowCard, ProgressSection, TodoSection } from "./session-activity";
import type { SessionActivity } from "../../../shared/claude/activity";
import type { SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

const SCREEN_LINES = 20;
const SCREEN_POLL_MS = 1_000;
const FILES_SHOWN = 50;

interface SessionDetailProps {
  family: SessionFamily;
  selection: SessionsSelection;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
}

export function SessionDetail({
  family,
  selection,
  changes,
  activity,
  visible,
  onSelect,
}: SessionDetailProps) {
  const { t } = useTranslation();
  const session =
    selection.kind === "worktree"
      ? undefined
      : allSessions(family).find((s) => s.key === selection.key);
  const workspaceId =
    session?.workspaceId ?? (selection.kind === "worktree" ? selection.workspaceId : "");
  const worktree = family.worktrees.find((w) => w.workspace.id === workspaceId);
  if (!worktree) return null;
  const agent =
    session && selection.kind === "agent"
      ? findAgent(activity, session.key, selection.agentId)
      : undefined;
  if (session && agent) {
    return (
      <AgentDetail
        key={`${session.key}:${agent.id}`}
        worktree={worktree}
        session={session}
        agent={agent}
        asks={(activity.get(session.key)?.asks ?? []).filter((ask) => ask.agentId === agent.id)}
        visible={visible}
        onSelect={onSelect}
      />
    );
  }
  const worktreeChanges = changes.get(worktree.workspace.id);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <DetailHeader worktree={worktree} branch={worktree.branch ?? worktreeChanges?.branch}>
        {session && (
          <span className="flex min-w-0 items-center gap-2">
            <AgentBadge agent={session.agent} />
            <SessionState session={session} />
          </span>
        )}
      </DetailHeader>
      <DetailActions worktree={worktree} session={session} />
      {session ? (
        <SessionBody
          // Keyed by the session, so each one opens with its screen folded or not by its own.
          key={session.key}
          session={session}
          activity={activity.get(session.key)}
          visible={visible}
          onSelect={onSelect}
        />
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
          {session.kind === "claude"
            ? t("sessions.detail.show_claude_tab")
            : t("sessions.detail.show_terminal")}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => showChanges(worktree.workspace.id)}>
        {t("sessions.detail.show_changes")}
      </Button>
      {canInterrupt && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            interrupt(session).catch((failure: unknown) => {
              showToast({ kind: "error", message: (failure as Error).message });
            });
          }}
        >
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

function SessionBody({
  session,
  activity,
  visible,
  onSelect,
}: {
  session: AgentSession;
  activity: SessionActivity | undefined;
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
}) {
  const { t } = useTranslation();
  // A Claude session's hooks tell what it does; its screen is folded away
  // until asked for. Another agent's screen is all there is to tell.
  const [screenToggled, setScreenToggled] = useState<boolean | undefined>(undefined);
  const screenOpen = screenToggled ?? activity === undefined;
  const screen = useTerminalScreen(
    session.tabId,
    visible && screenOpen && session.kind === "terminal",
  );
  const working = session.state === "running" || session.state === "permissionPending";
  // Running tools count their seconds.
  const now = useNow(visible && activity !== undefined && working);
  const asks = activity?.asks ?? [];
  return (
    <>
      {activity && <NowCard session={session} activity={activity} now={now} />}
      {session.kind === "claude" && <ClaudeTabRequests session={session} />}
      {asks.length > 0 ? (
        // Answered here, or in the terminal's own prompt.
        <PermissionAsks session={session} asks={asks} agents={activity?.agents ?? []} />
      ) : session.state === "permissionPending" ? (
        session.kind === "terminal" && (
          <p className="text-app-ui-sm text-(--state-warning-fg)">
            {t("sessions.detail.permission_hint")}
          </p>
        )
      ) : (
        // Keyed by the session, so a draft never carries over to another one.
        session.state !== "exited" && <SendLine key={session.key} session={session} />
      )}
      {activity && <TodoSection todos={activity.todos} />}
      {activity && <AgentsSection session={session} agents={activity.agents} onSelect={onSelect} />}
      {activity && <ProgressSection activity={activity} now={now} />}
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
      {session.kind === "terminal" && (
        <section className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setScreenToggled(!screenOpen)}
            aria-expanded={screenOpen}
            className="flex items-center gap-1 self-start rounded-(--radius-control) text-app-label uppercase text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", screenOpen && "rotate-90")}
            />
            {screenOpen ? t("sessions.detail.screen_hide") : t("sessions.detail.screen_show")}
          </button>
          {screenOpen &&
            (screen === null ? (
              <p className="text-app-ui-sm text-muted-foreground">
                {session.state === "exited"
                  ? t("sessions.detail.screen_exited")
                  : t("sessions.detail.screen_not_started")}
              </p>
            ) : (
              // Keyed by the session, so each one opens scrolled to its latest lines.
              <ScreenText key={session.key} text={screen} />
            ))}
        </section>
      )}
    </>
  );
}

/**
 * The permission requests a Claude tab's session waits on, as the tab shows
 * them, answered for it: its program asks the tab, not a hook.
 */
function ClaudeTabRequests({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const { workspaceId, tabId } = session;
  const requests = useChatTab(workspaceId, tabId).model.permissions;
  const cwd = useTabsStore((s) => {
    const tab = s.byWorkspace[workspaceId]?.[tabId];
    return tab?.type === "claude" ? tab.props.cwd : "";
  });
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const controller = existingChatController(workspaceId, tabId);
  if (requests.length === 0) {
    return session.state === "permissionPending" ? (
      <p className="text-app-ui-sm text-(--state-warning-fg)">
        {t("sessions.detail.permission_hint_claude")}
      </p>
    ) : null;
  }
  return (
    <PermissionCard
      requests={requests}
      workspaceId={workspaceId}
      cwd={cwd}
      rootPath={rootPath}
      onAnswer={(request, answer) => {
        controller?.answerPermission(request, answer).catch((failure: unknown) => {
          showToast({ kind: "error", message: (failure as Error).message });
        });
      }}
    />
  );
}

// How each kind of screen line is drawn.
const LINE_CLASS: Record<ScreenLineKind, string> = {
  item: "text-foreground",
  result: "text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-500",
  removed: "bg-(--state-error-fg)/10 text-(--state-error-fg)",
  status: "text-(--tab-claude-attention-fg)",
  prompt: "text-foreground",
  rule: "",
  hint: "text-muted-foreground/70",
  blank: "",
  text: "text-foreground/90",
};

/**
 * The screen's lines, kept scrolled to the latest unless scrolled up, each
 * drawn by what it is: a tool call's bullet stands out, its result is
 * dimmed, a diff's lines are tinted, the agent's rules become thin lines.
 * It takes focus, so the keyboard can scroll it too.
 */
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
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region the keyboard must reach
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="app-scrollbar max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-(--radius-control) border border-border bg-background px-2 py-1.5 font-mono text-app-micro leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {screenLines(text).map((line, index) =>
        line.kind === "rule" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a screen's lines have no identity but their place
          <span key={index} aria-hidden className="my-1 block h-px bg-border" />
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a screen's lines have no identity but their place
            key={index}
            className={cn(
              "block min-h-[1lh]",
              LINE_CLASS[line.kind],
              line.kind === "item" && "mt-1 first:mt-0",
            )}
          >
            {line.kind === "item" ? <ItemLine text={line.text} /> : line.text}
          </span>
        ),
      )}
    </pre>
  );
}

/** A tool call or message line: its bullet in the agent's color, then its words. */
function ItemLine({ text }: { text: string }) {
  const match = /^(\s*)([⏺●◆])(\s.*)$/.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {match[1]}
      <span className="text-emerald-500">{match[2]}</span>
      {match[3]}
    </>
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
