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
