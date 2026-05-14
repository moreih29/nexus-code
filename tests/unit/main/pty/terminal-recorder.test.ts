import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  TerminalRecorder,
  TerminalRecorderRegistry,
} from "../../../../src/main/features/pty/recorder";
import { TerminalRecorder as UtilityTerminalRecorder } from "../../../../src/utility/pty-host/terminal-recorder";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TAB_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Applies the fixture sequence used to verify replay JSON byte-for-byte.
 */
function applyFixtureSequence(recorder: {
  handleData(data: string): void;
  handleResize(cols: number, rows: number): void;
}): void {
  recorder.handleData("hello");
  recorder.handleData("\r\nworld");
  recorder.handleResize(100, 30);
  recorder.handleData("\u001b[31mred\u001b[0m");
  recorder.handleResize(120, 40);
  recorder.handleResize(132, 43);
  recorder.handleData("tail");
}

/**
 * Serializes replay events the same way fixture files are stored.
 */
function replayJson(recorder: { generateReplayEvent(): unknown }): string {
  return `${JSON.stringify(recorder.generateReplayEvent(), null, 2)}\n`;
}

describe("main TerminalRecorder", () => {
  test("matches the replay fixture byte-for-byte", () => {
    const recorder = new TerminalRecorder(80, 24);
    applyFixtureSequence(recorder);

    const fixturePath = join(import.meta.dir, "fixtures", "terminal-recorder-replay.json");
    expect(replayJson(recorder)).toBe(readFileSync(fixturePath, "utf8"));
  });

  test("preserves utility recorder output shape for identical input and resize sequence", () => {
    const mainRecorder = new TerminalRecorder(80, 24);
    const utilityRecorder = new UtilityTerminalRecorder(80, 24);
    applyFixtureSequence(mainRecorder);
    applyFixtureSequence(utilityRecorder);

    expect(replayJson(mainRecorder)).toBe(replayJson(utilityRecorder));
  });
});

describe("TerminalRecorderRegistry", () => {
  test("records and removes an agent-backed session by workspace and tab", () => {
    const registry = new TerminalRecorderRegistry();

    registry.start(WORKSPACE_ID, TAB_ID, 80, 24);
    registry.appendData(WORKSPACE_ID, TAB_ID, "before");
    registry.handleResize(WORKSPACE_ID, TAB_ID, 100, 30);
    registry.appendData(WORKSPACE_ID, TAB_ID, "after");

    expect(registry.getReplayEvent(WORKSPACE_ID, TAB_ID)).toEqual({
      events: [
        { cols: 80, rows: 24, data: "before" },
        { cols: 100, rows: 30, data: "after" },
      ],
    });

    registry.stop(WORKSPACE_ID, TAB_ID);
    expect(registry.getReplayEvent(WORKSPACE_ID, TAB_ID)).toBeNull();
  });

  test("ignores utility or stale data when no main recorder exists", () => {
    const registry = new TerminalRecorderRegistry();

    registry.appendData(WORKSPACE_ID, TAB_ID, "utility-owned");
    registry.handleResize(WORKSPACE_ID, TAB_ID, 120, 40);

    expect(registry.has(WORKSPACE_ID, TAB_ID)).toBe(false);
  });
});
