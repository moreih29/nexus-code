/**
 * ClaudeExitWatch — Claude Code that died without its SessionEnd hook: once
 * its tab goes quiet with the shell back in the foreground, running nothing,
 * its state is cleared.
 */
import { afterEach, expect, test } from "bun:test";
import { ClaudeStatusBroker } from "../../../../src/main/features/claude/status";
import { ClaudeExitWatch } from "../../../../src/main/features/cli/claude-exit";

const QUIET_MS = 15;
const T = { workspaceId: "w", tabId: "t" };

const open: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const it of open.splice(0)) it.dispose();
});

const settle = (ms = QUIET_MS * 3) => new Promise((r) => setTimeout(r, ms));

type Front = { name: string; alone: boolean | undefined } | null;

/** `name` in the foreground, alone in its process group unless told. */
const front = (name: string, alone: boolean | undefined = true): Front => ({ name, alone });

function setup(program: () => Front | Promise<Front>) {
  const listeners = new Map<string, Array<(args: unknown) => void>>();
  const source = {
    on(event: string, cb: (args: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      return () => {};
    },
  };
  const broker = new ClaudeStatusBroker(() => {});
  const looked: string[] = [];
  const watch = new ClaudeExitWatch(
    source,
    broker,
    async (workspaceId, tabId) => {
      looked.push(`${workspaceId}:${tabId}`);
      return program();
    },
    Date.now,
    QUIET_MS,
  );
  open.push(watch);
  const emit = (event: string, args: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(args);
  };
  return {
    broker,
    looked,
    print: (chunk = "x", terminal = T) => emit("data", { ...terminal, chunk }),
  };
}

test("Claude killed mid-turn: the shell's prompt goes quiet, and its state ends", async () => {
  const { broker, print } = setup(() => front("zsh"));
  broker.set(T.workspaceId, T.tabId, "running");
  print("zsh: killed     claude\r\n% ");
  expect(broker.get(T.workspaceId, T.tabId)?.status).toBe("running");
  await settle();
  expect(broker.get(T.workspaceId, T.tabId)).toBeNull();
});

test("an idle Claude that died is cleared too, so nothing types a prompt into the shell", async () => {
  const { broker, print } = setup(() => front("-bash"));
  broker.set(T.workspaceId, T.tabId, "idle");
  print();
  await settle();
  expect(broker.get(T.workspaceId, T.tabId)).toBeNull();
});

test("Claude, or a program it runs, still in the foreground keeps its state", async () => {
  for (const program of [front("claude"), front("node"), front("vim"), null]) {
    const { broker, print } = setup(() => program);
    broker.set(T.workspaceId, T.tabId, "running");
    print();
    await settle();
    expect(broker.get(T.workspaceId, T.tabId)?.status).toBe("running");
  }
});

test("looks only once output is quiet, and only at tabs with Claude's state", async () => {
  const { broker, looked, print } = setup(() => front("claude"));
  broker.set(T.workspaceId, T.tabId, "running");
  for (let i = 0; i < 4; i++) {
    print();
    await settle(QUIET_MS / 3);
  }
  expect(looked).toEqual([]);
  print("x", { workspaceId: "w", tabId: "plain" });
  await settle();
  expect(looked).toEqual(["w:t"]);
});

test("a Claude started while the program was looked up keeps its state", async () => {
  let answer: (program: Front) => void = () => {};
  const { broker, print } = setup(() => new Promise((r) => (answer = r)));
  broker.set(T.workspaceId, T.tabId, "running");
  print();
  await settle();
  // The shell was in front when looked at; the wrapper then started Claude,
  // whose SessionStart lands before the answer.
  await settle(5);
  broker.set(T.workspaceId, T.tabId, "idle", undefined, null);
  answer(front("bash"));
  await settle(5);
  expect(broker.get(T.workspaceId, T.tabId)?.status).toBe("idle");
});

test("Claude started by a script keeps its state: the script's shell waits for it", async () => {
  // `bash run.sh` that runs claude: the script's bash leads the group in
  // front, with Claude in it, so the shell there is not alone.
  const { broker, print } = setup(() => front("bash", false));
  broker.set(T.workspaceId, T.tabId, "running");
  print();
  await settle();
  expect(broker.get(T.workspaceId, T.tabId)?.status).toBe("running");
});

test("from an agent that does not tell whether the shell is alone, its name is enough", async () => {
  const { broker, print } = setup(() => front("zsh", undefined));
  broker.set(T.workspaceId, T.tabId, "running");
  print();
  await settle();
  expect(broker.get(T.workspaceId, T.tabId)).toBeNull();
});
