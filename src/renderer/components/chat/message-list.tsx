// The conversation of a Claude tab: what it showed before (history), what
// the running program has said, and the reply streaming in. It stays at the
// bottom while the user is there, and leaves them be once they scroll up.

import { Brain, Check, CheckCheck, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AssistantItem,
  ChatItem,
  ChatModel,
  NoticeItem,
  StreamingMessage,
  ToolCall,
  UserItem,
} from "../../services/chat/model";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { ChatMarkdown } from "./chat-markdown";
import { ToolRow } from "./tool-row";

interface MessageListProps {
  workspaceId: string;
  cwd: string;
  rootPath: string;
  history: ChatModel | null;
  model: ChatModel;
  /** Shown when there is no message yet. */
  empty?: React.ReactNode;
  /** Shown after the messages: the permission prompts, the turn's status. */
  footer?: React.ReactNode;
}

/** How near the bottom (px) still counts as being there. */
const STICK_SLACK_PX = 48;

export function MessageList({
  workspaceId,
  cwd,
  rootPath,
  history,
  model,
  empty,
  footer,
}: MessageListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
    stuck.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  // Growth from any source (a new item, a streamed word, an opened row)
  // keeps a stuck view at the bottom.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) toBottom();
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

  const historyItems = history?.items ?? [];
  const nothing = historyItems.length === 0 && model.items.length === 0 && !model.streaming;
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const ctx: ItemContext = { workspaceId, cwd, rootPath, tools };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto"
        data-testid="chat-messages"
      >
        <div ref={contentRef} className="mx-auto flex max-w-[860px] flex-col gap-3 px-4 py-4">
          {nothing && empty}
          {historyItems.map((item) => (
            <Item key={`h-${item.key}`} item={item} ctx={ctx} />
          ))}
          {model.items.map((item) => (
            <Item key={item.key} item={item} ctx={ctx} />
          ))}
          {model.streaming && <Streaming streaming={model.streaming} ctx={ctx} />}
          {footer}
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
  cwd: string;
  rootPath: string;
  tools: Record<string, ToolCall>;
}

const Item = memo(function Item({ item, ctx }: { item: ChatItem; ctx: ItemContext }) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} />;
    case "assistant":
      return <AssistantMessage item={item} ctx={ctx} />;
    case "notice":
      return <Notice item={item} />;
  }
});

function UserBubble({ item }: { item: UserItem }) {
  const { t } = useTranslation();
  return (
    <div className="group/user flex flex-col items-end gap-1">
      {item.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.images.map((image, i) => (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's images keep their order
              key={i}
              src={`data:${image.mediaType};base64,${image.data}`}
              alt=""
              className="max-h-32 max-w-48 rounded-(--radius-control) border border-border object-cover"
            />
          ))}
        </div>
      )}
      {item.text && (
        <div className="max-w-[85%] rounded-(--radius-raised) bg-muted px-3 py-2 text-app-body whitespace-pre-wrap break-words select-text">
          {item.text}
        </div>
      )}
      <div className="flex items-center gap-1 text-app-micro text-muted-foreground">
        <CopyButton text={item.text} className="opacity-0 group-hover/user:opacity-100" />
        <span
          title={item.state === "taken" ? t("chat.message.taken") : t("chat.message.sent")}
          role="img"
          aria-label={item.state === "taken" ? t("chat.message.taken") : t("chat.message.sent")}
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
  const text = item.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  return (
    <div className="group/assistant flex flex-col">
      {item.blocks.map((block, i) =>
        block.type === "text" ? (
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
          <ToolRow
            key={block.toolUseId}
            toolUseId={block.toolUseId}
            tool={ctx.tools[block.toolUseId]}
            tools={ctx.tools}
            cwd={ctx.cwd}
          />
        ),
      )}
      {text && (
        <div className="mt-1 flex opacity-0 group-hover/assistant:opacity-100">
          <CopyButton text={text} />
        </div>
      )}
    </div>
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
          <ToolRow
            key={block.toolUseId}
            toolUseId={block.toolUseId}
            tool={ctx.tools[block.toolUseId]}
            tools={ctx.tools}
            cwd={ctx.cwd}
          />
        ) : null,
      )}
    </div>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  const { t } = useTranslation();
  const label = t(`chat.notice.${item.code}`);
  return (
    <div className="flex items-center gap-2 text-app-micro text-muted-foreground" role="note">
      <div className="h-px flex-1 bg-border" />
      <span className="max-w-[70%] truncate" title={item.detail || label}>
        {label}
        {item.detail && item.code !== "exited" ? ` · ${item.detail}` : ""}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={t("chat.copy")}
      aria-label={t("chat.copy")}
      className={cn(
        "rounded-(--radius-control) p-1 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
