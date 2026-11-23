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
  FileText,
  GitFork,
  MessageSquareShare,
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
import { shownNoteText } from "../../../shared/notes/line-report";
import type { ProfileMove } from "../../../shared/types/layout";
import { shortId } from "../../../shared/util/short-id";
import { sharedClock, useSharedClock } from "../../hooks/use-now";
import { revealInWorkspace } from "../../services/agent-sessions/actions";
import { artifactOf } from "../../services/chat/artifact";
import { useChatFiles } from "../../services/chat/chat-files";
import { splitAttachments } from "../../services/chat/composer-input";
import { callsUnder, type ItemView, itemView, sameView } from "../../services/chat/item-view";
import { fileKind } from "../../services/chat/links";
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
  answerExtras,
  exitCodeOf,
  imagesShownEarlier,
  SEND_FILES_TOOL,
} from "../../services/chat/panel";
import { followsMessage } from "../../services/chat/profile-moves";
import { RELAY_KINDS, withRelayed } from "../../services/chat/relayed";
import type { ToolRowStatuses } from "../../services/chat/running";
import { isOwnScroll, nearBottom, scrolledDown } from "../../services/chat/stick-to-bottom";
import { foldToolRuns, tallyRun } from "../../services/chat/tool-runs";
import { showPeerSession } from "../../services/remote/show-peer";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { isAgentViewShown } from "../../state/stores/agent-view";
import { useTabsStore } from "../../state/stores/tabs";
import { cn } from "../../utils/cn";
import { DATE_AND_TIME, dateTimeFormat } from "../../utils/intl-format";
import { relativeTime } from "../../utils/time-format";
import { ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { SaveAnswerMenu } from "../notes/save-answer-menu";
import { CopyButton } from "../ui/copy-button";
import { IconButton } from "../ui/icon-button";
import { ToggleChevron } from "../ui/toggle-chevron";
import { AnswerExtrasView } from "./answer-extras";
import { ArtifactCard } from "./artifact-card";
import { ChatAgentContext, useAgentContext } from "./chat-agent";
import { ChatImage, ToolThumbs } from "./chat-image";
import { LinkPlacesContext, useChatLinks, usePlacesOf } from "./chat-links";
import { ChatMarkdown } from "./chat-markdown";
import { FileKindIcon } from "./file-kind-icon";
import { AnsweredQuestions, PlanOutcome, showsAsPrompt } from "./prompt-rows";
import { SentFiles } from "./sent-files";
import { ToolRow } from "./tool-row";
import { ToolRunLine } from "./tool-run-line";

const NO_TOOL_STATUSES: ToolRowStatuses = {};

interface MessageListProps {
  workspaceId: string;
  tabId?: string;
  cwd: string;
  rootPath: string;
  history: ChatModel | null;
  model: ChatModel;
  toolStatuses?: ToolRowStatuses;
  empty?: React.ReactNode;
  actions?: MessageActions;
  items?: ChatItem[];
  itemsDone?: boolean;
  reveal?: CallReveal | null;
  moves?: readonly ShownMove[];
  relayed?: readonly RelayedMessage[];
  older?: OlderMessages;
  historyTruncated?: boolean;
}

export interface OlderMessages {
  count?: number;
  hasEarlier?: boolean;
  loading: boolean;
  load(): void;
}

export type ShownMove = ProfileMove & { label?: string };

export interface CallReveal {
  toolUseId: string;
  seq: number;
}

interface ShownCall {
  ids: ReadonlySet<string>;
  seq: number;
}

function callChain(toolUseId: string, tools: Record<string, ToolCall>): string[] {
  const chain: string[] = [];
  for (let id: string | null | undefined = toolUseId; id && !chain.includes(id); ) {
    chain.push(id);
    id = tools[id]?.parentToolUseId;
  }
  return chain;
}

const REVEAL_FRAMES = 2;

function showCallRow(view: HTMLElement, content: HTMLElement, chain: readonly string[]): boolean {
  for (const id of chain) {
    const row = content.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    const offset = row.getBoundingClientRect().top - view.getBoundingClientRect().top;
    view.scrollTop += offset - Math.max(0, (view.clientHeight - row.offsetHeight) / 2);
    row.classList.remove("chat-call-flash");
    void row.offsetWidth;
    row.classList.add("chat-call-flash");
    row.addEventListener("animationend", () => row.classList.remove("chat-call-flash"), {
      once: true,
    });
    return true;
  }
  return false;
}

export interface MessageActions {
  running: boolean;
  canFork: boolean;
  onFork?: (item: UserItem | AssistantItem) => void;
  canForkItem?: (item: UserItem | AssistantItem) => boolean;
  canRewindItem?: (item: UserItem) => boolean;
  onRewind?: (item: UserItem) => void;
  onRecoverSubmission?: (itemKey: string) => void;
  onBackground?: (toolUseId: string) => void;
  waiting?: ReadonlySet<string>;
  taskShower?: (item: TaskEndItem) => (() => void) | undefined;
}

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
  toolStatuses = NO_TOOL_STATUSES,
  empty,
  actions,
  items,
  itemsDone = false,
  reveal,
  moves,
  relayed,
  older,
  historyTruncated,
}: MessageListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);
  const emptyShown = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [more, setMore] = useState(0);
  const anchor = useRef<{
    height: number;
    top: number;
    row?: HTMLElement;
    rowTop?: number;
    historyCount?: number;
  } | null>(null);

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
      stuck.current = true;
      setShowJump(false);
      return;
    }
    if (isOwnScroll(el, ownTop.current)) {
      if (stuck.current) toBottom();
      return;
    }
    ownTop.current = null;
    if (stuck.current && down) {
      toBottom();
      return;
    }
    const atBottom = nearBottom(el);
    stuck.current = atBottom;
    setShowJump(!atBottom);
  }, [toBottom]);

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
  const nothing =
    historyItems.length === 0 &&
    liveItems.length === 0 &&
    !streaming &&
    !older?.hasEarlier &&
    !historyTruncated;
  emptyShown.current = nothing && empty !== undefined;
  const tools = useMemo(
    () => (history ? { ...history.tools, ...model.tools } : model.tools),
    [history, model.tools],
  );
  const turnDone = items ? itemsDone : !model.running && !streaming;
  const chatFiles = useChatFiles();
  const extras = useMemo(
    () =>
      answerExtras(
        items ?? [...(history?.items ?? []), ...model.items],
        tools,
        cwd,
        rootPath,
        turnDone,
        !chatFiles,
      ),
    [items, history, model.items, tools, cwd, rootPath, turnDone, chatFiles],
  );
  const shownItems = useMemo(() => [...historyItems, ...liveItems], [historyItems, liveItems]);
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
  const shown = useMemo(() => foldToolRuns(windowItems, tools), [windowItems, tools]);
  const movesAfter = useMemo(() => {
    const after = new Map<ChatItem, ShownMove[]>();
    if (items || !moves) return after;
    for (const move of moves) {
      const item = shownItems.findLast((i) => followsMessage(i, move.after));
      if (item) after.set(item, [...(after.get(item) ?? []), move]);
    }
    return after;
  }, [items, moves, shownItems]);
  const earlier = useMemo(
    () => imagesShownEarlier(windowItems, tools, cwd),
    [windowItems, tools, cwd],
  );
  const latestTools = useRef(tools);
  latestTools.current = tools;
  const placesOf = usePlacesOf(tools);
  const shownCall = useMemo<ShownCall | undefined>(
    () =>
      reveal
        ? { ids: new Set(callChain(reveal.toolUseId, latestTools.current)), seq: reveal.seq }
        : undefined,
    [reveal],
  );
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
      stuck.current = false;
      showCallRow(view, content, [...shownCall.ids]);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [shownCall]);
  const unread = older?.count ?? 0;
  const showEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      const top = el.getBoundingClientRect().top;
      const row = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? [],
      )
        .map((wrapper) => wrapper.firstElementChild)
        .find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.getBoundingClientRect().bottom > top,
        );
      anchor.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
        row,
        rowTop: row?.getBoundingClientRect().top,
        historyCount: start === 0 && older?.hasEarlier ? historyItems.length : undefined,
      };
    }
    stuck.current = false;
    if (start > 0) setMore((m) => m + WINDOW_ITEMS);
    else older?.load();
  }, [start, older, historyItems.length]);
  const wasUnread = useRef(unread);
  useLayoutEffect(() => {
    const count = wasUnread.current - unread;
    wasUnread.current = unread;
    if (count > 0) setMore((m) => m + count);
  }, [unread]);
  const historyRead = useRef(false);
  useLayoutEffect(() => {
    const before = anchor.current?.historyCount;
    if (before === undefined || older?.loading) return;
    const added = historyItems.length - before;
    if (added > 0) {
      historyRead.current = true;
      setMore((m) => m + added);
    } else {
      anchor.current = null;
    }
  }, [historyItems.length, older?.loading]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const was = anchor.current;
    if (!el || !was || more === 0 || (was.historyCount !== undefined && !historyRead.current))
      return;
    anchor.current = null;
    historyRead.current = false;
    el.scrollTop =
      was.row?.isConnected && was.rowTop !== undefined
        ? el.scrollTop + was.row.getBoundingClientRect().top - was.rowTop
        : was.top + (el.scrollHeight - was.height);
    ownTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  }, [more]);

  const wholeConversation = items === undefined;
  const ctx = useMemo<ItemContext>(
    () => ({ workspaceId, tabId, cwd, rootPath, actions, wholeConversation }),
    [workspaceId, tabId, cwd, rootPath, actions, wholeConversation],
  );
  const under = useMemo(() => callsUnder(tools), [tools]);
  const views = useMemo(() => {
    const sources = {
      tools,
      toolStatuses,
      callsUnder: under,
      shown,
      extras,
      earlier,
      asked: shownCall,
    };
    const out = new Map<ChatItem, ItemView>();
    for (const item of windowItems) {
      const view = itemView(item, sources);
      if (view) out.set(item, view);
    }
    return out;
  }, [windowItems, tools, toolStatuses, under, shown, extras, earlier, shownCall]);

  const list = (
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
            nothing && empty ? "min-h-full" : undefined,
          )}
        >
          {nothing && empty}
          {historyTruncated && start + unread === 0 && !older?.hasEarlier && (
            <p className="text-center text-app-micro text-muted-foreground">
              {t("chat.history_truncated")}
            </p>
          )}
          {(start + unread > 0 || older?.hasEarlier) && (
            <button
              type="button"
              onClick={showEarlier}
              disabled={start === 0 && older?.loading}
              className="self-center rounded-(--radius-control) border border-border px-3 py-1 text-app-micro text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {older?.hasEarlier
                ? t("chat.show_earlier_unknown")
                : t("chat.show_earlier", { count: start + unread })}
            </button>
          )}
          {historyItems.slice(Math.min(start, historyItems.length)).map((item) => (
            <Fragment key={`h-${item.key}`}>
              <div className="contents" data-chat-row>
                <Item item={item} ctx={ctx} view={views.get(item)} />
              </div>
              {movesAfter.get(item)?.map((move) => (
                <MoveLine key={`m-${move.at}`} move={move} />
              ))}
            </Fragment>
          ))}
          {liveItems.slice(Math.max(0, start - historyItems.length)).map((item) => (
            <Fragment key={item.key}>
              <div className="contents" data-chat-row>
                <Item item={item} ctx={ctx} view={views.get(item)} />
              </div>
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
              toolStatuses={toolStatuses}
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
  return <LinkPlacesContext.Provider value={placesOf}>{list}</LinkPlacesContext.Provider>;
}

function lastUserKey(items: ChatItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") return items[i].key;
  }
  return undefined;
}

interface ItemContext {
  workspaceId: string;
  tabId: string | undefined;
  cwd: string;
  rootPath: string;
  actions?: MessageActions;
  wholeConversation: boolean;
}

interface ItemProps {
  item: ChatItem;
  ctx: ItemContext;
  view: ItemView | undefined;
}

const Item = memo(function Item({ item, ctx, view }: ItemProps) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} ctx={ctx} />;
    case "assistant":
      return (
        <AssistantMessage
          item={item}
          ctx={ctx}
          view={
            view ?? {
              blocks: item.blocks,
              tools: {},
              toolStatuses: NO_TOOL_STATUSES,
              earlier: new Map(),
            }
          }
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

const NAMED_SOURCES: ReadonlySet<string> = new Set(["peer", "channel", "coordinator"]);

const RECEIVED_LINES = 6;

function ReceivedBubble({ item }: { item: ReceivedItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { kind, name } = item.from;
  const what = NAMED_SOURCES.has(kind)
    ? t(`chat.received.${name ? "from_" : ""}${kind}`)
    : t("chat.received.from_kind", { kind });
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
        {item.text && <CopyButton text={item.text} label={t("chat.copy")} />}
      </div>
    </div>
  );
}

function showTab(workspaceId: string, tabId: string): void {
  if (isAgentViewShown()) revealTabById(workspaceId, tabId);
  else revealInWorkspace({ workspaceId, tabId });
}

function RelaySenderLine({ from }: { from: MessageSource }) {
  const { t } = useTranslation();
  const { workspaceId, tabId, device } = from;
  const title = useTabsStore((s) =>
    !device && workspaceId && tabId ? s.byWorkspace[workspaceId]?.[tabId]?.title : undefined,
  );
  if (device) return <PeerSenderLine from={from} device={device} />;
  if (from.kind === "manager") {
    return <span className="shrink-0">{t("chat.received.manager")}</span>;
  }
  if (from.kind === "app") {
    return <span className="shrink-0">{t("chat.received.app")}</span>;
  }
  if (from.kind === "terminal" && !from.agent) {
    return <span className="shrink-0">{t("chat.received.unknown")}</span>;
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

function PeerSenderLine({
  from,
  device,
}: {
  from: MessageSource;
  device: { id: string; name: string };
}) {
  const { t } = useTranslation();
  const { workspaceId, tabId } = from;
  const agent = from.agent === "codex" ? "Codex" : "Claude Code";
  const what =
    from.kind === "manager"
      ? t("chat.received.manager")
      : from.kind === "terminal"
        ? t("chat.received.from_terminal", { agent })
        : t("chat.received.from_tab");
  const label =
    from.name && from.kind !== "manager" ? `${device.name} · ${from.name}` : device.name;
  const nameClass = "min-w-0 truncate font-medium text-[var(--chat-received-fg)]";
  return (
    <>
      {workspaceId && tabId ? (
        <button
          type="button"
          className={cn(nameClass, "hover:underline")}
          title={t("chat.received.show_tab")}
          onClick={() =>
            void showPeerSession({
              device,
              workspaceId,
              tabId,
              kind:
                from.kind === "terminal" ? "terminal" : from.agent === "codex" ? "codex" : "claude",
              title: from.name ?? shortId(tabId),
            })
          }
        >
          {label}
        </button>
      ) : (
        <span className={nameClass}>{label}</span>
      )}
      <span className="shrink-0">{what}</span>
    </>
  );
}

function namedIn(summary: string | undefined): string | undefined {
  return summary?.match(/"([\s\S]+)"/)?.[1];
}

const AGENT_TASKS: ReadonlySet<string> = new Set([
  "local_agent",
  "remote_agent",
  "in_process_teammate",
]);

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

function AttachedFile({ path, sending }: { path: string; sending: boolean }) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const name = path.split(/[\\/]/).pop() ?? path;
  const chip =
    "flex max-w-56 items-center gap-1.5 rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm";
  if (!links || sending || fileKind(path) !== "image" || links.opensAttached?.(path) === false) {
    return (
      <span title={path} className={chip}>
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => links.openFile(path)}
      title={path}
      aria-label={`${t("chat.links.look")}: ${name}`}
      className={cn(
        chip,
        "cursor-zoom-in hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      data-testid="chat-attached-image"
    >
      <FileKindIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function UserBubble({ item, ctx }: { item: UserItem; ctx: ItemContext }) {
  const { t } = useTranslation();
  const agent = useAgentContext();
  const { actions } = ctx;
  const taken = item.uuid !== undefined;
  const optimistic = item.optimistic;
  const parts = splitAttachments(item.text);
  const text = shownNoteText(optimistic ? item.text : parts.text);
  const files = optimistic?.fileNames ?? parts.files;
  const status = optimistic?.status;
  const submittedAt = optimistic?.submittedAt;
  useEffect(() => {
    if (!import.meta.env.DEV || submittedAt === undefined) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        performance.clearMeasures("peer-chat.submit-to-painted-frame");
        performance.measure("peer-chat.submit-to-painted-frame", {
          start: submittedAt,
          end: performance.now(),
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [submittedAt]);
  return (
    <div className="group/user flex flex-col items-end gap-1">
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
            <AttachedFile key={path} path={path} sending={optimistic !== undefined} />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-(--radius-raised) bg-[var(--chat-user-bg)] px-3 py-2 text-app-body whitespace-pre-wrap break-words select-text">
          {text}
        </div>
      )}
      {optimistic ? (
        <div className="flex items-center gap-2 text-app-micro text-muted-foreground">
          <span role="status" title={optimistic.error}>
            {t(`chat.message.peer_${status}`, {
              context: optimistic.queued ? "queued" : undefined,
            })}
          </span>
          {(status === "failed" || status === "unconfirmed") && actions?.onRecoverSubmission && (
            <button
              type="button"
              className="rounded-(--radius-control) px-1 text-primary hover:bg-[var(--state-hover-bg)]"
              onClick={() => actions.onRecoverSubmission?.(item.key)}
            >
              {t("chat.message.peer_recover")}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-app-micro text-muted-foreground">
          <div className="flex items-center gap-1 opacity-0 group-focus-within/user:opacity-100 group-hover/user:opacity-100">
            <MessageTime at={item.at} />
            {item.text && <CopyButton text={item.text} label={t("chat.copy")} />}
            {actions?.onRewind && (actions.canRewindItem?.(item) ?? taken) && (
              <IconButton
                label={actions.running ? t("chat.rewind.busy") : t("chat.rewind.action")}
                blocked={actions.running}
                onClick={() => actions.onRewind?.(item)}
              >
                <RotateCcw className="size-3.5" />
              </IconButton>
            )}
            {actions?.onFork && (actions.canForkItem?.(item) ?? taken) && (
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
      )}
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
  const forkable =
    ctx.actions?.canFork &&
    ctx.actions.onFork !== undefined &&
    (ctx.actions.canForkItem?.(item) ??
      (item.uuid !== undefined && item.blocks.at(-1)?.type === "text"));
  const { blocks, extras } = view;
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
            toolStatuses={view.toolStatuses}
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
          <CopyButton text={text} label={t("chat.copy")} />
          {forkable && ctx.actions && (
            <IconButton
              label={t("chat.fork.from_assistant")}
              onClick={() => ctx.actions?.onFork?.(item)}
            >
              <GitFork className="size-3.5" />
            </IconButton>
          )}
          {ctx.wholeConversation && ctx.tabId && (
            <SaveAnswerMenu claudeUuid={item.uuid} messageId={item.messageId} markdown={text} />
          )}
          <MessageTime at={item.at} />
        </div>
      )}
    </div>
  );
}

function runKey(blocks: AssistantBlock[]): string {
  const first = blocks.find((block) => block.type === "tool");
  return first?.type === "tool" ? first.toolUseId : "";
}

function ToolRun({
  blocks,
  ctx,
  view,
}: {
  blocks: AssistantBlock[];
  ctx: ItemContext;
  view: ItemView;
}) {
  const [open, setOpen] = useState(false);
  const { tools, toolStatuses } = view;
  const asked = view.asked;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once; a call joining the run later does not open it again
  useEffect(() => {
    if (asked && blocks.some((block) => block.type === "tool" && asked.ids.has(block.toolUseId))) {
      setOpen(true);
    }
  }, [asked]);
  const calls = blocks.flatMap((block) => (block.type === "tool" ? [tools[block.toolUseId]] : []));
  const live = blocks.filter((block) => {
    if (block.type !== "tool") return false;
    const status = toolStatuses[block.toolUseId] ?? tools[block.toolUseId]?.status;
    return !status || status === "running" || status === "streaming" || status === "background";
  });
  const rows = open ? blocks : live;
  return (
    <ToolRunLine
      tally={tallyRun(calls, toolStatuses)}
      running={live.length > 0}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      beside={<ToolThumbs calls={calls} />}
    >
      {rows.length > 0 &&
        rows.map((block, i) =>
          block.type === "tool" ? (
            <ToolRow
              key={block.toolUseId}
              toolUseId={block.toolUseId}
              tool={tools[block.toolUseId]}
              tools={tools}
              toolStatuses={toolStatuses}
              cwd={ctx.cwd}
              onBackground={backgroundOf(ctx.actions, block.toolUseId)}
            />
          ) : block.type === "thinking" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a run's blocks are only appended
            <Thinking key={i} text={block.text} />
          ) : null,
        )}
    </ToolRunLine>
  );
}

function CallRow({
  toolUseId,
  ctx,
  tools,
  toolStatuses,
  shownEarlier,
}: {
  toolUseId: string;
  ctx: ItemContext;
  tools: Readonly<Record<string, ToolCall>>;
  toolStatuses: ToolRowStatuses;
  shownEarlier?: ReadonlySet<string>;
}) {
  const tool = tools[toolUseId];
  const page = artifactOf(tool, ctx.cwd);
  if (page) {
    return <ArtifactCard page={page} workspaceId={ctx.workspaceId} rootPath={ctx.rootPath} />;
  }
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
      toolStatuses={toolStatuses}
      cwd={ctx.cwd}
      onBackground={backgroundOf(ctx.actions, toolUseId)}
    />
  );
}

export function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = live ? t("chat.thinking_live") : t("chat.thinking");
  if (text.trim() === "") {
    return (
      <div className="my-1 flex items-center gap-1.5 px-1.5 py-1 text-app-ui-sm text-muted-foreground">
        <Brain className={cn("size-3.5", live && "animate-pulse")} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className="my-1 text-app-ui-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 hover:bg-[var(--state-hover-bg)]"
      >
        <Brain className={cn("size-3.5", live && "animate-pulse")} />
        <span>{label}</span>
        <ToggleChevron open={open} className="text-current" />
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
  toolStatuses,
  shownEarlier,
}: {
  streaming: StreamingMessage;
  ctx: ItemContext;
  tools: Record<string, ToolCall>;
  toolStatuses: ToolRowStatuses;
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
          <CallRow
            key={block.toolUseId}
            toolUseId={block.toolUseId}
            ctx={ctx}
            tools={tools}
            toolStatuses={toolStatuses}
          />
        ) : null,
      )}
    </div>
  );
}

const NOTICE_TINT: Partial<Record<NoticeItem["code"], string>> = {
  error: "text-[var(--state-error-fg)]",
  dropped: "text-[var(--state-warning-fg)]",
  interrupted: "text-[var(--state-warning-fg)]",
};

const DETAIL_IN_TOOLTIP: ReadonlySet<NoticeItem["code"]> = new Set(["exited", "not_resumed"]);

function MoveLine({ move }: { move: ShownMove }) {
  const { t } = useTranslation();
  const agent = useContext(ChatAgentContext);
  const config = useAgentProfilesStore((s) => s.config);
  const own = profileOf(config, agent, move.profileId);
  const profile = move.label === undefined ? own : { ...own, color: "gray" as const };
  const name = move.label ?? profileName(own, t);
  return (
    <div
      className="flex items-center gap-2 text-app-micro text-muted-foreground"
      role="note"
      data-testid="chat-profile-move"
    >
      <div className="h-px flex-1 bg-border" />
      <ProfileDot color={profile.color} className="size-1.5" />
      <span className="max-w-[70%] truncate">{t("chat.profile.moved", { name })}</span>
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

function MessageTime({ at }: { at?: number }) {
  const { i18n } = useTranslation();
  const now = useSharedClock(messageClock);
  if (at === undefined) return null;
  const exact = dateTimeFormat(i18n.language, DATE_AND_TIME).format(at);
  return (
    <time dateTime={new Date(at).toISOString()} title={exact} className="px-1 tabular-nums">
      {relativeTime(at, now, i18n.language)}
    </time>
  );
}

const messageClock = sharedClock(30_000);
