/**
 * StartedAgents — the terminals whose agent worktree new just started, for
 * a minute or until the terminal exits.
 */
import { expect, test } from "bun:test";
import {
  FIRST_TURN_GRACE_MS,
  StartedAgents,
} from "../../../../src/main/features/cli/started-agents";

const TERMINAL = { workspaceId: "w", tabId: "t" };

test("tells when a terminal's agent started, for a minute", () => {
  const started = new StartedAgents();
  started.mark(TERMINAL, 1_000);
  expect(started.since(TERMINAL, 1_000 + FIRST_TURN_GRACE_MS - 1)).toBe(1_000);
  expect(started.since(TERMINAL, 1_000 + FIRST_TURN_GRACE_MS)).toBeUndefined();
  expect(started.since({ workspaceId: "w", tabId: "other" }, 1_000)).toBeUndefined();
});

test("forgets a terminal that exits", () => {
  const listeners = new Map<string, (args: unknown) => void>();
  const started = new StartedAgents({
    on(event, cb) {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
  });
  started.mark(TERMINAL, 1_000);
  listeners.get("exit")?.(TERMINAL);
  expect(started.since(TERMINAL, 1_000)).toBeUndefined();
});
