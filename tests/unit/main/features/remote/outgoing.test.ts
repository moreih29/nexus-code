import { expect, jest, test } from "bun:test";
import { setImmediate as flush } from "node:timers/promises";
import { FramePriority, OutgoingFrames } from "../../../../../src/main/features/remote/outgoing";

test("priority frames overtake and displace bulk frames in a full queue", async () => {
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: string[] = [];
  const enqueue = (priority: FramePriority, label: string) =>
    queue.push({ priority, send: async () => sent.push(label) });
  try {
    for (let i = 0; i < 150; i++) void enqueue(FramePriority.Data, "data");
    void enqueue(FramePriority.Watch, "watch");
    void enqueue(FramePriority.Request, "request");
    void enqueue(FramePriority.Reply, "reply");
    void enqueue(FramePriority.Hello, "hello");
    await flush();
    expect(sent.slice(0, 5)).toEqual(["hello", "reply", "request", "watch", "data"]);
    expect(dropped).toHaveBeenCalledTimes(4);
    expect(sent).toHaveLength(150);
  } finally {
    queue.close();
  }
});

test("the relay allows an 800-frame burst and then refills at 160 frames per second", async () => {
  jest.useFakeTimers();
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  let sent = 0;
  const enqueue = (count: number) =>
    Array.from({ length: count }, () =>
      queue.push({ priority: FramePriority.Request, send: async () => ++sent }),
    );
  try {
    // Drain between batches so that the pending queue never fills while spending the burst.
    for (let batch = 1; batch <= 8; batch++) {
      const frames = enqueue(100);
      await flush();
      expect(sent).toBe(batch * 100);
      await Promise.all(frames);
    }

    const first = enqueue(100);
    await flush();
    expect(sent).toBe(800);

    jest.advanceTimersByTime(500);
    await flush();
    expect(sent).toBe(880);

    const second = enqueue(60);
    jest.advanceTimersByTime(500);
    await flush();
    expect(sent).toBe(960);
    expect(dropped).not.toHaveBeenCalled();
    await Promise.all([...first, ...second]);
  } finally {
    queue.close();
    jest.useRealTimers();
  }
});

test("a waiting watch update is replaced only by the same watch's latest revision", async () => {
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: number[] = [];
  const enqueue = (watch: string, revision: number) =>
    queue.push({ priority: FramePriority.Watch, watch, send: async () => sent.push(revision) });
  try {
    const first = enqueue("watch-one", 1);
    const other = enqueue("watch-two", 2);
    const latest = enqueue("watch-one", 3);
    expect(await first).toBeNull();
    await Promise.all([other, latest]);
    expect(sent).toEqual([2, 3]);
    expect(dropped).toHaveBeenCalledTimes(1);
  } finally {
    queue.close();
  }
});
