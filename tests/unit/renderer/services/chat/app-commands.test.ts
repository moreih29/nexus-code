import { describe, expect, test } from "bun:test";
import {
  backgroundIdOf,
  backgroundSessionsOf,
  directoryArg,
  exportFileName,
  exportRelPath,
  memoryFilesOf,
  parseAppCommand,
  pluginResultOf,
  pluginsOf,
  sandboxOn,
  skillsOf,
} from "../../../../../src/renderer/services/chat/app-commands";
import type { ChatItem } from "../../../../../src/renderer/services/chat/model";

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

describe("app commands", () => {
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

  test("/skills from the context's breakdown", () => {
    expect(
      skillsOf({
        skills: {
          skillFrontmatter: [
            {
              name: "pdf",
              source: "plugin",
              pluginName: "docs",
              path: "/p/pdf/SKILL.md",
              tokens: 40,
            },
            { name: "deploy", source: "projectSettings" },
            { source: "userSettings" },
          ],
        },
      }),
    ).toEqual([
      { name: "pdf", source: "docs", path: "/p/pdf/SKILL.md", tokens: 40 },
      { name: "deploy", source: "projectSettings", path: undefined, tokens: undefined },
    ]);
    expect(skillsOf({})).toEqual([]);
  });

  test("/plugin: the installed ones, and what a change said", () => {
    expect(
      pluginsOf(
        JSON.stringify([
          { id: "a@m", version: "1.0.1", scope: "user", enabled: true },
          { id: "b@m", scope: "managed", enabled: false },
          { version: "2" },
        ]),
      ),
    ).toEqual([
      { id: "a@m", version: "1.0.1", scope: "user", enabled: true },
      { id: "b@m", version: undefined, scope: "managed", enabled: false },
    ]);
    expect(pluginsOf("oops")).toEqual([]);
    expect(
      pluginResultOf({
        code: 1,
        stdout:
          '{"command":"disable","outcome":"failed","message":"Plugin \\"x\\" is already disabled"}\n',
        stderr: "✘ Failed",
      }),
    ).toEqual({ ok: false, message: 'Plugin "x" is already disabled' });
    expect(
      pluginResultOf({ code: 0, stdout: '{"outcome":"ok","message":"Done"}', stderr: "" }),
    ).toEqual({ ok: true, message: "Done" });
    expect(pluginResultOf({ code: 2, stdout: "", stderr: "boom\n" })).toEqual({
      ok: false,
      message: "boom",
    });
  });
});
