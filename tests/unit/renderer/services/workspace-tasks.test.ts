/**
 * The line a task's terminal agent is started with: the prompt goes in as
 * one shell argument.
 */
import { describe, expect, it } from "bun:test";
import { agentCommandLine } from "../../../../src/renderer/services/workspace/tasks";

describe("agentCommandLine", () => {
  it("runs the command with the prompt as one argument", () => {
    expect(agentCommandLine("claude", " fix it's login ", "/bin/zsh")).toBe(
      "claude 'fix it'\\''s login'\r",
    );
  });

  it("runs the command alone without a prompt, and nothing without a command", () => {
    expect(agentCommandLine("claude", "  ")).toBe("claude\r");
    expect(agentCommandLine("", "fix it")).toBeNull();
  });
});
