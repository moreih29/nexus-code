// Agents tab — the detail panel of a conversation: its title and state with
// a button to its tab and one to stop it; what it runs on; what it was last
// asked and answered; what it waits on, answered here; the calls it ran
// last, its subagents and its to-dos; and a box to send it more.
//
// A Claude or Codex tab's permission request is answered here as its tab
// would. A terminal's, through Claude Code's hook when it holds the request;
// else in the terminal, since the panel does not press keys in a Claude Code
// dialog on the user's behalf.

import {
  ArrowLeft,
  Ban,
  Bot,
  Check,
  Circle,
  CircleAlert,
  CircleDot,
  FileDiff,
  GitBranch,
  ListChecks,
  ListPlus,
  Loader,
  Pencil,
  Send,
  Square,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";
import type { SessionActivity } from "../../../shared/claude/activity";
import { existingCodexController } from "../../services/chat/codex-controller";
import { existingChatController } from "../../services/chat/controller";
import { type ChatTabState, chatKey, useChatStore, useChatTab } from "../../services/chat/store";
import { interrupt, sendLine, showChanges, showTerminal } from "../../services/sessions/actions";
import {
  chatDetailFacts,
  type DetailAgent,
  type DetailAgentStatus,
  type DetailFacts,
  type DetailStep,
  type DetailTodo,
  hookDetailFacts,
  type StepStatus,
} from "../../services/sessions/detail";
import type { AgentSession } from "../../services/sessions/model";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ChatAgentContext } from "../chat/chat-agent";
import { composerHint, composerKeys } from "../chat/composer";
import { PermissionCard } from "../chat/permission-card";
import { Button } from "../ui/button";
import { ContextRing } from "../ui/context-ring";
import { Keycap } from "../ui/keycap";
import { showToast } from "../ui/toast";
import { PermissionAsks } from "./permission-asks";
import type { SessionsSelection } from "./selection";
import { StateGlyph, stateColor, stateLabel, useDurationLabel } from "./session-status";
import { AgentMark } from "./status-view";
import { TerminalScreen } from "./terminal-screen";

/** How many lines of a long answer show before it is opened. */
const ANSWER_LINES = 8;

interface ConversationDetailProps {
  session: AgentSession;
  branch: string | undefined;
  activity: SessionActivity | undefined;
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
  /** Back to the list, where the panel takes its place. */
  onBack?: () => void;
}

export function ConversationDetail({
  session,
  branch,
  activity,
  visible,
  onSelect,
  onBack,
}: ConversationDetailProps) {
  const { t } = useTranslation();
  const chat = useChatTab(session.workspaceId, session.tabId);
  // A chat tab not shown since the app started has no conversation loaded, nor a program to send to.
  const loaded = useChatStore(
    (s) => s.tabs[chatKey(session.workspaceId, session.tabId)] !== undefined,
  );
  const terminal = session.kind === "terminal";
  const facts = useMemo(
    () => (terminal ? hookDetailFacts(activity) : chatDetailFacts(chat.model, chat.history)),
    [terminal, activity, chat.model, chat.history],
  );
  // A chat tab tells its prompt and answer itself once its conversation is
  // loaded; until then, and for a terminal, as its hooks last told them.
  const told = !terminal && (chat.model.items.length > 0 || (chat.history?.items.length ?? 0) > 0);
  const prompt = told ? facts.prompt : session.prompt;
  const answer = told ? facts.answer : session.message;
  const waiting = session.phase === "attention";
  const requests = terminal ? (activity?.asks ?? []).length : chat.model.permissions.length;
  const held = requests > 0 || session.state === "permissionPending";
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <DetailTop session={session} running={chat.model.running} onBack={onBack} />
          <MetaChips session={session} facts={facts} branch={branch} />
          {!waiting && prompt && <UserBubble text={prompt} />}
          {session.phase !== "running" && answer && (
            // Keyed by the session, so each one opens folded.
            <AgentBubble key={session.key} session={session} text={answer} />
          )}
          {!terminal && !loaded && !prompt && !answer && (
            <p className="text-app-ui-sm text-muted-foreground">
              {t("sessions.detail.not_loaded")}
            </p>
          )}
          {terminal ? (
            <TerminalRequests session={session} activity={activity} />
          ) : (
            <ChatTabRequests session={session} chat={chat} />
          )}
          <Activity session={session} facts={facts} onSelect={onSelect} />
          {terminal && (
            <TerminalScreen
              // Keyed by the session, so each one opens with its screen folded or not by its own.
              key={session.key}
              session={session}
              told={activity !== undefined}
              visible={visible}
            />
          )}
        </div>
      </div>
      {!held && session.state !== "exited" && (terminal || loaded) && (
        // Keyed by the session, so a draft never carries over to another one.
        <FollowUp key={session.key} session={session} chat={chat} />
      )}
      {waiting && requests === 0 && session.state === "permissionPending" && (
        <p className="border-t border-border px-4 py-3 text-app-ui-sm text-(--state-warning-fg)">
          {terminal
            ? t("sessions.detail.permission_hint")
            : t("sessions.detail.permission_hint_claude")}
        </p>
      )}
    </div>
  );
}

/** The mark, the title and the state, with the buttons to its tab and to stop it. */
function DetailTop({
  session,
  running,
  onBack,
}: {
  session: AgentSession;
  /** A chat tab's turn runs. */
  running: boolean;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const duration = useDurationLabel(session.since);
  const canStop = session.state === "running" || session.state === "busy" || running;
  const openLabel =
    session.kind === "claude"
      ? t("sessions.detail.show_claude_tab")
      : session.kind === "codex"
        ? t("sessions.detail.show_codex_tab")
        : t("sessions.detail.show_terminal");
  return (
    <header className="flex min-w-0 items-center gap-2">
      {onBack && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="-ml-1 @2xl/agents:hidden"
          title={t("sessions.detail.back")}
          aria-label={t("sessions.detail.back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </Button>
      )}
      <AgentMark session={session} className="size-4" />
      <h2 className="min-w-0 truncate text-app-body-emphasis text-foreground" title={session.title}>
        {session.title}
      </h2>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-app-ui-sm tabular-nums",
          stateColor(session.state),
        )}
        title={stateLabel(session)}
      >
        <StateGlyph state={session.state} />
        {duration}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="outline"
          title={openLabel}
          aria-label={openLabel}
          onClick={() => showTerminal(session)}
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" />
        </Button>
        {canStop && (
          <Button
            size="icon-sm"
            variant="outline"
            title={t("sessions.detail.interrupt")}
            aria-label={t("sessions.detail.interrupt")}
            onClick={() => {
              interrupt(session).catch((failure: unknown) => {
                showToast({ kind: "error", message: (failure as Error).message });
              });
            }}
          >
            <Square aria-hidden className="size-3 fill-current text-(--state-error-fg)" />
          </Button>
        )}
      </div>
    </header>
  );
}

const CHIP = "flex shrink-0 items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 py-0.5";

/** What it runs on | how far it went | where. */
function MetaChips({
  session,
  facts,
  branch,
}: {
  session: AgentSession;
  facts: DetailFacts;
  branch: string | undefined;
}) {
  const { t } = useTranslation();
  const modePrefix = session.kind === "codex" ? "chat.codex.mode" : "chat.mode";
  const runsOn = [
    facts.model && (
      <span key="model" className={CHIP} title={facts.model}>
        {facts.model.replace(/^claude-/, "")}
      </span>
    ),
    facts.effort && (
      <span key="effort" className={CHIP} title={t("chat.effort.label")}>
        {facts.effort}
      </span>
    ),
    facts.mode && (
      <span key="mode" className={CHIP} title={t("chat.mode.label")}>
        <Pencil aria-hidden className="size-3" />
        {t(`${modePrefix}.${facts.mode}`, { defaultValue: facts.mode })}
      </span>
    ),
  ].filter(Boolean);
  const files = facts.files;
  const went = [
    facts.context !== undefined && (
      <span
        key="context"
        className="flex shrink-0 items-center gap-1"
        title={t("sessions.list.context")}
      >
        <ContextRing percent={facts.context} className="size-3.5" />
        {facts.context}%
      </span>
    ),
    facts.costUsd !== undefined && facts.costUsd > 0 && (
      <span key="cost" className="shrink-0" title={t("sessions.detail.cost")}>
        {facts.costUsd < 0.01 ? "<$0.01" : `$${facts.costUsd.toFixed(2)}`}
      </span>
    ),
    files && (
      <button
        key="files"
        type="button"
        className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1 py-0.5 transition-colors hover:bg-[var(--state-hover-bg)] hover:text-foreground"
        title={t("sessions.detail.show_changes")}
        onClick={() => showChanges(session.workspaceId)}
      >
        <FileDiff aria-hidden className="size-3.5" />
        {files.count}
        {files.added !== undefined && files.added > 0 && (
          <span className="text-emerald-500">+{files.added}</span>
        )}
        {files.removed !== undefined && files.removed > 0 && (
          <span className="text-(--state-error-fg)">−{files.removed}</span>
        )}
      </button>
    ),
  ].filter(Boolean);
  const where = branch ? (
    <span key="branch" className="flex min-w-0 items-center gap-1 font-mono" title={branch}>
      <GitBranch aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  ) : null;
  const groups = [runsOn, went, where ? [where] : []].filter((group) => group.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-app-micro text-muted-foreground tabular-nums">
      {groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups keep their order
        <span key={index} className="flex min-w-0 items-center gap-2">
          {index > 0 && <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />}
          {group}
        </span>
      ))}
    </div>
  );
}

/** The user's last request, on the right as in the tab. */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] self-end rounded-(--radius-raised) bg-[var(--chat-user-bg)] px-3 py-2">
      <p className="line-clamp-4 text-app-body whitespace-pre-wrap break-words text-foreground select-text">
        {text}
      </p>
    </div>
  );
}

/** The conversation's last answer, folded to a few lines until opened. */
function AgentBubble({ session, text }: { session: AgentSession; text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > 480 || text.split("\n").length > ANSWER_LINES;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <AgentMark session={session} className="mt-1" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p
          className={cn(
            "min-w-0 whitespace-pre-wrap break-words text-app-body text-muted-foreground select-text",
            long && !open && "line-clamp-8",
          )}
        >
          {text}
        </p>
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="rounded-(--radius-control) text-app-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {open ? t("sessions.detail.answer_less") : t("sessions.detail.answer_more")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The permission requests a Claude or Codex tab's session waits on, as the
 * tab shows them, answered for it: its program asks the tab, not a hook.
 */
function ChatTabRequests({ session, chat }: { session: AgentSession; chat: ChatTabState }) {
  const { workspaceId, tabId } = session;
  const requests = chat.model.permissions;
  const cwd = useTabsStore((s) => {
    const tab = s.byWorkspace[workspaceId]?.[tabId];
    return tab?.type === "claude" || tab?.type === "codex" ? tab.props.cwd : "";
  });
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  if (requests.length === 0) return null;
  const controller =
    session.kind === "codex"
      ? existingCodexController(workspaceId, tabId)
      : existingChatController(workspaceId, tabId);
  return (
    // The card's words name the tab's program, as in the tab.
    <ChatAgentContext.Provider value={session.kind === "codex" ? "codex" : "claude"}>
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
    </ChatAgentContext.Provider>
  );
}

/** The requests a terminal's Claude Code holds for an answer from the app. */
function TerminalRequests({
  session,
  activity,
}: {
  session: AgentSession;
  activity: SessionActivity | undefined;
}) {
  const asks = activity?.asks ?? [];
  if (asks.length === 0) return null;
  // Answered here, or in the terminal's own prompt.
  return <PermissionAsks session={session} asks={asks} agents={activity?.agents ?? []} />;
}

/** The calls it ran last and its subagents, beside its to-dos. */
function Activity({
  session,
  facts,
  onSelect,
}: {
  session: AgentSession;
  facts: DetailFacts;
  onSelect: (selection: SessionsSelection) => void;
}) {
  const left = facts.steps.length > 0 || facts.agents.length > 0;
  const right = facts.todos.length > 0;
  if (!left && !right) return null;
  return (
    <div className={cn("grid min-w-0 gap-x-6 gap-y-4", left && right && "@xl:grid-cols-2")}>
      {left && (
        <div className="flex min-w-0 flex-col gap-4">
          <Steps steps={facts.steps} />
          <Subagents
            agents={facts.agents}
            // A terminal's agents have their own detail; a chat tab shows its own in the tab.
            onOpen={
              session.kind === "terminal"
                ? (agent) => onSelect({ kind: "agent", key: session.key, agentId: agent.id })
                : undefined
            }
          />
        </div>
      )}
      {right && <Todos todos={facts.todos} />}
    </div>
  );
}

const STEP_ICON: Record<StepStatus | DetailAgentStatus, React.ReactNode> = {
  running: (
    <Loader aria-hidden className="size-3.5 shrink-0 text-emerald-500 motion-safe:animate-spin" />
  ),
  asking: <CircleAlert aria-hidden className="size-3.5 shrink-0 text-(--state-warning-fg)" />,
  done: <Check aria-hidden className="size-3.5 shrink-0 text-emerald-500" />,
  failed: <X aria-hidden className="size-3.5 shrink-0 text-(--state-error-fg)" />,
  stopped: <Ban aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
};

function Steps({ steps }: { steps: readonly DetailStep[] }) {
  const { t } = useTranslation();
  if (steps.length === 0) return null;
  return (
    <ul aria-label={t("sessions.detail.steps")} className="flex min-w-0 flex-col gap-1.5">
      {steps.map((step) => (
        <li
          key={step.id}
          className="flex min-w-0 items-center gap-2 text-app-ui-sm"
          title={t(`sessions.detail.step.${step.status}`)}
        >
          {STEP_ICON[step.status]}
          <span
            className={cn(
              "shrink-0",
              step.status === "running" ? "font-medium text-foreground" : "text-foreground/90",
            )}
          >
            {step.name}
          </span>
          {step.target && (
            <span className="min-w-0 truncate font-mono text-app-micro text-muted-foreground">
              {step.target}
            </span>
          )}
          {(step.added ?? 0) + (step.removed ?? 0) > 0 && (
            <span className="shrink-0 font-mono text-app-micro tabular-nums">
              {(step.added ?? 0) > 0 && <span className="text-emerald-500">+{step.added}</span>}
              {(step.removed ?? 0) > 0 && (
                <span className="ml-1 text-(--state-error-fg)">−{step.removed}</span>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Subagents({
  agents,
  onOpen,
}: {
  agents: readonly DetailAgent[];
  onOpen: ((agent: DetailAgent) => void) | undefined;
}) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  const name = (agent: DetailAgent) =>
    agent.type ?? (agent.print ? t("sessions.agents.print") : t("sessions.agents.label_fallback"));
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3
        className="flex items-center gap-1.5 text-app-ui-sm text-muted-foreground tabular-nums"
        title={t("sessions.list.subagents")}
      >
        <Bot aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">{t("sessions.list.subagents")}</span>
        {agents.length}
      </h3>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {agents.map((agent) => {
          const line = (
            <>
              {STEP_ICON[agent.status]}
              <span className="shrink-0 text-foreground/90">{name(agent)}</span>
              {agent.description && agent.description !== agent.type && (
                <span className="min-w-0 truncate text-muted-foreground">{agent.description}</span>
              )}
            </>
          );
          return (
            <li key={agent.id} className="min-w-0">
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(agent)}
                  className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-(--radius-control) px-1 py-0.5 text-left text-app-ui-sm transition-colors hover:bg-[var(--state-hover-bg)]"
                >
                  {line}
                </button>
              ) : (
                <span className="flex min-w-0 items-center gap-2 py-0.5 text-app-ui-sm">
                  {line}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Todos({ todos }: { todos: readonly DetailTodo[] }) {
  const { t } = useTranslation();
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3
        className="flex items-center gap-2 text-app-ui-sm text-muted-foreground tabular-nums"
        title={t("sessions.detail.todos")}
      >
        <ListChecks aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">{t("sessions.detail.todos")}</span>
        <span className="shrink-0">
          {done}/{todos.length}
        </span>
        <span aria-hidden className="block h-1 min-w-8 flex-1 rounded-full bg-border">
          <span
            className="block h-1 rounded-full bg-emerald-500"
            style={{ width: `${(done / todos.length) * 100}%` }}
          />
        </span>
      </h3>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {todos.map((todo) => (
          <li key={todo.id} className="flex min-w-0 items-center gap-2 text-app-ui-sm">
            {todo.status === "completed" ? (
              <Check aria-hidden className="size-3.5 shrink-0 text-emerald-500" />
            ) : todo.status === "in_progress" ? (
              <CircleDot aria-hidden className="size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                "min-w-0 truncate",
                todo.status === "completed" && "text-muted-foreground line-through",
                todo.status === "in_progress" && "font-medium text-foreground",
                todo.status === "pending" && "text-foreground/90",
              )}
              title={todo.text}
            >
              {todo.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * More for the conversation. A chat tab's turn that runs takes it as its
 * composer would: ↩ when the turn can read it, ⌘↩ after the turn, ⌘⇧↩ at
 * once (Claude). A terminal has it typed in, Shift+Enter between lines.
 */
function FollowUp({ session, chat }: { session: AgentSession; chat: ChatTabState }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isChat = session.kind !== "terminal";
  const running = isChat && chat.model.running;
  const keys = composerKeys();

  const submit = async (how: "send" | "queue" | "now") => {
    if (text.trim() === "" || sending) return;
    const controller = !isChat
      ? undefined
      : session.kind === "codex"
        ? existingCodexController(session.workspaceId, session.tabId)
        : existingChatController(session.workspaceId, session.tabId);
    setSending(true);
    setError(null);
    try {
      if (running && controller && how === "queue") controller.enqueue(text);
      else if (running && controller && how === "now" && "sendNow" in controller) {
        await controller.sendNow(text);
      } else await sendLine(session, text);
      setText("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || isImeComposing(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.shiftKey && !mod) return;
    event.preventDefault();
    void submit(mod ? (event.shiftKey ? "now" : "queue") : "send");
  };

  const hint = running
    ? composerHint(t, true, session.kind === "codex" ? "codex" : "claude")
    : t("sessions.detail.send_keys", keys);
  // During a turn Claude reads it after the call it runs; Codex at once.
  const queues = running && session.kind !== "codex";
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit("send");
      }}
      className="flex shrink-0 flex-col gap-1 border-t border-border p-3"
    >
      <div className="flex items-end gap-2">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("sessions.detail.follow_up")}
          aria-label={t("sessions.detail.follow_up")}
          title={hint}
          className={cn(
            "app-scrollbar field-sizing-content max-h-40 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto",
            "rounded-(--radius-control) border border-border bg-background px-2.5 py-2",
            "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
            "focus-visible:border-ring",
          )}
        />
        <Button
          type="submit"
          className="h-9 gap-1.5 px-2.5"
          loading={sending}
          disabled={text.trim() === ""}
          title={hint}
          aria-label={
            queues
              ? t("sessions.detail.queue")
              : running
                ? t("chat.composer.send_now")
                : t("sessions.detail.send")
          }
        >
          {queues ? (
            <ListPlus aria-hidden className="size-4" />
          ) : (
            <Send aria-hidden className="size-4" />
          )}
          <Keycap>↵</Keycap>
        </Button>
      </div>
      {chat.queue.length > 0 && (
        <p className="text-app-micro text-muted-foreground">
          {t("sessions.detail.queued", { count: chat.queue.length })}
        </p>
      )}
      {error && <p className="text-app-ui-sm text-(--state-error-fg)">{error}</p>}
    </form>
  );
}
