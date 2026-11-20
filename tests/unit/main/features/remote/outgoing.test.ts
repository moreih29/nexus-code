import { expect, jest, test } from "bun:test";
import { setImmediate as flush } from "node:timers/promises";
import {
  FramePriority,
  OutgoingFrames,
  SEND_FRAME_BURST,
  SEND_FRAMES_PER_SECOND,
} from "../../../../../src/main/features/remote/outgoing";

test("priority frames overtake a bulk backlog within the relay frame budget", async () => {
  jest.useFakeTimers();
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: string[] = [];
  const enqueue = (priority: FramePriority, label: string) =>
    queue.push({ priority, send: async () => sent.push(label) });
  try {
    for (let i = 0; i < SEND_FRAME_BURST; i++) void enqueue(FramePriority.Data, "data");
    void enqueue(FramePriority.Watch, "watch");
    void enqueue(FramePriority.Request, "request");
    void enqueue(FramePriority.Reply, "reply");
    void enqueue(FramePriority.Hello, "hello");
    await flush();
    expect(sent.slice(0, 5)).toEqual(["hello", "reply", "request", "watch", "data"]);
    expect(dropped).toHaveBeenCalledTimes(4);
    expect(sent.length).toBeLessThan(SEND_FRAME_BURST);

    for (let i = 0; i < 90; i++) void enqueue(FramePriority.Data, "next");
    const priority = enqueue(FramePriority.Reply, "new reply");
    await flush();
    expect(await priority).not.toBeNull();
    expect(sent.at(-1)).toBe("new reply");
    for (let elapsed = 100; elapsed <= 3_000; elapsed += 100) {
      jest.advanceTimersByTime(100);
      await flush();
      expect(sent.length).toBeLessThanOrEqual(
        SEND_FRAME_BURST + (elapsed * SEND_FRAMES_PER_SECOND) / 1000,
      );
    }
    expect(queue.size).toBe(0);
    expect(sent).toHaveLength(241);
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
