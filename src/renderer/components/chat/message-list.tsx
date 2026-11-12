// The conversation of a Claude tab: what it showed before (history), what
// the running program has said, and the reply streaming in. It stays at the
// bottom while the user is there, and leaves them be once they scroll up.

import {
  Bot,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Copy,
  FileText,
  GitFork,
  LoaderCircle,
  MessageSquareShare,
  Radio,
  RotateCcw,
  SquareTerminal,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import type { RelayedMessage } from "../../../shared/chat/relay";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import type { ProfileMove } from "../../../shared/types/layout";
import { sharedClock, useSharedClock } from "../../hooks/use-now";
import { revealInWorkspace } from "../../services/agent-sessions/actions";
import { artifactOf } from "../../services/chat/artifact";
import { splitAttachments } from "../../services/chat/composer-input";
import { callsUnder, type ItemView, itemView, sameView } from "../../services/chat/item-view";
import {
  indexOfCall,
  shownStart,
  WINDOW_ITEMS,
  windowStart,
} from "../../services/chat/message-window";
import {
  type AssistantBlock,
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  isWaiting,
  type MessageSource,
  type NoticeItem,
  type ReceivedItem,
  type ShellItem,
  type StreamingMessage,
  type TaskEndItem,
  type ToolCall,
  type UserItem,
} from "../../services/chat/model";
import { revealTabById } from "../../services/chat/open-beside";
import {
  type AnswerExtras,
  answerExtras,
  exitCodeOf,
  imagesShownEarlier,
  SEND_FILES_TOOL,
} from "../../services/chat/panel";
import { followsMessage } from "../../services/chat/profile-moves";
import { RELAY_KINDS, withRelayed } from "../../services/chat/relayed";
import { isOwnScroll, nearBottom, scrolledDown } from "../../services/chat/stick-to-bottom";
import { foldToolRuns, tallyRun } from "../../services/chat/tool-runs";
import { isReport, reportedSessions } from "../../services/manager/report";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { isAgentViewShown } from "../../state/stores/agent-view";
import { sentIn, useManagerStore } from "../../state/stores/manager";
import { useTabsStore } from "../../state/stores/tabs";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import {
  DATE_AND_TIME,
  DATE_ONLY,
  dateTimeFormat,
  relativeTimeFormat,
} from "../../utils/intl-format";
import { ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { ManagerIcon } from "../manager/manager-chip";
import { IconButton } from "../ui/icon-button";
import { AnswerExtrasView } from "./answer-extras";
import { ArtifactCard } from "./artifact-card";
import { ChatAgentContext, useAgentContext } from "./chat-agent";
import { ChatImage, ToolThumbs } from "./chat-image";
import { ChatMarkdown } from "./chat-markdown";
import { AnsweredQuestions, PlanOutcome, showsAsPrompt } from "./prompt-rows";
import { SentFiles } from "./sent-files";
import { ToolRow } from "./tool-row";

interface MessageListProps {
  workspaceId: string;
  /** The tab the conversation is, if it is one: messages the agent manager sent it are marked. */
  tabId?: string;
  cwd: string;
  rootPath: string;
  history: ChatModel | null;
  model: ChatModel;
  /** Shown when there is no message yet. */
  empty?: React.ReactNode;
  actions?: MessageActions;
  /** In place of the conversation: an agent's transcript. */
  items?: ChatItem[];
  /** A call to bring into view and light up, as the side panel asks. */
  reveal?: CallReveal | null;
  /** Where the conversation went on in another profile: a line after the message. */
  moves?: readonly ProfileMove[];
  /** The messages other agents sent through the nexus command: shown as received. */
  relayed?: readonly RelayedMessage[];
}

/** A call asked to be seen in the conversation; each ask its own seq, so asking again shows it again. */
export interface CallReveal {
  toolUseId: string;
  seq: number;
}

/** The ask, with the calls the asked one runs under: a subagent's call shows as its Agent call. */
interface ShownCall {
  ids: ReadonlySet<string>;
  seq: number;
}

/** The asked call and the calls it runs under, innermost first. */
function callChain(toolUseId: string, tools: Record<string, ToolCall>): string[] {
  const chain: string[] = [];
  for (let id: string | null | undefined = toolUseId; id && !chain.includes(id); ) {
    chain.push(id);
    id = tools[id]?.parentToolUseId;
  }
  return chain;
}

/** How long the list waits for a folded run to open before it looks for the call. */
const REVEAL_FRAMES = 2;

/** Brings the row of the innermost call of `chain` into the middle of `view`, and lights it up. */
function showCallRow(view: HTMLElement, content: HTMLElement, chain: readonly string[]): boolean {
  for (const id of chain) {
    const row = content.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    const offset = row.getBoundingClientRect().top - view.getBoundingClientRect().top;
    view.scrollTop += offset - Math.max(0, (view.clientHeight - row.offsetHeight) / 2);
    row.classList.remove("chat-call-flash");
    // A reflow between, so asking again starts the light over.
    void row.offsetWidth;
    row.classList.add("chat-call-flash");
    row.addEventListener("animationend", () => row.classList.remove("chat-call-flash"), {
      once: true,
    });
    return true;
  }
  return false;
}

/** What the user can do from a message. */
export interface MessageActions {
  /** A turn runs: a rewind waits for it. */
  running: boolean;
  /** The tab has a session to fork from. */
  canFork: boolean;
  /** Absent where the conversation forks into no tab. */
  onFork?: (item: UserItem | AssistantItem) => void;
  onRewind: (item: UserItem) => void;
  /** Sends a running command or subagent to the background. */
  onBackground?: (toolUseId: string) => void;
  /** Tool calls that wait for the user to allow them, which have not started. */
  waiting?: ReadonlySet<string>;
  /**
   * What shows a task that ended (its agent's transcript, its job in the
   * side panel), when the tab still knows the task.
   */
  taskShower?: (item: TaskEndItem) => (() => void) | undefined;
}

/** What sends a call to the background, unless it waits to be allowed. */
function backgroundOf(actions: MessageActions | undefined, toolUseId: string) {
  return actions?.waiting?.has(toolUseId) ? undefined : actions?.onBackground;
}

export function MessageList({
  workspaceId,
  tabId,
  cwd,
  rootPath,
  history,
  model,
  empty,
  actions,
  items,
  reveal,
  moves,
  relayed,
}: MessageListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // Where the code last scrolled to; its scroll event is not the user's.
  const ownTop = useRef<number | null>(null);
  // Where the view last was, whoever moved it.
  const lastTop = useRef(0);
  // Whether what shows before the first message is up.
  const emptyShown = useRef(false);
  const [showJump, setShowJump] = useState(false);
  // Earlier messages asked for beyond the last WINDOW_ITEMS, and where the
  // view was when they were, to stay on what it showed.
  const [more, setMore] = useState(0);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    ownTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const down = scrolledDown(el, lastTop.current);
    lastTop.current = el.scrollTop;
    if (emptyShown.current) {
      // Looking through the past sessions; a conversation that comes starts at its bottom.
      stuck.current = true;
      setShowJump(false);
      return;
    }
    if (isOwnScroll(el, ownTop.current)) {
      // Ours, a frame late: what came in since goes down too.
      if (stuck.current) toBottom();
      return;
    }
    ownTop.current = null;
    if (stuck.current && down) {
      // The browser giving back a scroll it cut short; only scrolling up leaves the bottom.
      toBottom();
      return;
    }
    const atBottom = nearBottom(el);
    stuck.current = atBottom;
    setShowJump(!atBottom);
  }, [toBottom]);

  // Growth from any source (a new item, a streamed word, an opened row)
  // keeps a stuck view at the bottom, and so does the view getting shorter
  // (a permission request docked under it). What shows before the first
  // message (the welcome, the past sessions) reads from the top.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const view = scrollRef.current;
    if (!content || !view) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current && !emptyShown.current) toBottom();
    });
    observer.observe(content);
    observer.observe(view);
    return () => observer.disconnect();
  }, [toBottom]);

  // Sending a message brings the view back down.
  const lastUser = lastUserKey(model.items);
  useEffect(() => {
    if (!lastUser) return;
    stuck.current = true;
    toBottom();
  }, [lastUser, toBottom]);

  const historyItems = useMemo(
    () => (items ? [] : withRelayed(history?.items ?? [], relayed)),
    [items, history, relayed],
  );
  // A message Claude has not read yet waits above the box, not here.
  const liveItems = useMemo(
    () =>
      items ??
      withRelayed(
        model.items.filter((item) => !isWaiting(item)),
        relayed,
      ),
    [items, model.items, relayed],
  );
  const streaming = items ? null : model.streaming;
  const nothing = historyItems.length === 0 && liveItems.length === 0 && !streaming;
  emptyShown.current = nothing && empty !== undefined;
  const tools = useMemo(
    () => (history ? { ...history.tools, ...model.tools } : model.tools),
    [history, model.tools],
  );
  // What each finished turn's answer ends with; an agent's transcript has none.
  const turnDone = !model.running && !streaming;
  const extras = useMemo(
    () =>
      items
        ? new Map<ChatItem, AnswerExtras>()
        : answerExtras([...(history?.items ?? []), ...model.items], tools, cwd, rootPath, turnDone),
    [items, history, model.items, tools, cwd, rootPath, turnDone],
  );
  const shownItems = useMemo(() => [...historyItems, ...liveItems], [historyItems, liveItems]);
  // Only the last messages render (see message-window); earlier ones when
  // asked for. While the view is up the list, messages that come in do not
  // take its top away from under it, up to a point (shownStart).
  const heldStart = useRef(0);
  const size = WINDOW_ITEMS + more;
  const start = shownStart({
    fresh: windowStart(shownItems, size),
    held: heldStart.current,
    stuck: stuck.current,
    total: shownItems.length,
    size,
  });
  heldStart.current = start;
  const windowItems = useMemo(() => shownItems.slice(start), [shownItems, start]);
  // Calls in a row fold into one line, which may take in later messages' calls.
  const shown = useMemo(() => foldToolRuns(windowItems, tools), [windowItems, tools]);
  // Each move after the last item of the message it follows; one whose
  // message is not shown (an agent's transcript, a conversation cleared) is not.
  const movesAfter = useMemo(() => {
    const after = new Map<ChatItem, ProfileMove[]>();
    if (items || !moves) return after;
    for (const move of moves) {
      const item = shownItems.findLast((i) => followsMessage(i, move.after));
      if (item) after.set(item, [...(after.get(item) ?? []), move]);
    }
    return after;
  }, [items, moves, shownItems]);
  // An image a turn shows twice is in full only the first time.
  const earlier = useMemo(
    () => imagesShownEarlier(windowItems, tools, cwd),
    [windowItems, tools, cwd],
  );
  // The calls the side panel asked to see: a folded run that holds one opens.
  const latestTools = useRef(tools);
  latestTools.current = tools;
  const shownCall = useMemo<ShownCall | undefined>(
    () =>
      reveal
        ? { ids: new Set(callChain(reveal.toolUseId, latestTools.current)), seq: reveal.seq }
        : undefined,
    [reveal],
  );
  // A call asked for in a message before the rendered ones renders it first.
  const latestItems = useRef(shownItems);
  latestItems.current = shownItems;
  const latestStart = useRef(start);
  latestStart.current = start;
  useEffect(() => {
    if (!shownCall) return;
    let frames = REVEAL_FRAMES;
    const index = indexOfCall(latestItems.current, shownCall.ids);
    if (index >= 0 && index < latestStart.current) {
      stuck.current = false;
      setMore((m) => Math.max(m, latestItems.current.length - index - WINDOW_ITEMS));
      frames += REVEAL_FRAMES;
    }
    let frame = 0;
    const look = () => {
      if (frames-- > 0) {
        frame = requestAnimationFrame(look);
        return;
      }
      const view = scrollRef.current;
      const content = contentRef.current;
      if (!view || !content) return;
      // Leaves the bottom, as scrolling up does.
      stuck.current = false;
      showCallRow(view, content, [...shownCall.ids]);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [shownCall]);
  const showEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    stuck.current = false;
    setMore((m) => m + WINDOW_ITEMS);
  }, []);
  // The messages put above keep the view on what it showed.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const was = anchor.current;
    if (!el || !was || more === 0) return;
    anchor.current = null;
    el.scrollTop = was.top + (el.scrollHeight - was.height);
    ownTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  }, [more]);

  // Each message, memoized, renders only when it, these or its part of the
  // sources (item-view) change: not for a streamed chunk, a call of
  // another message's, or its tab shown or hidden.
  const ctx = useMemo<ItemContext>(
    () => ({ workspaceId, tabId, cwd, rootPath, actions }),
    [workspaceId, tabId, cwd, rootPath, actions],
  );
  const under = useMemo(() => callsUnder(tools), [tools]);
  const views = useMemo(() => {
    const sources = { tools, callsUnder: under, shown, extras, earlier, asked: shownCall };
    const out = new Map<ChatItem, ItemView>();
    for (const item of windowItems) {
      const view = itemView(item, sources);
      if (view) out.set(item, view);
    }
    return out;
  }, [windowItems, tools, under, shown, extras, earlier, shownCall]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="app-scrollbar absolute inset-0 overflow-y-auto"
        data-testid="chat-messages"
      >
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex max-w-[860px] flex-col gap-3 px-4 py-4",
            // Room for an empty conversation's notice to sit in the middle.
            nothing && empty ? "min-h-full" : undefined,
          )}
        >
          {nothing && empty}
          {start > 0 && (
            <button
              type="button"
              onClick={showEarlier}
              className="self-center rounded-(--radius-control) border border-border px-3 py-1 text-app-micro text-muted-foreground hover:text-foreground"
            >
              {t("chat.show_earlier", { count: start })}
            </button>
          )}
          {historyItems.slice(Math.min(start, historyItems.length)).map((item) => (
            <Fragment key={`h-${item.key}`}>
              <Item item={item} ctx={ctx} view={views.get(item)} />
              {movesAfter.get(item)?.map((move) => (
                <MoveLine key={`m-${move.at}`} move={move} />
              ))}
            </Fragment>
          ))}
          {liveItems.slice(Math.max(0, start - historyItems.length)).map((item) => (
            <Fragment key={item.key}>
              <Item item={item} ctx={ctx} view={views.get(item)} />
              {movesAfter.get(item)?.map((move) => (
                <MoveLine key={`m-${move.at}`} move={move} />
              ))}
            </Fragment>
          ))}
          {streaming && (
            <Streaming
              streaming={streaming}
              ctx={ctx}
              tools={tools}
              shownEarlier={earlier.inLastTurn}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            stuck.current = true;
            toBottom();
          }}
          title={t("chat.jump_to_bottom")}
          aria-label={t("chat.jump_to_bottom")}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-popover p-1.5 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  );
}

function lastUserKey(items: ChatItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") return items[i].key;
  }
  return undefined;
}

/** What every message of a list renders with. */
interface ItemContext {
  workspaceId: string;
  tabId: string | undefined;
  cwd: string;
  rootPath: string;
  actions?: MessageActions;
}

interface ItemProps {
  item: ChatItem;
  ctx: ItemContext;
  /** An assistant message's part of the list's sources. */
  view: ItemView | undefined;
}

const Item = memo(function Item({ item, ctx, view }: ItemProps) {
  switch (item.kind) {
    case "user":
      // The app's reports in the agent manager's conversation are no messages of the user's.
      if (isManagerWorkspace(ctx.workspaceId) && isReport(item.text)) {
        return <ManagerReport item={item} />;
      }
      return <UserBubble item={item} ctx={ctx} />;
    case "assistant":
      return (
        <AssistantMessage
          item={item}
          ctx={ctx}
          view={view ?? { blocks: item.blocks, tools: {}, earlier: new Map() }}
        />
      );
    case "notice":
      return <Notice item={item} />;
    case "received":
      return <ReceivedBubble item={item} />;
    case "task_end":
      return <TaskEndRow item={item} ctx={ctx} />;
    case "shell":
      return <ShellCard item={item} />;
  }
}, sameItem);

function sameItem(a: ItemProps, b: ItemProps): boolean {
  return a.item === b.item && a.ctx === b.ctx && sameView(a.view, b.view);
}

/** The origins the app names; another is named as the CLI names it. */
const NAMED_SOURCES: ReadonlySet<string> = new Set(["peer", "channel", "coordinator"]);

/** The lines of a received message shown before it is opened. */
const RECEIVED_LINES = 6;

/**
 * A message someone else sent Claude (another session, a channel, the
 * coordinator): on the left as Claude's are, since the user did not write
 * it, and tinted, with who sent it over it.
 */
function ReceivedBubble({ item }: { item: ReceivedItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { kind, name } = item.from;
  // Named, it reads "NAME · sent from another session"; unnamed, what it is says it all.
  const what = NAMED_SOURCES.has(kind)
    ? t(`chat.received.${name ? "from_" : ""}${kind}`)
    : t("chat.received.from_other", { kind });
  const long = item.text.split("\n").length > RECEIVED_LINES || item.text.length > 600;
  return (
    <div className="group/received flex flex-col items-start gap-1" data-testid="chat-received">
      <span className="flex max-w-[85%] items-center gap-1.5 text-app-micro text-muted-foreground">
        <MessageSquareShare
          className="size-3.5 shrink-0 text-[var(--chat-received-fg)]"
          aria-hidden
        />
        {RELAY_KINDS.has(kind) ? (
          <RelaySenderLine from={item.from} />
        ) : (
          <>
            {name && (
              <span className="min-w-0 truncate font-medium text-[var(--chat-received-fg)]">
                {name}
              </span>
            )}
            <span className="shrink-0">{what}</span>
          </>
        )}
      </span>
      <div className="max-w-[85%] rounded-(--radius-raised) bg-[var(--chat-received-bg)] px-3 py-2 text-app-body select-text">
        <div
          className={cn(
            "whitespace-pre-wrap break-words",
            long && !open && "line-clamp-6 max-h-[9.5em] overflow-hidden",
          )}
        >
          {item.text}
        </div>
        {long && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 text-app-micro text-[var(--chat-received-fg)] hover:underline"
          >
            {open ? t("chat.received.less") : t("chat.received.more")}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-app-micro text-muted-foreground opacity-0 group-focus-within/received:opacity-100 group-hover/received:opacity-100">
        <MessageTime at={item.at} />
        <CopyButton text={item.text} />
      </div>
    </div>
  );
}

/** Shows a tab, in its workspace or in the agent view while that is up. */
function showTab(workspaceId: string, tabId: string): void {
  if (isAgentViewShown()) revealTabById(workspaceId, tabId);
  else revealInWorkspace({ workspaceId, tabId });
}

/**
 * Who sent a message through the nexus command: the manager, or the tab or
 * terminal its agent runs in, by the name it has now, which a click shows;
 * by the name it had once it is closed.
 */
function RelaySenderLine({ from }: { from: MessageSource }) {
  const { t } = useTranslation();
  const { workspaceId, tabId } = from;
  const title = useTabsStore((s) =>
    workspaceId && tabId ? s.byWorkspace[workspaceId]?.[tabId]?.title : undefined,
  );
  if (from.kind === "manager") {
    return <span className="shrink-0">{t("chat.received.manager")}</span>;
  }
  const name = title || from.name;
  const closed = title === undefined && tabId !== undefined;
  const agent = from.agent === "codex" ? "Codex" : "Claude Code";
  const what =
    from.kind === "terminal"
      ? t("chat.received.from_terminal", { agent })
      : t(name ? "chat.received.from_tab" : "chat.received.tab");
  const nameClass = "min-w-0 truncate font-medium text-[var(--chat-received-fg)]";
  return (
    <>
      {name &&
        (workspaceId && tabId && !closed ? (
          <button
            type="button"
            className={cn(nameClass, "hover:underline")}
            title={t("chat.received.show_tab")}
            onClick={() => showTab(workspaceId, tabId)}
          >
            {name}
          </button>
        ) : (
          <span className={nameClass}>{name}</span>
        ))}
      <span className="shrink-0">
        {what}
        {closed && ` · ${t("chat.received.closed")}`}
      </span>
    </>
  );
}

/** What a task was, as its end names it (`Background command "npm test" completed`). */
function namedIn(summary: string | undefined): string | undefined {
  return summary?.match(/"([\s\S]+)"/)?.[1];
}

const AGENT_TASKS: ReadonlySet<string> = new Set([
  "local_agent",
  "remote_agent",
  "in_process_teammate",
]);

/**
 * A task that ended while Claude did not wait for it, on one line: the news
 * wakes Claude, and what it says next answers it. A click shows the task.
 */
function TaskEndRow({ item, ctx }: { item: TaskEndItem; ctx: ItemContext }) {
  const { t } = useTranslation();
  const show = ctx.actions?.taskShower?.(item);
  const agent =
    (item.taskType !== undefined && AGENT_TASKS.has(item.taskType)) ||
    (item.taskType === undefined && /^Agent\b/.test(item.summary ?? ""));
  const state =
    item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "stopped";
  const what = item.description ?? namedIn(item.summary) ?? item.summary ?? item.taskId;
  const exitCode = exitCodeOf(item.summary);
  const body = (
    <>
      {state === "completed" ? (
        <CircleCheck className="size-3.5 shrink-0 text-[var(--git-status-added-fg)]" aria-hidden />
      ) : state === "failed" ? (
        <CircleX className="size-3.5 shrink-0 text-[var(--state-error-fg)]" aria-hidden />
      ) : (
        <CircleSlash className="size-3.5 shrink-0" aria-hidden />
      )}
      {agent && <Bot className="size-3.5 shrink-0" aria-hidden />}
      <span className={cn("shrink-0", state === "failed" && "text-[var(--state-error-fg)]")}>
        {t(`chat.task_end.${agent ? "agent" : "job"}_${state}`)}
      </span>
      <span className="min-w-0 truncate text-foreground/80">{what}</span>
      {exitCode !== undefined && exitCode !== 0 && (
        <span className="shrink-0">{t("chat.panel.jobs.exit_code", { code: exitCode })}</span>
      )}
      <MessageTime at={item.at} />
    </>
  );
  const row = "flex max-w-full items-center gap-1.5 text-app-micro text-muted-foreground";
  return (
    <div className="flex" data-testid="chat-task-end" title={item.summary}>
      {show ? (
        <button
          type="button"
          onClick={show}
          className={cn(row, "rounded-(--radius-control) text-left hover:text-foreground")}
        >
          {body}
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
    </div>
  );
}

/** A shell command the user ran in the terminal's Claude Code, and what it printed. */
function ShellCard({ item }: { item: ShellItem }) {
  const { t } = useTranslation();
  const out = [item.stdout, item.stderr].filter(Boolean).join("\n");
  return (
    <div className="flex flex-col items-end gap-1" data-testid="chat-shell">
      <span className="flex items-center gap-1 text-app-micro text-muted-foreground">
        <SquareTerminal className="size-3.5" aria-hidden />
        {t("chat.shell.ran")}
      </span>
      <div className="max-w-[85%] overflow-hidden rounded-(--radius-raised) border border-border font-mono text-app-ui-sm select-text">
        {item.command && (
          <div className="whitespace-pre-wrap break-words bg-muted px-3 py-1.5">
            <span className="text-muted-foreground select-none">$ </span>
            {item.command}
          </div>
        )}
        {out && (
          <pre className="app-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-1.5 text-muted-foreground">
            {out}
          </pre>
        )}
      </div>
    </div>
  );
}

function UserBubble({ item, ctx }: { item: UserItem; ctx: ItemContext }) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const { actions, workspaceId, tabId } = ctx;
  const byManager = useManagerStore((s) =>
    tabId ? sentIn(s.tasks, workspaceId, tabId, item.text) : false,
  );
  const taken = item.uuid !== undefined;
  const { text, files } = splitAttachments(item.text);
  return (
    <div className="group/user flex flex-col items-end gap-1">
      {byManager && (
        <span
          className="flex items-center gap-1 text-app-micro text-muted-foreground"
          title={t("manager.sent_title")}
        >
          <ManagerIcon className="size-3.5 text-[var(--state-selected-indicator)]" aria-hidden />
          {t("manager.sent")}
        </span>
      )}
      {item.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.images.map((_, i) => (
            <ChatImage
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's images keep their order
              key={i}
              images={item.images}
              index={i}
              className="max-h-32 max-w-48 rounded-(--radius-control) border border-border object-cover"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {files.map((path) => (
            <span
              key={path}
              title={path}
              className="flex max-w-56 items-center gap-1.5 rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{path.split(/[\\/]/).pop()}</span>
            </span>
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-(--radius-raised) bg-[var(--chat-user-bg)] px-3 py-2 text-app-body whitespace-pre-wrap break-words select-text">
          {text}
        </div>
      )}
      <div className="flex items-center gap-1 text-app-micro text-muted-foreground">
        <div className="flex items-center gap-1 opacity-0 group-focus-within/user:opacity-100 group-hover/user:opacity-100">
          <MessageTime at={item.at} />
          <CopyButton text={item.text} />
          {actions && taken && (
            <IconButton
              label={actions.running ? t("chat.rewind.busy") : t("chat.rewind.action")}
              blocked={actions.running}
              onClick={() => actions.onRewind(item)}
            >
              <RotateCcw className="size-3.5" />
            </IconButton>
          )}
          {actions?.onFork && taken && (
            <IconButton label={t("chat.fork.from_user")} onClick={() => actions.onFork?.(item)}>
              <GitFork className="size-3.5" />
            </IconButton>
          )}
        </div>
        <span
          title={item.state === "taken" ? t("chat.message.taken", agent) : t("chat.message.sent")}
          role="img"
          aria-label={
            item.state === "taken" ? t("chat.message.taken", agent) : t("chat.message.sent")
          }
        >
          {item.state === "taken" ? (
            <CheckCheck className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
        </span>
      </div>
    </div>
  );
}

function AssistantMessage({
  item,
  ctx,
  view,
}: {
  item: AssistantItem;
  ctx: ItemContext;
  view: ItemView;
}) {
  const { t } = useTranslation();
  const text = item.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  // A fork from here keeps the answer whole: only from one that ends in text.
  const forkable =
    ctx.actions?.canFork &&
    ctx.actions.onFork !== undefined &&
    item.uuid !== undefined &&
    item.blocks.at(-1)?.type === "text";
  const { blocks, extras } = view;
  // Its calls went into a run an earlier message shows.
  if (blocks.length === 0 && !extras) return null;
  return (
    <div className="group/assistant flex flex-col">
      {blocks.map((block, i) =>
        block.type === "run" ? (
          <ToolRun
            key={`run-${runKey(block.blocks)}`}
            blocks={block.blocks}
            ctx={ctx}
            view={view}
          />
        ) : block.type === "text" ? (
          <ChatMarkdown
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are only appended
            key={i}
            text={block.text}
            workspaceId={ctx.workspaceId}
            cwd={ctx.cwd}
            rootPath={ctx.rootPath}
            shownEarlier={view.earlier.get(block)}
          />
        ) : block.type === "thinking" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are only appended
          <Thinking key={i} text={block.text} />
        ) : (
          <CallRow
            key={block.toolUseId}
            toolUseId={block.toolUseId}
            ctx={ctx}
            tools={view.tools}
            shownEarlier={view.earlier.get(block.toolUseId)}
          />
        ),
      )}
      {extras && (
        <AnswerExtrasView
          extras={extras}
          workspaceId={ctx.workspaceId}
          cwd={ctx.cwd}
          rootPath={ctx.rootPath}
        />
      )}
      {text && (
        <div className="mt-1 flex items-center gap-1 text-app-micro text-muted-foreground opacity-0 group-focus-within/assistant:opacity-100 group-hover/assistant:opacity-100">
          <CopyButton text={text} />
          {forkable && ctx.actions && (
            <IconButton
              label={t("chat.fork.from_assistant")}
              onClick={() => ctx.actions?.onFork?.(item)}
            >
              <GitFork className="size-3.5" />
            </IconButton>
          )}
          <MessageTime at={item.at} />
        </div>
      )}
    </div>
  );
}

/** A run's key: its first call's, which stays as calls join it. */
function runKey(blocks: AssistantBlock[]): string {
  const first = blocks.find((block) => block.type === "tool");
  return first?.type === "tool" ? first.toolUseId : "";
}

function isLive(tool: ToolCall | undefined): boolean {
  return !tool || tool.status === "running" || tool.status === "streaming";
}

/** The kinds of call a run's line counts, in its order. */
const RUN_KINDS = ["commands", "reads", "edits", "searches", "others"] as const;

/**
 * Calls in a row as one line that says what they did, and opens to show
 * each. A call still going shows under it while folded, so the turn's
 * progress stays in sight.
 */
function ToolRun({
  blocks,
  ctx,
  view,
}: {
  blocks: AssistantBlock[];
  ctx: ItemContext;
  view: ItemView;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { tools } = view;
  // Opens when the side panel asks to see a call of the run's.
  const asked = view.asked;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once; a call joining the run later does not open it again
  useEffect(() => {
    if (asked && blocks.some((block) => block.type === "tool" && asked.ids.has(block.toolUseId))) {
      setOpen(true);
    }
  }, [asked]);
  const calls = blocks.flatMap((block) => (block.type === "tool" ? [tools[block.toolUseId]] : []));
  const running = calls.some(isLive);
  const tally = tallyRun(calls);
  const label = RUN_KINDS.filter((kind) => tally[kind] > 0)
    .map((kind) => t(`chat.tool.run.${kind}`, { count: tally[kind] }))
    .join(" · ");
  const rows = open
    ? blocks
    : blocks.filter((block) => block.type === "tool" && isLive(tools[block.toolUseId]));
  return (
    <div className="my-1 text-app-ui-sm" data-testid="chat-tool-run">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)]"
        >
          {running ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--state-loading-indicator)]" />
          ) : (
            // A run some calls of which failed is not all green.
            <Check
              className={cn(
                "size-3.5 shrink-0",
                tally.failed > 0 ? "text-muted-foreground" : "text-[var(--state-success-fg)]",
              )}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={label}>
            {label}
          </span>
          {tally.failed > 0 && (
            <span className="shrink-0 text-[var(--state-error-fg)]">
              {t("chat.tool.run.failed", { count: tally.failed })}
            </span>
          )}
          {tally.denied > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {t("chat.tool.run.denied", { count: tally.denied })}
            </span>
          )}
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        <ToolThumbs calls={calls} />
      </div>
      {rows.length > 0 && (
        <div className="ml-4 border-l border-border pl-2">
          {rows.map((block, i) =>
            block.type === "tool" ? (
              <ToolRow
                key={block.toolUseId}
                toolUseId={block.toolUseId}
                tool={tools[block.toolUseId]}
                tools={tools}
                cwd={ctx.cwd}
                onBackground={backgroundOf(ctx.actions, block.toolUseId)}
              />
            ) : block.type === "thinking" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a run's blocks are only appended
              <Thinking key={i} text={block.text} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** A call as a row: one that asked the user shows what they said. */
function CallRow({
  toolUseId,
  ctx,
  tools,
  shownEarlier,
}: {
  toolUseId: string;
  ctx: ItemContext;
  /** Its call and the calls it runs, by id; more is fine. */
  tools: Readonly<Record<string, ToolCall>>;
  /** The image files it sends that its turn showed before. */
  shownEarlier?: ReadonlySet<string>;
}) {
  const tool = tools[toolUseId];
  // A page it published to claude.ai shows as a card; running or failed, it is a row as any call.
  const page = artifactOf(tool, ctx.cwd);
  if (page) {
    return <ArtifactCard page={page} workspaceId={ctx.workspaceId} rootPath={ctx.rootPath} />;
  }
  // The files it sent the user show as they would there; running or
  // failed, it is a row as any call.
  if (tool?.name === SEND_FILES_TOOL && tool.status === "done") {
    return (
      <SentFiles
        tool={tool}
        workspaceId={ctx.workspaceId}
        cwd={ctx.cwd}
        shownEarlier={shownEarlier}
      />
    );
  }
  if (showsAsPrompt(tool)) {
    return tool.name === "AskUserQuestion" ? (
      <AnsweredQuestions tool={tool} />
    ) : (
      <PlanOutcome
        tool={tool}
        workspaceId={ctx.workspaceId}
        cwd={ctx.cwd}
        rootPath={ctx.rootPath}
      />
    );
  }
  return (
    <ToolRow
      toolUseId={toolUseId}
      tool={tool}
      tools={tools}
      cwd={ctx.cwd}
      onBackground={backgroundOf(ctx.actions, toolUseId)}
    />
  );
}

function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-app-ui-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 hover:bg-[var(--state-hover-bg)]"
      >
        <Brain className={cn("size-3.5", live && "animate-pulse")} />
        <span>{live ? t("chat.thinking_live") : t("chat.thinking")}</span>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && (
        <div className="mt-1 ml-5 border-l border-border pl-3 text-app-ui-sm whitespace-pre-wrap break-words italic">
          {text}
        </div>
      )}
    </div>
  );
}

function Streaming({
  streaming,
  ctx,
  tools,
  shownEarlier,
}: {
  streaming: StreamingMessage;
  ctx: ItemContext;
  tools: Record<string, ToolCall>;
  /** What the last turn shows in full so far, which it shows as chips. */
  shownEarlier: ReadonlySet<string>;
}) {
  const blocks = Object.entries(streaming.blocks)
    .map(([index, block]) => ({ index: Number(index), block }))
    .sort((a, b) => a.index - b.index);
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col" data-testid="chat-streaming">
      {blocks.map(({ index, block }) =>
        block.type === "text" ? (
          <ChatMarkdown
            key={index}
            text={block.text}
            workspaceId={ctx.workspaceId}
            cwd={ctx.cwd}
            rootPath={ctx.rootPath}
            shownEarlier={shownEarlier}
          />
        ) : block.type === "thinking" ? (
          <Thinking key={index} text={block.text} live />
        ) : block.toolUseId ? (
          <CallRow key={block.toolUseId} toolUseId={block.toolUseId} ctx={ctx} tools={tools} />
        ) : null,
      )}
    </div>
  );
}

/** The notices that report trouble, in its hue; the rest stay quiet. */
const NOTICE_TINT: Partial<Record<NoticeItem["code"], string>> = {
  error: "text-[var(--state-error-fg)]",
  dropped: "text-[var(--state-warning-fg)]",
  interrupted: "text-[var(--state-warning-fg)]",
};

/** Notices whose detail, the program's own words, is shown only on hover. */
const DETAIL_IN_TOOLTIP: ReadonlySet<NoticeItem["code"]> = new Set(["exited", "not_resumed"]);

/**
 * A report the app sent the agent manager of the sessions' changes: a line
 * naming the first session and how it stands, and how many more, which
 * opens to the report.
 */
function ManagerReport({ item }: { item: UserItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const lines = item.text.split("\n").slice(1);
  const [first, ...more] = reportedSessions(item.text);
  const state = first?.state ? t(`manager.state.${first.state}`) : "";
  const label = !first
    ? t("manager.report_empty")
    : more.length > 0
      ? t("manager.report_more", { title: first.title, count: more.length })
      : state
        ? `${first.title} · ${state}`
        : first.title;
  return (
    <div className="flex flex-col gap-1 text-app-micro text-muted-foreground" role="note">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 hover:text-foreground"
      >
        <div className="h-px flex-1 bg-border" />
        <Radio className="size-3.5 shrink-0" />
        <span className="max-w-[70%] truncate">{label}</span>
        <ChevronRight className={cn("size-3.5 shrink-0", open && "rotate-90")} />
        <div className="h-px flex-1 bg-border" />
      </button>
      {open && (
        <div className="rounded-(--radius-control) border border-border px-2 py-1.5 font-mono whitespace-pre-wrap break-words select-text">
          {lines.join("\n")}
        </div>
      )}
    </div>
  );
}

/** Where the conversation went on in another profile: its dot, its name, and when. */
function MoveLine({ move }: { move: ProfileMove }) {
  const { t } = useTranslation();
  const agent = useContext(ChatAgentContext);
  // The default profile is made anew each time: the config is what holds still.
  const config = useAgentProfilesStore((s) => s.config);
  const profile = profileOf(config, agent, move.profileId);
  return (
    <div
      className="flex items-center gap-2 text-app-micro text-muted-foreground"
      role="note"
      data-testid="chat-profile-move"
    >
      <div className="h-px flex-1 bg-border" />
      <ProfileDot color={profile.color} className="size-1.5" />
      <span className="max-w-[70%] truncate">
        {t("chat.profile.moved", { name: profileName(profile, t) })}
      </span>
      <MessageTime at={move.at} />
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  const { t } = useTranslation();
  const label = t(`chat.notice.${item.code}`, useAgentContext());
  return (
    <div className="flex items-center gap-2 text-app-micro text-muted-foreground" role="note">
      <div className="h-px flex-1 bg-border" />
      <span
        className={cn("max-w-[70%] truncate", NOTICE_TINT[item.code])}
        title={item.detail || label}
      >
        {label}
        {item.detail && !DETAIL_IN_TOOLTIP.has(item.code) ? ` · ${item.detail}` : ""}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <IconButton
      label={t("chat.copy")}
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

/** When a message was sent: relative, exact on hover. */
function MessageTime({ at }: { at?: number }) {
  const { t, i18n } = useTranslation();
  const now = useSharedClock(messageClock);
  if (at === undefined) return null;
  const exact = dateTimeFormat(i18n.language, DATE_AND_TIME).format(at);
  return (
    <time dateTime={new Date(at).toISOString()} title={exact} className="px-1 tabular-nums">
      {relativeTime(at, now, i18n.language, t("chat.time.now"))}
    </time>
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A time as "3분 전", or its date once it is a week old. */
export function relativeTime(at: number, now: number, locale: string, justNow: string): string {
  const ago = now - at;
  if (ago < MINUTE_MS) return justNow;
  const format = relativeTimeFormat(locale, RELATIVE);
  if (ago < HOUR_MS) return format.format(-Math.floor(ago / MINUTE_MS), "minute");
  if (ago < DAY_MS) return format.format(-Math.floor(ago / HOUR_MS), "hour");
  if (ago < 7 * DAY_MS) return format.format(-Math.floor(ago / DAY_MS), "day");
  return dateTimeFormat(locale, DATE_ONLY).format(at);
}

const RELATIVE: Intl.RelativeTimeFormatOptions = { numeric: "auto" };

// One clock for every message's time, ticking while any is shown.
const messageClock = sharedClock(30_000);
