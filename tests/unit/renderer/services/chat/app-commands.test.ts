import { describe, expect, test } from "bun:test";
import {
  answersOf,
  appCommandsBeside,
  conversationMarkdown,
  copyIndex,
  exportFileName,
  exportRelPath,
  memoryFilesOf,
  nthAnswer,
  parseAppCommand,
} from "../../../../../src/renderer/services/chat/app-commands";
import type { ChatItem, ToolCall } from "../../../../../src/renderer/services/chat/model";

const user = (key: string, text: string): ChatItem => ({
  kind: "user",
  key,
  text,
  images: [],
  state: "taken",
});
const said = (key: string, ...blocks: (string | { tool: string })[]): ChatItem => ({
  kind: "assistant",
  key,
  messageId: key,
  blocks: blocks.map((b) =>
    typeof b === "string" ? { type: "text", text: b } : { type: "tool", toolUseId: b.tool },
  ),
});
const tool = (id: string, name: string, parent: string | null = null): ToolCall => ({
  id,
  name,
  input: { command: `run ${id}` },
  status: "done",
  parentToolUseId: parent,
});

const items: ChatItem[] = [
  user("u1", "Fix the build"),
  said("a1", "Looking.", { tool: "t1" }),
  said("a2", "Fixed it."),
  { kind: "notice", key: "n1", code: "interrupted" },
  user("u2", "And the docs"),
  said("a3", { tool: "t2" }),
  user("u3", "Thanks"),
  said("a4", "Done."),
];
const tools = { t1: tool("t1", "Bash"), t2: tool("t2", "Edit"), t3: tool("t3", "Read", "t1") };

describe("app commands", () => {
  test("are listed beside the CLI's, unless the CLI has them", () => {
    const own = appCommandsBeside(
      [{ name: "help" }, { name: "rename", aliases: ["copy"] }],
      (n) => `about ${n}`,
    );
    const names = own.map((c) => c.name);
    expect(names).toContain("btw");
    expect(names).toContain("exit");
    expect(names).not.toContain("help");
    expect(names).not.toContain("copy");
    expect(own.find((c) => c.name === "btw")?.description).toBe("about btw");
  });

  test("a message that calls one, with what follows it", () => {
    expect(parseAppCommand("/btw what is  this?\nmore", [])).toEqual({
      name: "btw",
      args: "what is  this?\nmore",
    });
    expect(parseAppCommand("  /COPY 2 ", [])).toEqual({ name: "copy", args: "2" });
    expect(parseAppCommand("/quit", [])).toEqual({ name: "exit", args: "" });
    // The CLI's own, and ordinary messages, are sent.
    expect(parseAppCommand("/help", [{ name: "help" }])).toBeNull();
    expect(parseAppCommand("/compact", [])).toBeNull();
    expect(parseAppCommand("please /copy", [])).toBeNull();
    expect(parseAppCommand("/copy/x", [])).toBeNull();
  });

  test("answers are each turn's text, and /copy N counts from the end", () => {
    expect(answersOf(items)).toEqual(["Looking.\n\nFixed it.", "Done."]);
    expect(nthAnswer(items, 1)).toBe("Done.");
    expect(nthAnswer(items, 2)).toBe("Looking.\n\nFixed it.");
    expect(nthAnswer(items, 3)).toBeNull();
    expect(copyIndex("")).toBe(1);
    expect(copyIndex("3")).toBe(3);
    expect(copyIndex("0")).toBeNull();
    expect(copyIndex("two")).toBeNull();
  });

  test("the conversation as Markdown, with the main thread's tools", () => {
    const text = conversationMarkdown(
      items,
      tools,
      (t) => String((t.input as { command: string }).command),
      {
        user: "You",
        assistant: "Claude",
      },
    );
    expect(text).toBe(
      `${[
        "## You\n\nFix the build",
        "## Claude",
        "Looking.\n\n- **Bash** `run t1`",
        "Fixed it.",
        "## You\n\nAnd the docs",
        "## Claude",
        "- **Edit** `run t2`",
        "## You\n\nThanks",
        "## Claude",
        "Done.",
      ].join("\n\n")}\n`,
    );
  });

  test("an export's name and where it goes", () => {
    const at = new Date(2026, 10, 6, 9, 5, 3);
    expect(exportFileName(items, at)).toBe("2026-11-06-090503-fix-the-build.md");
    expect(exportFileName([user("u", "한글만")], at)).toBe("2026-11-06-090503.md");
    expect(exportRelPath("out.md", "/w/app", "/w/app")).toBe("out.md");
    expect(exportRelPath("notes/out.md", "/w/app/sub", "/w/app/")).toBe("sub/notes/out.md");
    expect(exportRelPath("../out.md", "/w/app", "/w/app")).toBeNull();
    expect(exportRelPath("/tmp/out.md", "/w/app", "/w/app")).toBeNull();
    expect(exportRelPath("out.md", "/elsewhere", "/w/app")).toBeNull();
    expect(exportRelPath("out.md", "/w/apple", "/w/app")).toBeNull();
  });

  test("memory files from the context's breakdown", () => {
    expect(
      memoryFilesOf({
        memoryFiles: [
          { path: "/w/CLAUDE.md", type: "Project", tokens: 10 },
          { path: "", type: "User" },
          { type: "Local" },
          { path: "/h/.claude/CLAUDE.md" },
        ],
      }),
    ).toEqual([
      { path: "/w/CLAUDE.md", type: "Project" },
      { path: "/h/.claude/CLAUDE.md", type: "" },
    ]);
    expect(memoryFilesOf(null)).toEqual([]);
    expect(memoryFilesOf({ memoryFiles: "x" })).toEqual([]);
  });
});
