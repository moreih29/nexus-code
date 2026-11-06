import { describe, expect, it } from "bun:test";
import { asTaskAgent, taskAgentOfCommand } from "../../../src/shared/sessions/task-agent";

describe("asTaskAgent", () => {
  it("takes the agents this version has, and nothing else", () => {
    expect(asTaskAgent("codex")).toBe("codex");
    expect(asTaskAgent("terminal")).toBe("terminal");
    expect(asTaskAgent("gemini")).toBeUndefined();
    expect(asTaskAgent(undefined)).toBeUndefined();
  });
});

describe("taskAgentOfCommand", () => {
  it("knows codex by its program, wherever it is", () => {
    expect(taskAgentOfCommand("codex --full-auto")).toBe("codex");
    expect(taskAgentOfCommand("/opt/homebrew/bin/codex -m gpt-5.5")).toBe("codex");
    expect(taskAgentOfCommand("C:\\tools\\codex.cmd")).toBe("codex");
  });

  it("takes no command for a terminal, and any other for Claude", () => {
    expect(taskAgentOfCommand("  ")).toBe("terminal");
    expect(taskAgentOfCommand("claude --model opus")).toBe("claude");
    expect(taskAgentOfCommand("codexer")).toBe("claude");
  });
});
