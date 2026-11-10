import { describe, expect, test } from "bun:test";
import {
  CODEX_INIT_PROMPT,
  codexCommandsListed,
  codexSkillsOf,
  codexStatusMarkdown,
  goalCommandOf,
  goalOf,
  mcpServersOf,
  parseCodexCommand,
  reviewTargetOf,
} from "../../../../../src/renderer/services/chat/codex-commands";
import { emptyCodexModel } from "../../../../../src/renderer/services/chat/codex-model";

describe("codex commands", () => {
  test("the menu lists them with the app's words", () => {
    const listed = codexCommandsListed((name) => `about ${name}`);
    expect(listed.map((c) => c.name)).toContain("compact");
    expect(listed.find((c) => c.name === "new")).toMatchObject({
      aliases: ["clear"],
      description: "about new",
    });
  });

  test("a message that calls one, by its name or an alias, with what follows", () => {
    expect(parseCodexCommand("/review  the auth module ")).toEqual({
      name: "review",
      args: "the auth module",
    });
    expect(parseCodexCommand("/CLEAR")).toEqual({ name: "new", args: "" });
    expect(parseCodexCommand("/quit")).toEqual({ name: "exit", args: "" });
    // Codex's terminal-only ones, and ordinary messages, go to Codex as typed.
    expect(parseCodexCommand("/theme")).toBeNull();
    expect(parseCodexCommand("please /compact")).toBeNull();
  });

  test("/review looks at the uncommitted changes, or at what it is told", () => {
    expect(reviewTargetOf("")).toEqual({ type: "uncommittedChanges" });
    expect(reviewTargetOf(" the parser ")).toEqual({ type: "custom", instructions: "the parser" });
  });

  test("/goal shows, clears, pauses, resumes or sets", () => {
    expect(goalCommandOf("")).toEqual({ kind: "show" });
    expect(goalCommandOf("Clear")).toEqual({ kind: "clear" });
    expect(goalCommandOf("pause")).toEqual({ kind: "status", status: "paused" });
    expect(goalCommandOf("resume")).toEqual({ kind: "status", status: "active" });
    expect(goalCommandOf("ship the beta")).toEqual({ kind: "set", objective: "ship the beta" });
    expect(goalOf({ goal: { objective: "ship", status: "active", tokensUsed: 120 } })).toEqual({
      objective: "ship",
      status: "active",
      tokensUsed: 120,
      tokenBudget: undefined,
    });
    expect(goalOf({ goal: null })).toBeNull();
  });

  test("the MCP servers: how each stands, and its tools", () => {
    expect(
      mcpServersOf({
        data: [
          {
            name: "docs",
            runtimeStatus: "connected",
            authStatus: "oAuth",
            tools: { a: {}, b: {} },
          },
          { name: "jira", runtimeStatus: null, authStatus: "notLoggedIn", tools: {} },
          { authStatus: "unknown" },
        ],
      }),
    ).toEqual([
      { name: "docs", status: "connected", tools: 2 },
      { name: "jira", status: "notLoggedIn", tools: 0 },
    ]);
    expect(mcpServersOf({})).toEqual([]);
  });

  test("the skills, each once though two folders list it", () => {
    const skill = {
      name: "pdf",
      description: "PDFs",
      scope: "user",
      path: "/h/s/pdf/SKILL.md",
      enabled: true,
    };
    expect(
      codexSkillsOf({
        data: [
          {
            cwd: "/w",
            skills: [skill, { name: "off", description: "", scope: "repo", enabled: false }],
          },
          { cwd: "/w/sub", skills: [skill] },
        ],
      }),
    ).toEqual([
      { name: "pdf", description: "PDFs", scope: "user", path: "/h/s/pdf/SKILL.md", enabled: true },
      { name: "off", description: "", scope: "repo", path: undefined, enabled: false },
    ]);
  });

  test("/status: what the thread is set to and has used", () => {
    const model = {
      ...emptyCodexModel(),
      model: "gpt-6",
      effort: "high",
      threadId: "thr_1",
      tokens: { used: 1200, window: 400000 },
    };
    const text = codexStatusMarkdown(model, "/w", (key) => key.split(".").at(-1) ?? key);
    expect(text).toContain("- **model** gpt-6");
    expect(text).toContain("- **folder** `/w`");
    expect(text).toContain("- **thread** `thr_1`");
    expect(text).toContain("- **context** 1,200 / 400,000");
    expect(text).not.toContain("account");
  });

  test("/init asks for AGENTS.md as Codex's own does", () => {
    expect(CODEX_INIT_PROMPT).toStartWith("Generate a file named AGENTS.md");
    expect(CODEX_INIT_PROMPT).toContain("project's Git history");
  });
});
