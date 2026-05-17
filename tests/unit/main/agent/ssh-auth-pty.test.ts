import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { authenticateSshControlMaster } from "../../../../src/main/infra/agent/ssh/auth-pty";
import type { SshAuthPrompt } from "../../../../src/shared/ssh/auth-prompt";

class FakePty {
  readonly writes: string[] = [];
  readonly killed: Array<string | undefined> = [];
  private readonly data = new EventEmitter();
  private readonly exit = new EventEmitter();

  onData(callback: (data: string) => void): { dispose(): void } {
    this.data.on("data", callback);
    return { dispose: () => this.data.off("data", callback) };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exit.on("exit", callback);
    return { dispose: () => this.exit.off("exit", callback) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(signal?: string): void {
    this.killed.push(signal);
  }

  emitData(data: string): void {
    this.data.emit("data", data);
  }

  emitExit(exitCode: number): void {
    this.exit.emit("exit", { exitCode });
  }
}

/**
 * Minimal EventEmitter-based child stub for the dispose-master spawn path.
 * The production `unlinkAfterControlExit` registers `.once` and then calls
 * `.off` on close/exit/error events — the fake must be a full EventEmitter so
 * those calls do not throw and the cleanup timer fires synchronously instead
 * of after its 5-second fallback, preventing leaks into subsequent tests.
 */
class FakeDisposeChild extends EventEmitter {
  readonly stdin = { end() {} };

  // Immediately emit "close" so unlinkAfterControlExit runs cleanup
  // synchronously rather than waiting for the 5-second fallback timer.
  emitClose(): void {
    this.emit("close", 0, null);
  }
}

function authHarness() {
  const pty = new FakePty();
  const prompts: SshAuthPrompt[] = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const unlinkCalls: string[] = [];
  const disposeSpawnCalls: Array<{ command: string; args: string[] }> = [];
  const disposeChildren: FakeDisposeChild[] = [];
  const promise = authenticateSshControlMaster(
    { host: "127.0.0.1", user: "alice", port: 2223, controlPath: "/tmp/nexus-test.sock" },
    async (prompt) => {
      prompts.push(prompt);
      if (prompt.kind === "host-key")
        return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
      return { kind: "password", promptId: prompt.promptId, value: "secret" };
    },
    {
      promptIdPrefix: "prompt-1",
      spawnPty(command, args) {
        spawnCalls.push({ command, args });
        return pty as never;
      },
      spawn(command, args) {
        disposeSpawnCalls.push({ command, args });
        const child = new FakeDisposeChild();
        disposeChildren.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      unlink: (path) => unlinkCalls.push(path),
    },
  );

  return { pty, prompts, spawnCalls, disposeSpawnCalls, disposeChildren, unlinkCalls, promise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("authenticateSshControlMaster", () => {
  it("answers host-key and password prompts before resolving the master socket", async () => {
    const { pty, prompts, spawnCalls, promise } = authHarness();

    expect(spawnCalls[0]).toEqual({
      command: "ssh",
      args: [
        "-M",
        "-S",
        "/tmp/nexus-test.sock",
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=60",
        "-f",
        "-N",
        "-p",
        "2223",
        "--",
        "alice@127.0.0.1",
      ],
    });

    pty.emitData(
      "The authenticity of host '127.0.0.1' can't be established.\r\nED25519 key fingerprint is SHA256:abc123.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
    );
    await flushMicrotasks();
    pty.emitData("alice@127.0.0.1's password:");
    await flushMicrotasks();
    pty.emitExit(0);

    expect(prompts.map((prompt) => prompt.kind)).toEqual(["host-key", "password"]);
    expect(prompts[0]).toMatchObject({
      kind: "host-key",
      promptId: "prompt-1:host-key",
      fingerprint: "SHA256:abc123",
      keyType: "ED25519",
    });
    expect(prompts[1]).toMatchObject({
      kind: "password",
      promptId: "prompt-1:password",
      field: "password",
    });
    expect(pty.writes).toEqual(["yes\r", "secret\r"]);
    await expect(promise).resolves.toMatchObject({ controlPath: "/tmp/nexus-test.sock" });
  });

  it("reuses the same password promptId for a wrong-password retry", async () => {
    const { pty, prompts, promise } = authHarness();

    pty.emitData("alice@127.0.0.1's password:");
    await flushMicrotasks();
    pty.emitData("Permission denied, please try again.\r\nalice@127.0.0.1's password:");
    await flushMicrotasks();
    pty.emitExit(0);

    expect(prompts.map((prompt) => prompt.promptId)).toEqual([
      "prompt-1:password",
      "prompt-1:password",
    ]);
    expect(prompts[0]).toMatchObject({ kind: "password" });
    expect((prompts[0] as { retry?: boolean }).retry).toBeUndefined();
    expect(prompts[1]).toMatchObject({ kind: "password", retry: true });
    expect(pty.writes).toEqual(["secret\r", "secret\r"]);
    await expect(promise).resolves.toMatchObject({ controlPath: "/tmp/nexus-test.sock" });
  });

  it("kills the PTY, reports ssh.auth-failed, and unlinks the socket when cancelled", async () => {
    const pty = new FakePty();
    const unlinkCalls: string[] = [];
    const disposeSpawnCalls: string[][] = [];
    const promise = authenticateSshControlMaster(
      { host: "127.0.0.1", user: "alice", port: 2223, controlPath: "/tmp/nexus-test.sock" },
      async () => {
        throw new Error("cancelled");
      },
      {
        promptIdPrefix: "prompt-1",
        spawnPty: () => pty as never,
        spawn: (_command, args) => {
          disposeSpawnCalls.push(args);
          const child = new FakeDisposeChild();
          // Immediately settle the child so the cleanup callback fires before
          // the fallback timer, preventing async leaks into subsequent tests.
          queueMicrotask(() => child.emitClose());
          return child as unknown as ChildProcessWithoutNullStreams;
        },
        unlink: (path) => unlinkCalls.push(path),
      },
    );

    pty.emitData("alice@127.0.0.1's password:");
    await expect(promise).rejects.toMatchObject({ code: "ssh.auth-failed" });

    expect(pty.killed).toEqual([undefined]);
    expect(disposeSpawnCalls[0]).toContain("-O");
    expect(unlinkCalls).toEqual(["/tmp/nexus-test.sock"]);
  });

  it("fails fast when the PTY never emits prompt data or exit", async () => {
    const pty = new FakePty();
    const unlinkCalls: string[] = [];
    const promise = authenticateSshControlMaster(
      { host: "127.0.0.1", user: "alice", port: 2223, controlPath: "/tmp/nexus-test.sock" },
      async () => ({ kind: "password", promptId: "unused", value: "secret" }),
      {
        spawnPty: () => pty as never,
        spawn: () => {
          const child = new FakeDisposeChild();
          // Immediately settle so unlinkAfterControlExit's cleanup runs before
          // the 5-second fallback timer can leak into subsequent tests.
          queueMicrotask(() => child.emitClose());
          return child as unknown as ChildProcessWithoutNullStreams;
        },
        unlink: (path) => unlinkCalls.push(path),
        authTimeoutMs: 5,
      },
    );

    await expect(promise).rejects.toMatchObject({ code: "ssh.auth-failed" });
    expect(pty.killed).toEqual([undefined]);
    expect(unlinkCalls).toEqual(["/tmp/nexus-test.sock"]);
  });
});
