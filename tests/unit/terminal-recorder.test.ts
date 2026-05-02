import { describe, expect, test } from "bun:test";
import { TerminalRecorder } from "../../src/utility/pty-host/terminalRecorder";

const MB = 1024 * 1024;
const MAX = 10 * MB;

describe("TerminalRecorder — basic data recording", () => {
  test("records data in generateReplayEvent", () => {
    const rec = new TerminalRecorder(80, 24);
    rec.handleData("hello");
    rec.handleData(" world");

    const replay = rec.generateReplayEvent();
    expect(replay.events.length).toBeGreaterThanOrEqual(1);
    const allData = replay.events.map((e) => e.data).join("");
    expect(allData).toContain("hello");
    expect(allData).toContain("world");
  });

  test("initial entry has correct dimensions", () => {
    const rec = new TerminalRecorder(120, 30);
    const replay = rec.generateReplayEvent();
    expect(replay.events[0].cols).toBe(120);
    expect(replay.events[0].rows).toBe(30);
  });

  test("resize creates a new entry", () => {
    const rec = new TerminalRecorder(80, 24);
    rec.handleData("before");
    rec.handleResize(120, 30);
    rec.handleData("after");

    const replay = rec.generateReplayEvent();
    // Should have at least 2 entries: one for original size, one for new size
    expect(replay.events.length).toBeGreaterThanOrEqual(2);
    const last = replay.events[replay.events.length - 1];
    expect(last.cols).toBe(120);
    expect(last.rows).toBe(30);
    expect(last.data).toContain("after");
  });

  test("resize with no data collapses empty entry", () => {
    const rec = new TerminalRecorder(80, 24);
    rec.handleData("data");
    rec.handleResize(100, 25);
    rec.handleResize(120, 30); // second resize without data in between — should collapse

    const replay = rec.generateReplayEvent();
    // The intermediate resize entry (100x25) with no data should be removed
    const dims = replay.events.map((e) => `${e.cols}x${e.rows}`);
    expect(dims).not.toContain("100x25");
  });
});

describe("TerminalRecorder — 10MB ring buffer cap", () => {
  test("total data length does not exceed 10MB after filling", () => {
    const rec = new TerminalRecorder(80, 24);
    // Fill with 11 MB of data in 1MB chunks
    const chunk = "x".repeat(MB);
    for (let i = 0; i < 11; i++) {
      rec.handleData(chunk);
    }
    expect(rec.getTotalDataLength()).toBeLessThanOrEqual(MAX);
  });

  test("oldest data is trimmed when cap is exceeded", () => {
    const rec = new TerminalRecorder(80, 24);

    // Write 5 MB of 'a'
    const halfChunk = "a".repeat(5 * MB);
    rec.handleData(halfChunk);

    // Write 6 MB of 'b' — should push 'a' data out
    const overflowChunk = "b".repeat(6 * MB);
    rec.handleData(overflowChunk);

    expect(rec.getTotalDataLength()).toBeLessThanOrEqual(MAX);

    const replay = rec.generateReplayEvent();
    const allData = replay.events.map((e) => e.data).join("");

    // Some or all of the 'a' data should be gone
    // The remaining total should be <= MAX
    expect(allData.length).toBeLessThanOrEqual(MAX);
    // The last portion should contain 'b'
    expect(allData).toContain("b");
  });

  test("generateReplayEvent normalizes entries to single data string", () => {
    const rec = new TerminalRecorder(80, 24);
    rec.handleData("foo");
    rec.handleData("bar");
    rec.handleData("baz");

    const replay = rec.generateReplayEvent();
    // Each entry's data array is normalized to a single string
    for (const entry of replay.events) {
      expect(typeof entry.data).toBe("string");
    }
    expect(replay.events[0].data).toBe("foobarbaz");
  });

  test("generateReplayEvent on empty recorder returns empty data", () => {
    const rec = new TerminalRecorder(80, 24);
    const replay = rec.generateReplayEvent();
    expect(replay.events.length).toBe(1);
    expect(replay.events[0].data).toBe("");
  });

  test("cap at exactly 10MB — data fits exactly", () => {
    const rec = new TerminalRecorder(80, 24);
    const exactChunk = "z".repeat(MAX);
    rec.handleData(exactChunk);
    expect(rec.getTotalDataLength()).toBe(MAX);
  });

  test("cap exceeded by one char trims exactly one char", () => {
    const rec = new TerminalRecorder(80, 24);
    const exactChunk = "z".repeat(MAX);
    rec.handleData(exactChunk);
    rec.handleData("x"); // +1 char over cap
    expect(rec.getTotalDataLength()).toBe(MAX);
  });
});
