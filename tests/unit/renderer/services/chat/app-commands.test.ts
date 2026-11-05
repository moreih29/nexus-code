import { describe, expect, test } from "bun:test";
import {
  answersOf,
  appCommandsBeside,
  backgroundIdOf,
  backgroundSessionsOf,
  code,
  conversationMarkdown,
  copyIndex,
  directoryArg,
  exportFileName,
  exportRelPath,
  hooksMarkdown,
  memoryFilesOf,
  nthAnswer,
  parseAppCommand,
  permissionFiles,
  permissionsMarkdown,
  permissionsOf,
  sandboxOn,
  subtaskPrompt,
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

  test("inline code holds backticks", () => {
    expect(code("ls")).toBe("`ls`");
    expect(code("a `b` c")).toBe("``a `b` c``");
    expect(code("`x")).toBe("`` `x ``");
  });

  const words = (key: string) => key.replace("chat.commands.", "");

  test("/permissions: rules by what they do, the folders, and the files to edit", () => {
    const state = permissionsOf({
      state: {
        rules: [
          { behavior: "allow", source: "cliArg", rule: "Bash(ls:*)", editability: "session" },
          { behavior: "deny", source: "projectSettings", rule: "Read(.env)" },
          { behavior: "allow", source: "localSettings", rule: "Edit", notInEffect: true },
          { behavior: "ask", source: "mcpMount", rule: "mcp__x" },
          { behavior: "allow" },
        ],
        workspaceDirectories: [
          { path: "/tmp/extra", source: "localSettings" },
          { path: "/tmp/added", source: "localSettings" },
          {},
        ],
        originalCwd: "/w/app/",
      },
    });
    expect(state.rules).toHaveLength(4);
    expect(permissionsMarkdown(state, words, ["/tmp/added"])).toBe(
      [
        "**behavior.allow**\n\n- `Bash(ls:*)` · source.cliArg\n- `Edit` · source.localSettings · not_in_effect",
        "**behavior.ask**\n\n- `mcp__x` · mcpMount",
        "**behavior.deny**\n\n- `Read(.env)` · source.projectSettings",
        "**directories**\n\n- `/tmp/extra` · source.localSettings\n- `/tmp/added` · source.added",
        "permissions_edit",
      ].join("\n\n"),
    );
    expect(permissionFiles(state)).toEqual([
      "/w/app/.claude/settings.json",
      "/w/app/.claude/settings.local.json",
    ]);
    const none = permissionsOf({
      state: { rules: [], workspaceDirectories: [], originalCwd: "/w" },
    });
    expect(permissionsMarkdown(none, words)).toBe("no_rules\n\npermissions_edit");
    expect(permissionFiles(none)).toEqual([]);
    expect(permissionsOf(null).rules).toEqual([]);
  });

  test("/hooks: by event, with matcher, type and source", () => {
    expect(
      hooksMarkdown(
        {
          events: [{ name: "PreToolUse", summary: "Before tool execution" }],
          hooks: [
            {
              event: "PreToolUse",
              matcher: "Bash",
              type: "command",
              displayText: "check.sh",
              sourceLabel: "User settings",
            },
            {
              event: "PreToolUse",
              matcher: "",
              type: "command",
              displayText: "log.sh",
              sourceLabel: "",
            },
            {
              event: "Stop",
              matcher: "",
              type: "prompt",
              displayText: "Sum up",
              sourceLabel: "Project",
            },
          ],
        },
        words,
      ),
    ).toBe(
      [
        "**PreToolUse** — Before tool execution\n\n- `Bash` · command · `check.sh` · User settings\n- command · `log.sh`",
        "**Stop**\n\n- prompt · `Sum up` · Project",
      ].join("\n\n"),
    );
    expect(hooksMarkdown({ events: [], hooks: [] }, words)).toBe("no_hooks");
  });

  test("/sandbox reads the effective settings; /add-dir takes a folder", () => {
    expect(sandboxOn({ effective: { sandbox: { enabled: true } } })).toBe(true);
    expect(sandboxOn({ effective: {} })).toBe(false);
    expect(sandboxOn(null)).toBe(false);
    expect(directoryArg("../lib", "/w/app")).toBe("/w/app/../lib");
    expect(directoryArg("./docs", "/w/app/")).toBe("/w/app/docs");
    expect(directoryArg('"/tmp/my dir"', "/w")).toBe("/tmp/my dir");
    expect(directoryArg("~/notes", "/w")).toBe("~/notes");
    expect(directoryArg("C:\\data", "C:\\w")).toBe("C:\\data");
    expect(directoryArg("  ", "/w")).toBeNull();
  });

  test("/bg and /bashes are /background's and /tasks'", () => {
    expect(parseAppCommand("/bg go on", [])).toEqual({ name: "background", args: "go on" });
    expect(parseAppCommand("/bashes", [])).toEqual({ name: "tasks", args: "" });
    expect(subtaskPrompt("Check the tests")).toContain('subagent_type "fork"');
    expect(subtaskPrompt("Check the tests").endsWith("\n\nCheck the tests")).toBe(true);
  });

  test("background sessions from claude agents --json, newest first", () => {
    const stdout = JSON.stringify([
      { pid: 1, cwd: "/w", kind: "interactive", sessionId: "s0", name: "w-a", status: "idle" },
      {
        pid: 2,
        id: "8c55b250",
        cwd: "/w",
        kind: "background",
        startedAt: 10,
        sessionId: "8c55b250-4a63",
        name: "8c55b250",
        status: "idle",
        state: "blocked",
      },
      { id: "1234abcd", kind: "background", startedAt: 20, sessionId: "s2", state: "stopped" },
      { id: "x; rm -rf ~", kind: "background", startedAt: 30, status: "idle" },
    ]);
    expect(backgroundSessionsOf(stdout)).toEqual([
      { id: "1234abcd", sessionId: "s2", name: "1234abcd", status: "stopped", startedAt: 20 },
      {
        id: "8c55b250",
        sessionId: "8c55b250-4a63",
        name: "8c55b250",
        status: "idle",
        startedAt: 10,
      },
    ]);
    expect(backgroundSessionsOf("not json")).toEqual([]);
    expect(backgroundSessionsOf("{}")).toEqual([]);
    expect(
      backgroundIdOf(
        "Starting background service…\nbackgrounded · 8c55b250 (idle — send a prompt)",
      ),
    ).toBe("8c55b250");
    expect(backgroundIdOf("error: no such session")).toBeNull();
  });
});
