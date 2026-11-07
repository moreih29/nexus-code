/**
 * ActivityTracker — what a terminal running Codex or another CLI agent is
 * known to be doing: when it last printed, and the last notification it
 * raised.
 */
import { expect, test } from "bun:test";
import { ActivityTracker } from "../../../../src/main/features/cli/activity";

function host() {
  const listeners = new Map<string, (args: unknown) => void>();
  return {
    on(event: string, cb: (args: unknown) => void) {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
    emit(event: string, args: unknown) {
      listeners.get(event)?.(args);
    },
  };
}

test("output, the last notification and the terminal's end", () => {
  const source = host();
  let now = 1_000;
  const tracker = new ActivityTracker(source, () => now);

  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "\x1b]9;Agent turn complete\x07" });
  now = 5_000;
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "› next prompt" });
  expect(tracker.get("w", "t")).toEqual({
    lastOutputAt: 5_000,
    lastNotice: { body: "Agent turn complete", at: 1_000 },
  });

  // Output shown again after a reconnect is not new activity.
  now = 9_000;
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "old", replay: true });
  expect(tracker.get("w", "t")?.lastOutputAt).toBe(5_000);

  source.emit("exit", { workspaceId: "w", tabId: "t", code: 0 });
  expect(tracker.get("w", "t")).toBeNull();
});

test("what a terminal echoes of the keys typed in is no sign of work", () => {
  const source = host();
  let now = 1_000;
  const tracker = new ActivityTracker(source, () => now);
  const typed = (chunk: string, after: number) => {
    tracker.noteInput("w", "t");
    now += after;
    source.emit("data", { workspaceId: "w", tabId: "t", chunk });
  };

  // Typed before the terminal printed anything: nothing is known of it yet.
  typed("h", 10);
  expect(tracker.get("w", "t")).toBeNull();
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "\x1b]9;Agent turn complete\x07" });
  expect(tracker.get("w", "t")?.lastOutputAt).toBe(1_010);

  // The prompt typed into Codex, a key at a time: it is not at work.
  now = 5_000;
  typed("› f", 20);
  typed("› fi", 300);
  expect(tracker.get("w", "t")?.lastOutputAt).toBe(1_010);

  // What it prints once the prompt went in and it works on past the echo.
  typed("\r", 100);
  now += 400;
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "Working (1s)" });
  expect(tracker.get("w", "t")?.lastOutputAt).toBe(now);

  // A notification in an echo still counts; the output time stays.
  const before = now;
  typed("\x1b]9;Agent turn complete\x07", 10);
  expect(tracker.get("w", "t")).toEqual({
    lastOutputAt: before,
    lastNotice: { body: "Agent turn complete", at: now },
  });
});

test("snapshot lists every terminal with its workspace and tab", () => {
  const source = host();
  const tracker = new ActivityTracker(source, () => 2_000);

  source.emit("data", { workspaceId: "w", tabId: "t:1", chunk: "hi" });
  source.emit("data", { workspaceId: "v", tabId: "u", chunk: "\x1b]9;Done\x07" });
  expect(tracker.snapshot()).toEqual([
    { workspaceId: "w", tabId: "t:1", lastOutputAt: 2_000 },
    { workspaceId: "v", tabId: "u", lastOutputAt: 2_000, lastNotice: { body: "Done", at: 2_000 } },
  ]);
});

test("looks at the foreground program as output starts, and again once it has settled", async () => {
  const source = host();
  let now = 1_000;
  const programs = ["bash", "codex", "bash"];
  const looked: string[] = [];
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
  const tracker = new ActivityTracker(
    source,
    () => now,
    async (workspaceId, tabId) => {
      looked.push(`${workspaceId}:${tabId}`);
      return programs.shift() ?? null;
    },
    10,
  );

  // The task's shell starts, and Codex right after it.
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "$ " });
  await Promise.resolve();
  expect(tracker.get("w", "t")?.program).toBe("bash");
  now = 1_500;
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "› 5+6" });
  expect(looked).toHaveLength(1);
  await settled();
  expect(looked).toHaveLength(2);
  expect(tracker.get("w", "t")?.program).toBe("codex");
  expect(tracker.snapshot()[0]).toMatchObject({ tabId: "t", program: "codex" });

  // Output after a quiet spell may be a program started or ended since.
  now = 9_000;
  source.emit("data", { workspaceId: "w", tabId: "t", chunk: "$ " });
  expect(looked).toHaveLength(3);
  source.emit("exit", { workspaceId: "w", tabId: "t", code: 0 });
  await settled();
  expect(looked).toHaveLength(3);
  expect(tracker.get("w", "t")).toBeNull();
});

/** A tracker whose foreground lookup answers from `programs`, quiet after 20 ms of its clock. */
function looking(programs: Array<string | null>) {
  const source = host();
  const clock = { now: 1_000 };
  const looked: number[] = [];
  const tracker = new ActivityTracker(
    source,
    () => clock.now,
    async () => {
      looked.push(clock.now);
      return programs.shift() ?? null;
    },
    10,
    20,
  );
  const print = (at: number, chunk: string) => {
    clock.now = at;
    source.emit("data", { workspaceId: "w", tabId: "t", chunk });
  };
  const close = () => source.emit("exit", { workspaceId: "w", tabId: "t", code: 0 });
  return { tracker, clock, looked, print, close };
}

const elapse = () => new Promise((resolve) => setTimeout(resolve, 50));

test("an agent that printed until it exited: once quiet, the shell is seen and its notice goes", async () => {
  const { tracker, clock, looked, print, close } = looking(["bash", "codex", "bash"]);
  print(1_000, "$ ");
  print(1_500, "› 5+6");
  await elapse();
  expect(tracker.get("w", "t")?.program).toBe("codex");
  // Its turn's notification, then it exits within the same run of output.
  print(2_000, "\x1b]9;Agent turn complete\x07");
  print(2_500, "$ ");
  expect(looked).toHaveLength(2);
  clock.now = 2_600;
  await elapse();
  expect(looked).toHaveLength(3);
  expect(tracker.get("w", "t")).toEqual({ lastOutputAt: 2_500, program: "bash" });
  close();
});

test("output that ended before the look once it settled is not looked at again", async () => {
  const { looked, clock, print, close } = looking(["bash", "bash"]);
  print(1_000, "ls\r\n");
  await elapse();
  expect(looked).toHaveLength(2);
  clock.now = 5_000;
  await elapse();
  expect(looked).toHaveLength(2);
  close();
});

test("a program that is no agent keeps its notification when the shell is back", async () => {
  const { tracker, clock, print, close } = looking(["make", "make", "zsh"]);
  print(1_000, "building");
  await elapse();
  print(1_500, "\x1b]9;Build done\x07$ ");
  clock.now = 1_600;
  await elapse();
  expect(tracker.get("w", "t")).toMatchObject({
    program: "zsh",
    lastNotice: { body: "Build done", at: 1_500 },
  });
  close();
});
