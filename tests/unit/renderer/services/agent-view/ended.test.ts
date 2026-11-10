import { describe, expect, test } from "bun:test";
import { resumeLine } from "../../../../../src/renderer/services/agent-view/ended";

describe("resumeLine", () => {
  test("Claude's session by its id, once prompted in", () => {
    expect(resumeLine({ agent: "claude", sessionId: "0b5c-11ef", prompted: true })).toBe(
      "claude --resume 0b5c-11ef",
    );
  });

  test("Claude's picker for a session quit before a prompt, which Claude Code keeps not", () => {
    expect(resumeLine({ agent: "claude", sessionId: "0b5c-11ef", prompted: false })).toBe(
      "claude --resume",
    );
  });

  test("Claude's picker when the id is unknown, or not one to type into a shell", () => {
    expect(resumeLine({ agent: "claude", sessionId: undefined, prompted: false })).toBe(
      "claude --resume",
    );
    expect(resumeLine({ agent: "claude", sessionId: "x; rm -rf ~", prompted: true })).toBe(
      "claude --resume",
    );
  });

  test("Codex's picker; none for another agent", () => {
    expect(resumeLine({ agent: "codex", sessionId: undefined, prompted: false })).toBe(
      "codex resume",
    );
    expect(resumeLine({ agent: undefined, sessionId: undefined, prompted: false })).toBeNull();
  });
});
