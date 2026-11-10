import { describe, expect, test } from "bun:test";
import { answersOf } from "../../../../../src/renderer/services/chat/app-commands";
import { cutEntries, historyModel } from "../../../../../src/renderer/services/chat/history";
import {
  applyLines,
  type ChatItem,
  type ChatLine,
  type ChatModel,
  emptyModel,
} from "../../../../../src/renderer/services/chat/model";

// What the CLI takes as a message that the user did not write: a task's
// end, another session's message, a shell command run in the terminal. The
// shapes are the CLI's own (2.1.321), from its stream and its transcripts.

const NEWS = (id: string, status = "completed", what = "sleep 5") =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>call-${id}</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command "${what}" ${status} (exit code 0)</summary>\n</task-notification>`;

const PEER =
  '<cross-session-message from="bridge:session_01" from-name="NexusCode-Win" from-mode="bypass">\nQA passed.\nMerge it.\n</cross-session-message>';

let seq = 0;
function out(message: Record<string, unknown>): ChatLine {
  return { seq: ++seq, dir: "out", message };
}
function replay(text: string, more: Record<string, unknown> = {}): ChatLine {
  return out({
    type: "user",
    isReplay: true,
    uuid: `u${seq + 1}`,
    message: { role: "user", content: text },
    ...more,
  });
}
function typed(text: string, uuid: string): ChatLine {
  return {
    seq: ++seq,
    dir: "in",
    message: { type: "user", uuid, message: { role: "user", content: text } },
  };
}
function said(text: string): ChatLine {
  return out({
    type: "assistant",
    uuid: `a${seq + 1}`,
    message: { id: `m${seq + 1}`, role: "assistant", content: [{ type: "text", text }] },
  });
}
const INIT = () =>
  out({ type: "system", subtype: "init", session_id: "s1", model: "m", tools: [] });
const RESULT = () => out({ type: "result", subtype: "success", is_error: false });

function shapeOf(item: ChatItem): string {
  switch (item.kind) {
    case "user":
      return `user:${item.text}`;
    case "assistant":
      return `assistant:${item.blocks.map((b) => (b.type === "text" ? b.text : b.type)).join("")}`;
    case "notice":
      return `notice:${item.code}`;
    case "received":
      return `received:${item.from.kind}/${item.from.name ?? ""}:${item.text}`;
    case "task_end":
      return `task_end:${item.taskId}:${item.status}${item.wakes ? ":wakes" : ""}`;
    case "shell":
      return `shell:${item.command}|${item.stdout ?? ""}|${item.stderr ?? ""}`;
  }
}

function shape(items: readonly ChatItem[]): string[] {
  return items.map(shapeOf);
}

function run(lines: ChatLine[]): ChatModel {
  return applyLines(emptyModel(), lines);
}

describe("messages the user did not write, live", () => {
  test("a task's news replayed as a message is not the user's, and takes none of theirs", () => {
    const model = run([
      INIT(),
      typed("hello", "sent-1"),
      replay(NEWS("t1"), { origin: { kind: "task-notification" } }),
    ]);
    expect(shape(model.items)).toEqual(["user:hello"]);
    const user = model.items[0];
    expect(user.kind === "user" && user.state).toBe("sent");
  });

  test("the CLI's notice of a background task's end is a line of the conversation", () => {
    const model = run([
      INIT(),
      out({
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        description: "sleep 5",
        task_type: "local_bash",
      }),
      RESULT(),
      out({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        status: "completed",
        summary: 'Background command "sleep 5" completed (exit code 0)',
      }),
      // The same end, told again: one line.
      out({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" }),
    ]);
    expect(shape(model.items)).toEqual(["task_end:t1:completed:wakes"]);
    const item = model.items[0];
    expect(item.kind === "task_end" && item.description).toBe("sleep 5");
  });

  test("another session's message is shown as received, by its sender's name", () => {
    const model = run([
      INIT(),
      replay(`Another Claude session sent a message:\n${PEER}`, {
        isSynthetic: true,
        origin: { kind: "peer", from: "bridge:session_01" },
      }),
    ]);
    expect(shape(model.items)).toEqual(["received:peer/NexusCode-Win:QA passed.\nMerge it."]);
  });

  test("what the CLI wrote itself is hidden; what has no origin is the user's", () => {
    const model = run([
      INIT(),
      replay("<system-reminder>be brief</system-reminder>", { isSynthetic: true }),
      replay("<pasted_content>x</pasted_content> look", { origin: { kind: "human" } }),
      replay("from the terminal"),
    ]);
    expect(shape(model.items)).toEqual([
      "user:<pasted_content>x</pasted_content> look",
      "user:from the terminal",
    ]);
  });

  test("a shell command run in the terminal is a card with its output", () => {
    const model = run([
      INIT(),
      replay("<bash-input>ls -a</bash-input>"),
      replay("<bash-stdout>a\nb\n</bash-stdout><bash-stderr></bash-stderr>"),
    ]);
    expect(shape(model.items)).toEqual(["shell:ls -a|a\nb|"]);
  });
});

describe("messages the user did not write, in a transcript", () => {
  const user = (uuid: string, text: string, more: Record<string, unknown> = {}) => ({
    type: "user",
    uuid,
    message: { role: "user", content: text },
    ...more,
  });
  const assistant = (uuid: string, text: string) => ({
    type: "assistant",
    uuid,
    message: { id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text }] },
  });
  const queued = (
    uuid: string,
    source: string,
    prompt: string,
    more: Record<string, unknown> = {},
  ) => ({
    type: "attachment",
    uuid,
    attachment: {
      type: "queued_command",
      prompt,
      source_uuid: source,
      commandMode: "prompt",
      ...more,
    },
  });

  const ENTRIES = [
    user("u1", "start"),
    assistant("a1", "working"),
    // The user's message while the turn ran: an attachment, not a message.
    queued("x1", "q1", "also this", { origin: { kind: "human" } }),
    assistant("a2", "both done"),
    // A task that ended while the turn ran, and one that woke Claude.
    queued("x2", "q2", NEWS("t1"), {
      commandMode: "task-notification",
      origin: { kind: "task-notification" },
    }),
    user("n1", NEWS("t2", "failed"), {
      promptSource: "system",
      origin: { kind: "task-notification" },
    }),
    assistant("a3", "it failed"),
    queued("x3", "q3", PEER, { isMeta: true, origin: { kind: "peer" } }),
    user("p1", `Another Claude session sent a message:\n${PEER}`, {
      isMeta: true,
      promptSource: "system",
      origin: { kind: "peer" },
    }),
    user("m1", "<system-reminder>hidden</system-reminder>", { isMeta: true }),
    assistant("a4", "ok"),
  ];

  test("a resumed conversation shows them as they were", () => {
    const model = historyModel(ENTRIES);
    expect(shape(model.items)).toEqual([
      "user:start",
      "assistant:working",
      "user:also this",
      "assistant:both done",
      "task_end:t1:completed",
      "task_end:t2:failed:wakes",
      "assistant:it failed",
      "received:peer/NexusCode-Win:QA passed.\nMerge it.",
      "received:peer/NexusCode-Win:QA passed.\nMerge it.",
      "assistant:ok",
    ]);
    expect(model.running).toBe(false);
  });

  test("a turn ends at the news that woke Claude, not at one that came during it", () => {
    expect(answersOf(historyModel(ENTRIES).items)).toEqual([
      "working",
      "both done",
      "it failed",
      "ok",
    ]);
  });

  test("a cut names a message that came during a turn by the uuid it was written with", () => {
    expect(cutEntries(ENTRIES, { upTo: "q1" })).toEqual(ENTRIES.slice(0, 3));
    expect(cutEntries(ENTRIES, { before: new Set(["q1"]) })).toEqual(ENTRIES.slice(0, 2));
  });
});
