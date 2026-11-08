// The conversation of a Claude tab: what it showed before (history), what
// the running program has said, and the reply streaming in. It stays at the
// bottom while the user is there, and leaves them be once they scroll up.

import {
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  GitFork,
  LoaderCircle,
  Radio,
  RotateCcw,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import { splitAttachments } from "../../services/chat/composer-input";
import {
  type AssistantBlock,
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  isWaiting,
  type NoticeItem,
  type StreamingMessage,
  type ToolCall,
  type UserItem,
} from "../../services/chat/model";
import { type AnswerExtras, answerExtras } from "../../services/chat/panel";
import { isOwnScroll, nearBottom } from "../../services/chat/stick-to-bottom";
import { foldToolRuns, type ShownBlock, tallyRun } from "../../services/chat/tool-runs";
import { isReport, reportedSessions } from "../../services/manager/report";
import { sentIn, useManagerStore } from "../../state/stores/manager";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { ManagerIcon } from "../manager/manager-chip";
import { AnswerExtrasView } from "./answer-extras";
import { useAgentContext } from "./chat-agent";
import { ChatImage } from "./chat-image";
import { ChatMarkdown } from "./chat-markdown";
import { AnsweredQuestions, PlanOutcome, showsAsPrompt } from "./prompt-rows";
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
}: MessageListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // Where the code last scrolled to; its scroll event is not the user's.
  const ownTop = useRef<number | null>(null);
  // Whether what shows before the first message is up.
  const emptyShown = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    ownTop.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
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
    const atBottom = nearBottom(el);
    stuck.current = atBottom;
    setShowJump(!atBottom);
  }, [toBottom]);

  // Growth from any source (a new item, a streamed word, an opened row)
  // keeps a stuck view at the bottom. What shows before the first message
  // (the welcome, the past sessions) reads from the top.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current && !emptyShown.current) toBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [toBottom]);

  // Sending a message brings the view back down.
  const lastUser = lastUserKey(model.items);
  useEffect(() => {
    if (!lastUser) return;
    stuck.current = true;
    toBottom();
  }, [lastUser, toBottom]);

  const historyItems = items ? [] : (history?.items ?? []);
  // A message Claude has not read yet waits above the box, not here.
  const liveItems = useMemo(
    () => items ?? model.items.filter((item) => !isWaiting(item)),
    [items, model.items],
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
  // Calls in a row fold into one line, which may take in later messages' calls.
  const shown = useMemo(
    () => foldToolRuns([...(items ? [] : (history?.items ?? [])), ...liveItems], tools),
    [items, history, liveItems, tools],
  );
  const ctx: ItemContext = { workspaceId, tabId, cwd, rootPath, tools, actions, extras, shown };

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
          {historyItems.map((item) => (
            <Item key={`h-${item.key}`} item={item} ctx={ctx} />
          ))}
          {liveItems.map((item) => (
            <Item key={item.key} item={item} ctx={ctx} />
          ))}
          {streaming && <Streaming streaming={streaming} ctx={ctx} />}
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

interface ItemContext {
  workspaceId: string;
  tabId: string | undefined;
  cwd: string;
  rootPath: string;
  tools: Record<string, ToolCall>;
  actions?: MessageActions;
  extras: Map<ChatItem, AnswerExtras>;
  /** What each assistant message shows, its calls in a row folded together. */
  shown: Map<AssistantItem, ShownBlock[]>;
}

const Item = memo(function Item({ item, ctx }: { item: ChatItem; ctx: ItemContext }) {
  switch (item.kind) {
    case "user":
      // The app's reports in the agent manager's conversation are no messages of the user's.
      if (isManagerWorkspace(ctx.workspaceId) && isReport(item.text)) {
        return <ManagerReport item={item} />;
      }
      return <UserBubble item={item} ctx={ctx} />;
    case "assistant":
      return <AssistantMessage item={item} ctx={ctx} />;
    case "notice":
      return <Notice item={item} />;
  }
});

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
            <ActionButton
              label={actions.running ? t("chat.rewind.busy") : t("chat.rewind.action")}
              blocked={actions.running}
              onClick={() => actions.onRewind(item)}
            >
              <RotateCcw className="size-3.5" />
            </ActionButton>
          )}
          {actions?.onFork && taken && (
            <ActionButton label={t("chat.fork.from_user")} onClick={() => actions.onFork?.(item)}>
              <GitFork className="size-3.5" />
            </ActionButton>
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

function AssistantMessage({ item, ctx }: { item: AssistantItem; ctx: ItemContext }) {
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
  const extras = ctx.extras.get(item);
  const blocks = ctx.shown.get(item) ?? item.blocks;
  // Its calls went into a run an earlier message shows.
  if (blocks.length === 0 && !extras) return null;
  return (
    <div className="group/assistant flex flex-col">
      {blocks.map((block, i) =>
        block.type === "run" ? (
          <ToolRun key={`run-${runKey(block.blocks)}`} blocks={block.blocks} ctx={ctx} />
        ) : block.type === "text" ? (
          <ChatMarkdown
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are only appended
            key={i}
            text={block.text}
            workspaceId={ctx.workspaceId}
            cwd={ctx.cwd}
            rootPath={ctx.rootPath}
          />
        ) : block.type === "thinking" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are only appended
          <Thinking key={i} text={block.text} />
        ) : (
          <CallRow key={block.toolUseId} toolUseId={block.toolUseId} ctx={ctx} />
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
            <ActionButton
              label={t("chat.fork.from_assistant")}
              onClick={() => ctx.actions?.onFork?.(item)}
            >
              <GitFork className="size-3.5" />
            </ActionButton>
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
function ToolRun({ blocks, ctx }: { blocks: AssistantBlock[]; ctx: ItemContext }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const calls = blocks.flatMap((block) =>
    block.type === "tool" ? [ctx.tools[block.toolUseId]] : [],
  );
  const running = calls.some(isLive);
  const tally = tallyRun(calls);
  const label = RUN_KINDS.filter((kind) => tally[kind] > 0)
    .map((kind) => t(`chat.tool.run.${kind}`, { count: tally[kind] }))
    .join(" · ");
  const rows = open
    ? blocks
    : blocks.filter((block) => block.type === "tool" && isLive(ctx.tools[block.toolUseId]));
  return (
    <div className="my-1 text-app-ui-sm" data-testid="chat-tool-run">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)]"
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
      {rows.length > 0 && (
        <div className="ml-4 border-l border-border pl-2">
          {rows.map((block, i) =>
            block.type === "tool" ? (
              <ToolRow
                key={block.toolUseId}
                toolUseId={block.toolUseId}
                tool={ctx.tools[block.toolUseId]}
                tools={ctx.tools}
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
function CallRow({ toolUseId, ctx }: { toolUseId: string; ctx: ItemContext }) {
  const tool = ctx.tools[toolUseId];
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
      tools={ctx.tools}
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

function Streaming({ streaming, ctx }: { streaming: StreamingMessage; ctx: ItemContext }) {
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
          />
        ) : block.type === "thinking" ? (
          <Thinking key={index} text={block.text} live />
        ) : block.toolUseId ? (
          <CallRow key={block.toolUseId} toolUseId={block.toolUseId} ctx={ctx} />
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
    <ActionButton
      label={t("chat.copy")}
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </ActionButton>
  );
}

/**
 * An icon button with its label as the tooltip. A blocked one keeps its
 * tooltip, which says why, and does nothing.
 */
function ActionButton({
  label,
  onClick,
  blocked = false,
  children,
}: {
  label: string;
  onClick: () => void;
  blocked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={blocked ? undefined : onClick}
      title={label}
      aria-label={label}
      aria-disabled={blocked || undefined}
      className={cn(
        "rounded-(--radius-control) p-1 text-muted-foreground",
        blocked
          ? "cursor-not-allowed opacity-40"
          : "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** When a message was sent: relative, exact on hover. */
function MessageTime({ at }: { at?: number }) {
  const { t, i18n } = useTranslation();
  const now = useSyncExternalStore(subscribeClock, clockNow);
  if (at === undefined) return null;
  const exact = new Date(at).toLocaleString(i18n.language);
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
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (ago < HOUR_MS) return format.format(-Math.floor(ago / MINUTE_MS), "minute");
  if (ago < DAY_MS) return format.format(-Math.floor(ago / HOUR_MS), "hour");
  if (ago < 7 * DAY_MS) return format.format(-Math.floor(ago / DAY_MS), "day");
  return new Date(at).toLocaleDateString(locale);
}

// One clock for every message's time, ticking while any is shown.
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockValue = Date.now();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockValue = Date.now();
    clockTimer = setInterval(() => {
      clockValue = Date.now();
      for (const l of clockListeners) l();
    }, 30_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function clockNow(): number {
  return clockValue;
}
