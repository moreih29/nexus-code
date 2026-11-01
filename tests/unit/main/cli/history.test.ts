/**
 * SessionHistory — the spans the sessions timeline draws: Claude's states,
 * other agents' output, waits on other terminals, kept in the app's
 * storage for a day.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionHistory } from "../../../../src/main/features/cli/history";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import type { ClaudeStatus } from "../../../../src/shared/claude/status";
import { SESSION_HISTORY_RETENTION_MS } from "../../../../src/shared/sessions/history";

const W = "w";
const A = { workspaceId: W, tabId: "a" };
const B = { workspaceId: W, tabId: "b" };

type ClaudeListener = (
  workspaceId: string,
  tabId: string,
  entry: { status: ClaudeStatus; since: number } | null,
) => void;

const open: SessionHistory[] = [];
afterEach(() => {
  for (const history of open.splice(0)) history.dispose();
});

function setup(storage = new GlobalStorage(new Database(":memory:")), startAt = 100_000) {
  const clock = { now: startAt };
  const listeners = new Map<string, (args: unknown) => void>();
  let claudeListener: ClaudeListener = () => {};
  const history = new SessionHistory(
    storage,
    {
      on(event, cb) {
        listeners.set(event, cb);
        return () => listeners.delete(event);
      },
    },
    {
      onChange(listener) {
        claudeListener = listener;
        return () => {};
      },
    },
    () => clock.now,
  );
  open.push(history);
  return {
    storage,
    clock,
    history,
    emit: (event: string, args: unknown) => listeners.get(event)?.(args),
    claude: (terminal: typeof A, status: ClaudeStatus | null) =>
      claudeListener(terminal.workspaceId, terminal.tabId, status && { status, since: clock.now }),
    spans: () => history.list([W], 0).map(({ state, start, end }) => [state, start, end]),
  };
}

describe("SessionHistory", () => {
  test("records Claude's states as its hooks report them", () => {
    const { clock, claude, spans } = setup();
    claude(A, "running");
    clock.now += 4_000;
    claude(A, "running"); // the message changed, not the state
    clock.now += 1_000;
    claude(A, "completed");
    clock.now += 3_000;
    claude(A, null);
    expect(spans()).toEqual([
      ["running", 100_000, 105_000],
      ["completed", 105_000, 108_000],
    ]);
  });

  test("records other agents' output as busy until 2s after the last of it", () => {
    const { clock, emit, history, spans } = setup();
    for (const offset of [0, 500, 1_500]) {
      clock.now = 100_000 + offset;
      emit("data", { ...A, chunk: "x" });
    }
    clock.now = 106_000;
    emit("data", { ...A, chunk: "x", replay: true });
    emit("data", { ...A, chunk: "x" });
    history.endQuiet();
    expect(spans()).toEqual([
      ["busy", 100_000, 103_500],
      ["busy", 106_000, null],
    ]);
    clock.now = 109_000;
    history.endQuiet();
    expect(spans().at(-1)).toEqual(["busy", 106_000, 108_000]);
  });

  test("leaves a terminal's output out once Claude's hooks tell its state", () => {
    const { clock, emit, claude, spans } = setup();
    emit("data", { ...A, chunk: "x" });
    clock.now += 1_000;
    claude(A, "running");
    clock.now += 1_000;
    emit("data", { ...A, chunk: "x" });
    expect(spans()).toEqual([
      ["busy", 100_000, 101_000],
      ["running", 101_000, null],
    ]);
  });

  test("records waits until they end or the waiting terminal exits", () => {
    const { clock, emit, history } = setup();
    const end = history.beginWait(A, B, clock.now);
    clock.now += 5_000;
    end();
    history.beginWait(A, B, clock.now);
    clock.now += 2_000;
    emit("exit", A);
    expect(history.list([W], 0)).toEqual([
      { ...A, state: "waiting", start: 100_000, end: 105_000, target: B },
      { ...A, state: "waiting", start: 105_000, end: 107_000, target: B },
    ]);
  });

  test("ends what is open when the app quits", () => {
    const { clock, claude, emit, history, spans } = setup();
    claude(A, "running");
    emit("data", { ...B, chunk: "x" });
    clock.now += 10_000;
    history.dispose();
    expect(spans()).toEqual([
      ["running", 100_000, 110_000],
      ["busy", 100_000, 102_000],
    ]);
  });

  test("on start, ends the spans a crash left open at their start, and drops those ended over a day ago", () => {
    const storage = new GlobalStorage(new Database(":memory:"));
    const old = storage.startSessionSpan({ ...A, state: "idle", start: 1_000 });
    storage.endSessionSpan(old, 2_000);
    storage.startSessionSpan({ ...A, state: "running", start: 99_000 });
    const { spans } = setup(storage, 2_000 + SESSION_HISTORY_RETENTION_MS + 1);
    expect(spans()).toEqual([["running", 99_000, 99_000]]);
  });

  test("lists only the given workspaces' spans that last into the period", () => {
    const storage = new GlobalStorage(new Database(":memory:"));
    const ended = storage.startSessionSpan({ ...A, state: "idle", start: 1_000 });
    storage.endSessionSpan(ended, 2_000);
    storage.startSessionSpan({ ...A, state: "running", start: 2_000 });
    storage.startSessionSpan({ workspaceId: "other", tabId: "a", state: "running", start: 2_000 });
    expect(storage.listSessionSpans([W], 3_000).map((s) => s.state)).toEqual(["running"]);
    expect(storage.listSessionSpans([W], 2_000).map((s) => s.state)).toEqual(["idle", "running"]);
    expect(storage.listSessionSpans([], 0)).toEqual([]);
  });
});
