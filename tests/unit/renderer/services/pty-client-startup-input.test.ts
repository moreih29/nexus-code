/**
 * Startup input — a command a new terminal runs — goes in once the shell is
 * ready: it printed its prompt and went quiet, or the wait ran out.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const writes: string[] = [];
/** When set, spawns wait for it. */
let spawnGate: Promise<void> | null = null;
const listeners = new Map<string, (args: Record<string, unknown>) => void>();

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(async (_channel: string, method: string, args: { data?: string }) => {
    if (method === "write") writes.push(args.data ?? "");
    if (method === "spawn" && spawnGate) await spawnGate;
    const value = method === "spawn" ? { pid: 1, shellPath: "/bin/zsh" } : undefined;
    return { ok: true as const, value };
  }),
  ipcListen: (
    _channel: string,
    event: string,
    callback: (args: Record<string, unknown>) => void,
  ) => {
    listeners.set(event, callback);
    return () => listeners.delete(event);
  },
  unwrapIpcResult: (result: { value: unknown }) => result.value,
}));

const { createPtyClient, queueStartupInput, STARTUP_INPUT_MAX_WAIT_MS, STARTUP_INPUT_QUIET_MS } =
  await import("../../../../src/renderer/services/terminal/pty-client");
const { quoteShellArgument } = await import(
  "../../../../src/renderer/services/terminal/shell-quote"
);

let tab = 0;
let tabId = "";

function emit(event: "data" | "exit", args: Record<string, unknown> = {}): void {
  listeners.get(event)?.({ workspaceId: "ws", tabId, chunk: "% ", code: 0, ...args });
}

function client() {
  return createPtyClient({ workspaceId: "ws", tabId, cwd: "/", onData() {}, onExit() {} });
}

beforeEach(() => {
  jest.useFakeTimers();
  writes.length = 0;
  tabId = `tab-${++tab}`;
  queueStartupInput("ws", tabId, (shellPath) => `claude ${shellPath}\r`);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("queueStartupInput", () => {
  it("types the input once the shell has printed and gone quiet", async () => {
    const pty = client();
    await pty.spawn({ cols: 80, rows: 24 });

    emit("data");
    jest.advanceTimersByTime(STARTUP_INPUT_QUIET_MS - 1);
    emit("data");
    jest.advanceTimersByTime(STARTUP_INPUT_QUIET_MS - 1);
    expect(writes).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(writes).toEqual(["claude /bin/zsh\r"]);

    // Once only.
    emit("data");
    jest.advanceTimersByTime(STARTUP_INPUT_MAX_WAIT_MS);
    expect(writes).toEqual(["claude /bin/zsh\r"]);
    pty.dispose();
  });

  it("types it when the prompt came before the spawn finished", async () => {
    let finishSpawn = () => {};
    spawnGate = new Promise((resolve) => {
      finishSpawn = resolve;
    });
    const pty = client();
    const spawned = pty.spawn({ cols: 80, rows: 24 });
    emit("data");
    jest.advanceTimersByTime(STARTUP_INPUT_QUIET_MS);
    expect(writes).toEqual([]);

    finishSpawn();
    spawnGate = null;
    await spawned;
    expect(writes).toEqual(["claude /bin/zsh\r"]);
    pty.dispose();
  });

  it("stops waiting for a shell that keeps printing or never does", async () => {
    const pty = client();
    await pty.spawn({ cols: 80, rows: 24 });

    jest.advanceTimersByTime(STARTUP_INPUT_MAX_WAIT_MS - 1);
    expect(writes).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(writes).toEqual(["claude /bin/zsh\r"]);
    pty.dispose();
  });

  it("drops the input of a session that ended first", async () => {
    const pty = client();
    await pty.spawn({ cols: 80, rows: 24 });
    emit("exit");

    jest.advanceTimersByTime(STARTUP_INPUT_MAX_WAIT_MS);
    expect(writes).toEqual([]);
    pty.dispose();
  });
});

describe("quoteShellArgument", () => {
  const text = `it's "done" $HOME`;

  it("single-quotes for POSIX shells and remote terminals", () => {
    expect(quoteShellArgument(text, "/bin/zsh")).toBe(`'it'\\''s "done" $HOME'`);
    expect(quoteShellArgument(text)).toBe(`'it'\\''s "done" $HOME'`);
  });

  it("doubles single quotes for PowerShell 7", () => {
    expect(quoteShellArgument(text, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      `'it''s "done" $HOME'`,
    );
  });

  describe("Windows PowerShell", () => {
    const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    it("also escapes double quotes for the program's command line", () => {
      expect(quoteShellArgument(text, powershell)).toBe(`'it''s \\"done\\" $HOME'`);
    });

    it("doubles the backslashes before a double quote", () => {
      expect(quoteShellArgument('say \\"hi\\"', powershell)).toBe(`'say \\\\\\"hi\\\\\\"'`);
    });

    it("doubles the trailing backslashes only when the argument has whitespace", () => {
      expect(quoteShellArgument("open C:\\dir\\", powershell)).toBe("'open C:\\dir\\\\'");
      expect(quoteShellArgument("C:\\dir\\", powershell)).toBe("'C:\\dir\\'");
    });
  });

  it("doubles double quotes for cmd", () => {
    expect(quoteShellArgument(text, "C:\\Windows\\System32\\cmd.exe")).toBe(
      `"it's ""done"" $HOME"`,
    );
  });

  it("keeps the argument on one line", () => {
    expect(quoteShellArgument("a\r\nb\nc", "/bin/bash")).toBe("'a b c'");
  });
});
