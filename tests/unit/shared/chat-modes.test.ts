import { describe, expect, test } from "bun:test";
import { grants } from "../../../src/shared/sessions/chat-modes";
import type { ChatAgent } from "../../../src/shared/sessions/task-agent";

describe("grants", () => {
  const rows: [ChatAgent, string | undefined, string[], string[]][] = [
    ["claude", "plan", ["plan"], ["readOnly"]],
    ["claude", "default", ["plan", "default"], ["readOnly"]],
    ["claude", "acceptEdits", ["plan", "default", "acceptEdits"], ["readOnly", "auto"]],
    ["claude", "auto", ["plan", "default", "acceptEdits", "auto"], ["readOnly", "auto"]],
    [
      "claude",
      "bypassPermissions",
      ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
      ["readOnly", "auto", "fullAccess"],
    ],
    ["codex", "readOnly", ["plan", "default"], ["readOnly"]],
    ["codex", "auto", ["plan", "default", "acceptEdits", "auto"], ["readOnly", "auto"]],
    [
      "codex",
      "fullAccess",
      ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
      ["readOnly", "auto", "fullAccess"],
    ],
    ["claude", "fullAccess", ["plan"], ["readOnly"]],
    ["codex", "bypassPermissions", ["plan", "default"], ["readOnly"]],
    ["claude", undefined, ["plan"], ["readOnly"]],
    ["codex", undefined, ["plan", "default"], ["readOnly"]],
  ];

  test.each(rows)("%s in %s grants only the modes it covers", (agent, mode, claude, codex) => {
    for (const target of [
      "plan",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "future",
    ]) {
      expect(grants(agent, mode, "claude", target)).toBe(claude.includes(target));
    }
    for (const target of ["readOnly", "auto", "fullAccess", "future"]) {
      expect(grants(agent, mode, "codex", target)).toBe(codex.includes(target));
    }
  });
});
