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
