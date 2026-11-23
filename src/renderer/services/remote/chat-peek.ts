/**
 * A Claude or Codex tab's last turns at a glance, as another device's
 * preview reads them (chat.peek): from the conversation an open tab holds,
 * or from the end of its history as its agent keeps it (a Claude
 * transcript's last page, a Codex rollout's last events). Pure: what reads
 * the tab and its history is the caller's.
 */

import {
  type ChatPeek,
  type ChatPeekTurn,
  clipHead,
  DEFAULT_PEEK_TURNS,
  fitPeek,
  MAX_PEEK_TOOL_NAME,
  MAX_PEEK_TURNS,
  peekTools,
} from "../../../../packages/remote-protocol/src";
import { RELAY_MARK, type RelayedMessage, withoutRelayHeader } from "../../../shared/chat/relay";
import type {
  ChatPeekTail,
  RolloutEvent,
  TranscriptPageResult,
} from "../../../shared/ipc/contract";
import { historyModel } from "../chat/claude/history";
import { TranscriptPages } from "../chat/claude/transcript-pages";
import { splitAttachments } from "../chat/composer-input";
import { type ChatItem, isWaiting, type ToolCall } from "../chat/model";
import { withRelayed } from "../chat/relayed";
import { type ChatSource, conversationOf } from "./chat-page";

/** How many more pages of a transcript a peek reads when its last holds no whole turn. */
export const PEEK_MORE_PAGES = 3;

/** How many turns a peek gives: those asked for, DEFAULT_PEEK_TURNS when none, MAX_PEEK_TURNS at most. */
export function peekTurnCount(turns: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(turns ?? DEFAULT_PEEK_TURNS), MAX_PEEK_TURNS));
}

/**
 * Who sent a message through the nexus command, as the line before it says
 * (relayHeader): for one whose record the tab no longer keeps.
 */
function senderOf(text: string): string {
  const line = text.slice(
    RELAY_MARK.length,
    text.indexOf("\n") < 0 ? undefined : text.indexOf("\n"),
  );
  const named =
    /^(?:The ("(?:[^"\\]|\\.)*") tab \(|(?:Claude Code|Codex) in the ("(?:[^"\\]|\\.)*") terminal)/.exec(
      line,
    );
  const quoted = named?.[1] ?? named?.[2];
  if (quoted) {
    try {
      const name: unknown = JSON.parse(quoted);
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // Not as the line is written: told by its kind.
    }
  }
  if (line.startsWith("The manager")) return "manager";
  if (line.startsWith("NexusCode, the app")) return "app";
  if (line.includes(" terminal")) return "terminal";
  return "tab";
}

/** Written during a turn and not read yet (isWaiting, without narrowing the item). */
const waits = (item: ChatItem): boolean => isWaiting(item);

/**
 * The turns of a conversation's items (as withRelayed gives them), oldest
 * first: each begins at a message, the user's or another sender's. What
 * the agent wrote before the first message there is a turn with neither.
 * A message waiting for the agent to read it began none yet.
 */
export function peekTurnsOf(
  items: readonly ChatItem[],
  tools: Readonly<Record<string, ToolCall>>,
): ChatPeekTurn[] {
  const turns: {
    begun: Pick<ChatPeekTurn, "user" | "received">;
    reply: string;
    names: string[];
  }[] = [];
  let open: (typeof turns)[number] | undefined;
  const begin = (begun: Pick<ChatPeekTurn, "user" | "received">) => {
    open = { begun, reply: "", names: [] };
    turns.push(open);
    return open;
  };
  for (const item of items) {
    if (item.kind === "received") {
      const { name, agent, kind } = item.from;
      begin({ received: { from: name || agent || kind, text: item.text } });
    } else if (item.kind === "user") {
      if (waits(item) || item.peerWritePending) continue;
      // One another agent sent, whose record the tab no longer keeps: still not the user's.
      if (item.text.startsWith(RELAY_MARK)) {
        begin({ received: { from: senderOf(item.text), text: withoutRelayHeader(item.text) } });
        continue;
      }
      const { text, files } = splitAttachments(item.text);
      begin({
        user: {
          text,
          images: item.images.length,
          ...(files.length > 0 ? { files: files.length } : {}),
        },
      });
    } else if (item.kind === "assistant") {
      const turn = open ?? begin({});
      const texts = item.blocks.flatMap((block) =>
        block.type === "text" && block.text.trim() !== "" ? [block.text] : [],
      );
      if (texts.length > 0) turn.reply = texts.join("\n\n");
      for (const block of item.blocks) {
        if (block.type !== "tool") continue;
        const tool = tools[block.toolUseId];
        if (tool && tool.parentToolUseId === null) turn.names.push(tool.name);
      }
    }
  }
  return turns.map(({ begun, reply, names }) => ({ ...begun, reply, ...peekTools(names) }));
}

/** The last `want` turns, and whether there are more before them. */
function lastTurns(
  turns: ChatPeekTurn[],
  want: number,
  earlier: boolean,
): Pick<ChatPeek, "turns" | "more"> {
  const more = earlier || turns.length > want;
  return { turns: turns.slice(-want), ...(more ? { more: true as const } : {}) };
}

/** What an open tab waits on the user for, as the sessions' rows tell it. */
function waitingOf(source: ChatSource): ChatPeek["waiting"] {
  const request = source.chat.model.permissions[0];
  if (!request) return undefined;
  if (request.toolName === "AskUserQuestion") return { kind: "question" };
  if (request.toolName === "ExitPlanMode") return { kind: "plan" };
  const tool = clipHead(request.toolName, MAX_PEEK_TOOL_NAME);
  return { kind: "permission", ...(tool ? { tool } : {}) };
}

/** An open tab's last turns and where it stands, from the conversation it holds. */
export function peekOfChat(source: ChatSource, turns?: number): ChatPeek {
  const { chat } = source;
  const { model } = chat;
  const { items, tools } = conversationOf(source);
  const streaming = model.running
    ? Object.entries(model.streaming?.blocks ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .flatMap(([, block]) => (block.type === "text" && block.text !== "" ? [block.text] : []))
        .join("\n\n")
    : "";
  const waiting = waitingOf(source);
  return fitPeek({
    status: {
      running: model.running,
      phase: chat.phase,
      ...(streaming ? { streaming } : {}),
    },
    ...lastTurns(
      peekTurnsOf(items, tools),
      peekTurnCount(turns),
      chat.truncated || chat.historyPage?.hasEarlier === true,
    ),
    ...(waiting ? { waiting } : {}),
  });
}

/** A tab that is not open: no turn runs, and it waits on nothing. */
const COLD: ChatPeek["status"] = { running: false, phase: "idle" };

/** The answer for a chat no turns of which could be read. */
export function peekUnavailable(why: NonNullable<ChatPeek["unavailable"]>): ChatPeek {
  return { status: COLD, turns: [], unavailable: why };
}

/** Whether the items hold a message that began a turn. */
const hasTurn = (items: readonly ChatItem[]) =>
  items.some((item) => item.kind === "received" || (item.kind === "user" && !waits(item)));

/**
 * A Claude transcript's end, read a page at a time from its last: enough
 * for a peek once it holds a whole row and a message that began a turn, or
 * PEEK_MORE_PAGES more were read.
 */
export class ClaudeTail {
  private readonly pages: TranscriptPages | null;
  private readonly first: TranscriptPageResult;
  private read = 0;

  constructor(first: TranscriptPageResult) {
    this.first = first;
    this.pages = first.found && first.snapshot ? new TranscriptPages(first, first.snapshot) : null;
  }

  private model() {
    return this.pages ? this.pages.project() : historyModel(this.first.lines);
  }

  /** Where to read the page before, when more is needed; undefined when not. */
  get cursor(): string | undefined {
    if (!this.pages?.cursor || this.read >= PEEK_MORE_PAGES) return undefined;
    return this.pages.hasPartialRow || !hasTurn(this.model().items) ? this.pages.cursor : undefined;
  }

  prepend(page: TranscriptPageResult): void {
    this.read += 1;
    this.pages?.prepend(page);
  }

  peek(relayed: readonly RelayedMessage[] | undefined, turns?: number): ChatPeek {
    if (!this.first.found) return peekUnavailable("missing");
    const { items, tools } = this.model();
    const earlier = this.first.truncated || (this.pages?.hasEarlier ?? false);
    return fitPeek({
      status: COLD,
      ...lastTurns(peekTurnsOf(withRelayed(items, relayed), tools), peekTurnCount(turns), earlier),
    });
  }
}

/** The name a Codex call's tool has in the tab (codexItemTools), one for each file a patch changes. */
function rolloutTools(event: RolloutEvent): string[] {
  switch (event.tool) {
    case "commandExecution":
      return ["Bash"];
    case "fileChange": {
      const kinds = event.changes?.length ? event.changes : ["update"];
      return kinds.map((kind) =>
        kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit",
      );
    }
    case "mcpToolCall":
      return [`mcp__${event.server ?? ""}__${event.name ?? ""}`];
    case "dynamicToolCall":
      return [event.name || "tool"];
    case "webSearch":
      return ["WebSearch"];
    case "imageView":
      return ["ViewImage"];
    case "collabAgentToolCall":
      return [event.name || "agent"];
    default:
      return [];
  }
}

/** A Codex thread's last turns, from the events at the end of its rollout. */
export function peekOfRollout(
  tail: NonNullable<ChatPeekTail["codex"]>,
  relayed: readonly RelayedMessage[] | undefined,
  turns?: number,
): ChatPeek {
  if (!tail.found) return peekUnavailable("missing");
  const items: ChatItem[] = [];
  const tools: Record<string, ToolCall> = {};
  let turnId: string | undefined;
  tail.events.forEach((event, i) => {
    if (event.turnId) turnId = event.turnId;
    if (event.kind === "user") {
      items.push({
        kind: "user",
        key: event.clientId ? `u-${event.clientId}` : `r${i}`,
        text: event.text ?? "",
        images: Array.from({ length: event.images ?? 0 }, () => ({ mediaType: "", data: "" })),
        state: "taken",
        ...(turnId ? { turnId } : {}),
      });
    } else if (event.kind === "agent") {
      items.push({
        kind: "assistant",
        key: `r${i}`,
        messageId: `r${i}`,
        blocks: [{ type: "text", text: event.text ?? "" }],
      });
    } else if (event.kind === "tool") {
      const names = rolloutTools(event);
      names.forEach((name, n) => {
        tools[`r${i}:${n}`] = {
          id: `r${i}:${n}`,
          name,
          input: {},
          status: "done",
          parentToolUseId: null,
        };
      });
      items.push({
        kind: "assistant",
        key: `r${i}`,
        messageId: `r${i}`,
        blocks: names.map((_, n) => ({ type: "tool" as const, toolUseId: `r${i}:${n}` })),
      });
    }
  });
  return fitPeek({
    status: COLD,
    ...lastTurns(
      peekTurnsOf(withRelayed(items, relayed), tools),
      peekTurnCount(turns),
      tail.more === true,
    ),
  });
}
