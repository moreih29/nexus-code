import { describe, expect, test } from "bun:test";
import {
  ClaudeInterruptWatcher,
  INTERRUPT_WINDOW_MS,
} from "../../../../src/main/features/claude/interrupt";
import { ClaudeStatusBroker } from "../../../../src/main/features/claude/status";

function harness(status: "running" | "permissionPending" | "idle" | "completed" = "running") {
  let now = 1_000;
  const broker = new ClaudeStatusBroker(() => {});
  broker.set("ws", "tab", status, undefined, "fix the build");
  const watcher = new ClaudeInterruptWatcher(broker, () => now);
  return {
    broker,
    watcher,
    advance: (ms: number) => {
      now += ms;
    },
    status: () => broker.get("ws", "tab")?.status,
  };
}

const INTERRUPTED = "\x1b[2K\x1b[31m  ⎿  \x1b[39mInterrupted · What should Claude do instead?";

describe("ClaudeInterruptWatcher", () => {
  test.each(["\x1b", "\x03"])("%j then Claude's Interrupted line → idle, prompt kept", (key) => {
    const { watcher, broker, status } = harness();
    watcher.noteInput("ws", "tab", key);
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("idle");
    expect(broker.get("ws", "tab")?.prompt).toBe("fix the build");
  });

  test("Claude's idle title after the key → idle, as when it puts the prompt back", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x1b");
    watcher.noteOutput("ws", "tab", "\x1b]0;✳ Fix the build\x07");
    expect(status()).toBe("idle");
  });

  test("a running title after the key changes nothing", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x1b");
    watcher.noteOutput("ws", "tab", "\x1b]0;◐ Fix the build\x07");
    expect(status()).toBe("running");
  });

  test("finds the sign split between two chunks", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x03");
    watcher.noteOutput("ws", "tab", "  ⎿  Interr");
    expect(status()).toBe("running");
    watcher.noteOutput("ws", "tab", "upted · What should Claude do instead?");
    expect(status()).toBe("idle");
  });

  test("ends a turn interrupted at a permission dialog", () => {
    const { watcher, status } = harness("permissionPending");
    watcher.noteInput("ws", "tab", "\x1b");
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("idle");
  });

  test("the line without the key, or the key without the line, changes nothing", () => {
    const { watcher, status } = harness();
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("running");
    watcher.noteInput("ws", "tab", "\x03");
    watcher.noteOutput("ws", "tab", "still working");
    expect(status()).toBe("running");
  });

  test("an escape sequence, as an arrow key, is not Esc", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x1b[A");
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("running");
  });

  test("the line counts only shortly after the key", () => {
    const { watcher, status, advance } = harness();
    watcher.noteInput("ws", "tab", "\x03");
    advance(INTERRUPT_WINDOW_MS + 1);
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("running");
  });

  test("a turn that is not running is left as it is", () => {
    const { watcher, status } = harness("completed");
    watcher.noteInput("ws", "tab", "\x03");
    watcher.noteOutput("ws", "tab", INTERRUPTED);
    expect(status()).toBe("completed");
  });

  test("another terminal's line does not count", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x03");
    watcher.noteOutput("ws", "other", INTERRUPTED);
    expect(status()).toBe("running");
  });

  test("the word in a tool's output after the key changes nothing", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x03");
    watcher.noteOutput("ws", "tab", "  ⎿  test run Interrupted\r\nInterrupted system call\r\n");
    expect(status()).toBe("running");
  });

  test("older Claude's \"Interrupted by user\" line counts", () => {
    const { watcher, status } = harness();
    watcher.noteInput("ws", "tab", "\x1b");
    watcher.noteOutput("ws", "tab", "  ⎿  \x1b[31mInterrupted by user\x1b[39m");
    expect(status()).toBe("idle");
  });
});
