import { describe, expect, test } from "bun:test";
import {
  CharCountAckSize,
  FlowController,
  HighWatermarkChars,
  LowWatermarkChars,
} from "../../src/utility/pty-host/flowControl";

describe("FlowController — backpressure round-trip", () => {
  test("not paused below HighWatermark", () => {
    const flow = new FlowController();
    const paused = flow.onData(HighWatermarkChars - 1);
    expect(paused).toBe(false);
    expect(flow.isPaused()).toBe(false);
  });

  test("pauses exactly at HighWatermark", () => {
    const flow = new FlowController();
    const paused = flow.onData(HighWatermarkChars);
    expect(paused).toBe(true);
    expect(flow.isPaused()).toBe(true);
  });

  test("pauses above HighWatermark", () => {
    const flow = new FlowController();
    flow.onData(HighWatermarkChars - 1);
    const paused = flow.onData(2);
    expect(paused).toBe(true);
    expect(flow.isPaused()).toBe(true);
  });

  test("does not resume until at or below LowWatermark", () => {
    const flow = new FlowController();
    flow.onData(HighWatermarkChars);
    expect(flow.isPaused()).toBe(true);

    // Ack just enough to bring unacknowledged to LowWatermark + 1
    const ackAmount = HighWatermarkChars - (LowWatermarkChars + 1);
    const resumed = flow.onAck(ackAmount);
    expect(resumed).toBe(false);
    expect(flow.isPaused()).toBe(true);
  });

  test("resumes exactly at LowWatermark after ack", () => {
    const flow = new FlowController();
    flow.onData(HighWatermarkChars);
    expect(flow.isPaused()).toBe(true);

    // Ack enough to land exactly at LowWatermark
    const ackAmount = HighWatermarkChars - LowWatermarkChars;
    const resumed = flow.onAck(ackAmount);
    expect(resumed).toBe(true);
    expect(flow.isPaused()).toBe(false);
  });

  test("resumes below LowWatermark after ack", () => {
    const flow = new FlowController();
    flow.onData(HighWatermarkChars);

    const resumed = flow.onAck(HighWatermarkChars);
    expect(resumed).toBe(true);
    expect(flow.isPaused()).toBe(false);
    expect(flow.getUnacknowledged()).toBe(0);
  });

  test("CharCountAckSize is <= LowWatermarkChars so ack always makes progress", () => {
    // This invariant from the VSCode spec: CharCountAckSize <= LowWatermarkChars
    expect(CharCountAckSize).toBeLessThanOrEqual(LowWatermarkChars);
  });

  test("full producer/consumer scenario: pauses then resumes after ack", () => {
    const flow = new FlowController();

    // Simulate producer streaming in bursts of CharCountAckSize
    let pauseCount = 0;
    let totalSent = 0;
    const chunkSize = CharCountAckSize;

    // Stream until paused
    while (!flow.isPaused()) {
      const paused = flow.onData(chunkSize);
      totalSent += chunkSize;
      if (paused) pauseCount++;
    }

    expect(pauseCount).toBeGreaterThanOrEqual(1);
    expect(totalSent).toBeGreaterThanOrEqual(HighWatermarkChars);

    // Consumer acks in CharCountAckSize increments until resumed
    let resumeCount = 0;
    let totalAcked = 0;
    while (flow.isPaused()) {
      const resumed = flow.onAck(chunkSize);
      totalAcked += chunkSize;
      if (resumed) resumeCount++;
    }

    expect(resumeCount).toBe(1);
    expect(flow.isPaused()).toBe(false);
    expect(totalAcked).toBeGreaterThan(0);
  });

  test("unacknowledged never goes below zero on over-ack", () => {
    const flow = new FlowController();
    flow.onData(100);
    flow.onAck(200);
    expect(flow.getUnacknowledged()).toBe(0);
  });

  test("stays paused on zero-size ack", () => {
    const flow = new FlowController();
    flow.onData(HighWatermarkChars);
    const resumed = flow.onAck(0);
    expect(resumed).toBe(false);
    expect(flow.isPaused()).toBe(true);
  });
});
