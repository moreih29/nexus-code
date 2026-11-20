import { expect, jest, test } from "bun:test";
import { setImmediate as flush } from "node:timers/promises";
import {
  type FrameKind,
  FramePriority,
  OutgoingFrames,
} from "../../../../../src/main/features/remote/outgoing";
import { mainWarnMock } from "../../../../log-test-spies";

async function sendBurst(
  queue: OutgoingFrames,
  kind: FrameKind,
  priority: FramePriority,
  count: number,
) {
  let sent = 0;
  for (let left = count; left > 0; left -= 100) {
    const frames = Array.from({ length: Math.min(left, 100) }, () =>
      queue.push({ kind, priority, send: async () => ++sent }),
    );
    await flush();
    expect(queue.size).toBe(0);
    await Promise.all(frames);
  }
  expect(sent).toBe(count);
}

test("priority frames overtake and displace bulk frames in a full queue", async () => {
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: string[] = [];
  const enqueue = (kind: FrameKind, priority: FramePriority, label: string) =>
    queue.push({ kind, priority, send: async () => sent.push(label) });
  try {
    for (let i = 0; i < 150; i++) void enqueue("reply:files.read", FramePriority.Data, "data");
    void enqueue("notification:chat.update", FramePriority.Watch, "watch");
    void enqueue("request:sessions.list", FramePriority.Request, "request");
    void enqueue("reply:sessions.list", FramePriority.Reply, "reply");
    void enqueue("hello", FramePriority.Hello, "hello");
    await flush();
    expect(sent.slice(0, 5)).toEqual(["hello", "reply", "request", "watch", "data"]);
    expect(dropped).toHaveBeenCalledTimes(4);
    expect(sent).toHaveLength(150);
  } finally {
    queue.close();
  }
});

test.each([
  ["request:sessions.list", FramePriority.Request],
  ["notification:chat.update", FramePriority.Watch],
] as const)("a flood of %s pauses only that kind", async (kind, priority) => {
  jest.useFakeTimers();
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: FrameKind[] = [];
  const enqueue = (kind: FrameKind, priority: FramePriority) =>
    queue.push({ kind, priority, send: async () => sent.push(kind) });
  try {
    const warnings = mainWarnMock.mock.calls.length;
    await sendBurst(queue, kind, priority, 1_200);
    expect(mainWarnMock.mock.calls.slice(warnings)).toHaveLength(0);
    await sendBurst(queue, kind, priority, 600);
    expect(mainWarnMock.mock.calls.slice(warnings).map(([msg]) => msg)).toEqual([
      expect.stringContaining(`kind=${kind} count=1800`),
    ]);

    const held = Array.from({ length: 150 }, () => enqueue(kind, priority));
    void enqueue("notification:terminal.update", FramePriority.Watch);
    void enqueue("request:chat.read", FramePriority.Request);
    void enqueue("reply:sessions.list", FramePriority.Reply);
    void enqueue("hello", FramePriority.Hello);
    await flush();
    expect(sent).toEqual([
      "hello",
      "reply:sessions.list",
      "request:chat.read",
      "notification:terminal.update",
    ]);
    expect(dropped).toHaveBeenCalledTimes(4);

    jest.advanceTimersByTime(4_999);
    await flush();
    expect(sent).toHaveLength(4);
    jest.advanceTimersByTime(1);
    await flush();
    expect(sent).toHaveLength(150);
    await Promise.all(held);
  } finally {
    queue.close();
    jest.useRealTimers();
  }
});

test.each([
  ["hello", FramePriority.Hello, 1_800],
  ["reply:sessions.list", FramePriority.Reply, 1_800],
  ["request:files.write.chunk", FramePriority.Data, 3_000],
  ["reply:files.read", FramePriority.Data, 3_000],
] as const)("a flood of %s is logged without pausing sends", async (kind, priority, limit) => {
  jest.useFakeTimers();
  const queue = new OutgoingFrames(
    () => {},
    () => {},
  );
  try {
    const warnings = mainWarnMock.mock.calls.length;
    await sendBurst(queue, kind, priority, limit - 100);
    expect(mainWarnMock.mock.calls.slice(warnings)).toHaveLength(0);
    await sendBurst(queue, kind, priority, 200);
    expect(mainWarnMock.mock.calls.slice(warnings).map(([msg]) => msg)).toEqual([
      `Relay frame burst kind=${kind} count=${limit} elapsedMs=0 action=observe`,
    ]);
  } finally {
    queue.close();
    jest.useRealTimers();
  }
});

test("a queued snapshot is replaced by the latest snapshot of the same watch", async () => {
  const dropped = jest.fn();
  const queue = new OutgoingFrames(dropped, () => {});
  const sent: number[] = [];
  const enqueue = (snapshotKey: string, revision: number) =>
    queue.push({
      kind: "notification:sessions.update",
      priority: FramePriority.Watch,
      snapshotKey,
      send: async () => sent.push(revision),
    });
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
