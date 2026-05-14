import { describe, expect, it, jest } from "bun:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  createSshChannel,
  type SshChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/ssh-channel";
import type { SshErrorCode } from "../../../../src/shared/types/ssh-errors";

class FakeStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeStdin {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;
  ended = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeSshChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();
  readonly killSignals: string[] = [];
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal));
    this.killed = true;
    return true;
  }
}

class FakePty {
  readonly writes: string[] = [];
  private readonly data = new EventEmitter();
  private readonly exit = new EventEmitter();

  onData(callback: (data: string) => void): { dispose(): void } {
    this.data.on("data", callback);
    return { dispose: () => this.data.off("data", callback) };
  }

  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exit.on("exit", callback);
    return { dispose: () => this.exit.off("exit", callback) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {}

  emitData(data: string): void {
    this.data.emit("data", data);
  }

  emitExit(exitCode: number): void {
    this.exit.emit("exit", { exitCode });
  }
}

function makeChannel() {
  const child = new FakeSshChild();
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: SpawnOptionsWithoutStdio;
  }> = [];
  const spawn = (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams => {
    spawnCalls.push({ command, args, options });
    return child as unknown as ChildProcessWithoutNullStreams;
  };

  const channel = createSshChannel(
    {
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      remoteCommand: "agent /repo",
    },
    { spawn, requestTimeoutMs: 10_000 },
  );

  return { channel, child, spawnCalls };
}

function parseLastRequest(child: FakeSshChild): { id: string; method: string; params: unknown } {
  const line = child.stdin.writes.at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line ?? "{}");
}

async function expectErrorCode(promise: Promise<unknown>, code: SshErrorCode): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createSshChannel", () => {
  it("uses injected spawn and writes the expected ssh request frame", async () => {
    const { channel, child, spawnCalls } = makeChannel();

    const call = channel.call("fs.readdir", { relPath: "." });
    const request = parseLastRequest(child);

    expect(spawnCalls).toEqual([
      {
        command: "ssh",
        args: [
          "-o",
          "BatchMode=yes",
          "-p",
          "2222",
          "-i",
          "/tmp/key",
          "--",
          "deploy@dev.example.com",
          "agent /repo",
        ],
        options: { detached: false, stdio: ["pipe", "pipe", "pipe"] },
      },
    ]);
    expect(request.method).toBe("fs.readdir");
    expect(request.params).toEqual({ relPath: "." });

    channel.dispose();
    await expect(call).rejects.toThrow("SSH channel disposed");
    await expect(channel.ready).rejects.toThrow("SSH channel disposed");
  });

  it("round-trips one JSON response line split across four 1024B-ish chunks", async () => {
    const { channel, child } = makeChannel();
    const call = channel.call("fs.readFile", { relPath: "large.txt" });
    const request = parseLastRequest(child);
    const payload = "x".repeat(4_100);
    const line = `${JSON.stringify({ id: request.id, result: { payload } })}\n`;

    expect(line.length).toBeGreaterThan(4_096);
    child.stdout.emitData(line.slice(0, 1_024));
    child.stdout.emitData(line.slice(1_024, 2_048));
    child.stdout.emitData(line.slice(2_048, 3_072));
    child.stdout.emitData(line.slice(3_072));

    await expect(call).resolves.toEqual({ payload });
    await expect(channel.ready).resolves.toBeUndefined();
  });

  it("dispatches multiple JSON response lines delivered in one stdout chunk", async () => {
    const { channel, child } = makeChannel();
    const first = channel.call("fs.stat", { relPath: "a.ts" });
    const firstRequest = parseLastRequest(child);
    const second = channel.call("fs.stat", { relPath: "b.ts" });
    const secondRequest = parseLastRequest(child);

    child.stdout.emitData(
      `${JSON.stringify({ id: firstRequest.id, result: { name: "a.ts" } })}\n${JSON.stringify({
        id: secondRequest.id,
        result: { name: "b.ts" },
      })}\n`,
    );

    await expect(first).resolves.toEqual({ name: "a.ts" });
    await expect(second).resolves.toEqual({ name: "b.ts" });
  });

  it("rejects calls for JSON error response frames", async () => {
    const { channel, child } = makeChannel();
    const call = channel.call("fs.readFile", { relPath: "missing.txt" });
    const request = parseLastRequest(child);

    child.stdout.emitData(
      `${JSON.stringify({
        id: request.id,
        error: { message: "Remote file missing", code: "FS_ERROR.NOT_FOUND" },
      })}\n`,
    );

    try {
      await call;
      throw new Error("Expected SSH call to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Remote file missing");
      expect((error as { code?: string }).code).toBe("FS_ERROR.NOT_FOUND");
    }
    await expect(channel.ready).resolves.toBeUndefined();
  });

  it("classifies permission denied stderr as ssh.auth-failed", async () => {
    const { channel, child } = makeChannel();
    const lifecycleEvents: SshChannelLifecycleEvent[] = [];
    channel.onLifecycle((event) => {
      lifecycleEvents.push(event);
    });

    child.stderr.emitData("Permission denied (publickey).\n");

    await expectErrorCode(channel.ready, "ssh.auth-failed");
    expect(lifecycleEvents[0]?.type).toBe("failure");
  });

  it("classifies host key verification stderr as ssh.auth-failed", async () => {
    const { channel, child } = makeChannel();

    child.stderr.emitData("Host key verification failed.\n");

    await expectErrorCode(channel.ready, "ssh.auth-failed");
  });

  it("classifies connection refused and unreachable stderr as ssh.connect-failed", async () => {
    const refused = makeChannel();
    refused.child.stderr.emitData(
      "ssh: connect to host dev.example.com port 22: Connection refused\n",
    );
    await expectErrorCode(refused.channel.ready, "ssh.connect-failed");

    const unreachable = makeChannel();
    unreachable.child.stderr.emitData(
      "ssh: connect to host dev.example.com port 22: Network is unreachable\n",
    );
    await expectErrorCode(unreachable.channel.ready, "ssh.connect-failed");
  });

  it("classifies command not found stderr as server.spawn-failed", async () => {
    const { channel, child } = makeChannel();

    child.stderr.emitData("bash: bun: command not found\n");

    await expectErrorCode(channel.ready, "server.spawn-failed");
  });

  it("classifies malformed stdout NDJSON as server.protocol-error", async () => {
    const { channel, child } = makeChannel();

    child.stdout.emitData("{not json}\n");

    await expectErrorCode(channel.ready, "server.protocol-error");
    expect(child.killSignals[0]).toBe("SIGTERM");
  });

  it("emits an exit lifecycle event when a ready channel closes cleanly", async () => {
    const { channel, child } = makeChannel();
    const lifecycleEvents: SshChannelLifecycleEvent[] = [];
    channel.onLifecycle((event) => {
      lifecycleEvents.push(event);
    });

    child.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
    await expect(channel.ready).resolves.toBeUndefined();
    child.emit("close", 0, null);

    expect(lifecycleEvents).toEqual([{ type: "exit", code: 0, signal: null }]);
  });

  it("rejects ready frames with mismatched protocol major versions", async () => {
    const { channel, child } = makeChannel();

    child.stdout.emitData(
      `${JSON.stringify({ type: "ready", protocolVersion: "2", serverVersion: "0.1.0" })}\n`,
    );

    await expectErrorCode(channel.ready, "server.protocol-version-mismatch");
    expect(child.killSignals[0]).toBe("SIGTERM");
  });

  it("sends SIGTERM and then SIGKILL when dispose grace expires", async () => {
    jest.useFakeTimers();
    try {
      const { channel, child } = makeChannel();

      channel.dispose();
      expect(child.stdin.ended).toBe(true);
      expect(child.killSignals).toEqual(["SIGTERM"]);

      jest.advanceTimersByTime(99);
      await flushMicrotasks();
      expect(child.killSignals).toEqual(["SIGTERM"]);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("authenticates with a PTY, respawns through ControlMaster, and disposes the master once", async () => {
    const pty = new FakePty();
    const phase2 = new FakeSshChild();
    const disposeChild = new FakeSshChild();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const unlinkCalls: string[] = [];

    const channel = createSshChannel(
      {
        host: "127.0.0.1",
        user: "alice",
        port: 2223,
        authMode: "interactive",
        remoteCommand: "printf ready",
      },
      {
        promptHandler: async (prompt) => ({
          kind: "password",
          promptId: prompt.promptId,
          value: "secret",
        }),
        auth: {
          promptIdPrefix: "prompt-1",
          spawnPty: () => pty as never,
          unlink: (path) => unlinkCalls.push(path),
        },
        spawn(command, args) {
          spawnCalls.push({ command, args });
          return (spawnCalls.length === 1
            ? phase2
            : disposeChild) as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );

    pty.emitData("alice@127.0.0.1's password:");
    await flushMicrotasks();
    pty.emitExit(0);
    await flushMicrotasks();
    phase2.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);

    await expect(channel.ready).resolves.toBeUndefined();
    expect(pty.writes).toEqual(["secret\r"]);
    expect(spawnCalls[0]?.args).toEqual(
      expect.arrayContaining([
        "-S",
        expect.stringContaining("control.sock"),
        "-o",
        "ControlMaster=no",
      ]),
    );

    channel.dispose();
    channel.dispose();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.args).toEqual(expect.arrayContaining(["-O", "exit"]));
    expect(unlinkCalls).toHaveLength(0);

    disposeChild.emit("close", 0, null);
    expect(unlinkCalls).toHaveLength(1);

    disposeChild.emit("close", 0, null);
    expect(unlinkCalls).toHaveLength(1);
  });

  it("uses key-only batch mode even when a prompt handler is injected", async () => {
    const child = new FakeSshChild();
    const pty = new FakePty();
    const promptHandler = jest.fn(async () => ({ kind: "cancel" as const, promptId: "unused" }));
    const spawnCalls: Array<{ command: string; args: string[] }> = [];

    const channel = createSshChannel(
      {
        host: "dev.example.com",
        user: "deploy",
        authMode: "key-only",
        remoteCommand: "printf ready",
      },
      {
        promptHandler,
        auth: { spawnPty: () => pty as never },
        spawn(command, args) {
          spawnCalls.push({ command, args });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );

    child.stderr.emitData("Permission denied (publickey).\n");

    await expectErrorCode(channel.ready, "ssh.auth-failed");
    expect(promptHandler).not.toHaveBeenCalled();
    expect(pty.writes).toEqual([]);
    expect(spawnCalls).toEqual([
      {
        command: "ssh",
        args: ["-o", "BatchMode=yes", "--", "deploy@dev.example.com", "printf ready"],
      },
    ]);
  });

  it("uses an existing ControlMaster without re-prompting for interactive auth", async () => {
    const child = new FakeSshChild();
    const pty = new FakePty();
    const promptHandler = jest.fn(async () => ({ kind: "cancel" as const, promptId: "unused" }));
    const spawnCalls: Array<{ command: string; args: string[] }> = [];

    const channel = createSshChannel(
      {
        host: "127.0.0.1",
        user: "alice",
        port: 2223,
        authMode: "interactive",
        controlPath: "/tmp/nexus-ssh/control.sock",
        remoteCommand: "printf ready",
      },
      {
        promptHandler,
        auth: { spawnPty: () => pty as never },
        spawn(command, args) {
          spawnCalls.push({ command, args });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      },
    );

    child.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);

    await expect(channel.ready).resolves.toBeUndefined();
    expect(promptHandler).not.toHaveBeenCalled();
    expect(pty.writes).toEqual([]);
    expect(spawnCalls[0]?.args).toEqual(
      expect.arrayContaining(["-S", "/tmp/nexus-ssh/control.sock", "-o", "ControlMaster=no"]),
    );
  });
});
