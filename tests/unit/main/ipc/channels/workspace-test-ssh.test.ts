/**
 * Scenario tests for workspace.testSsh temporary SSH validation.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  type TestSshBootstrap,
  type TestSshCreateChannel,
  testSshHandler,
} from "../../../../../src/main/features/workspace/ipc";
import type {
  CreateSshChannelOptions,
  SshChannel,
} from "../../../../../src/main/infra/agent/ssh/channel";

/**
 * Creates a manually controlled promise for channel readiness assertions.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Builds the AbortError shape produced by disposed SSH channel waiters.
 */
function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

const fakeBootstrap = mock(async (options) => ({
  remoteCommand: `bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 ${options.remotePath}'`,
  platform: { os: "linux" as const, arch: "amd64" as const },
  uploaded: false,
})) as TestSshBootstrap;

describe("workspace.testSsh handler", () => {
  it("opens a temporary SSH channel, waits for ready, validates readdir, and disposes", async () => {
    const ready = deferred<void>();
    const calls: Array<{ method: string; params: unknown }> = [];
    const channel: SshChannel = {
      ready: ready.promise,
      call: mock(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return [];
      }),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    const createChannel = mock(
      ((_options: CreateSshChannelOptions) => channel) as TestSshCreateChannel,
    );

    const promise = testSshHandler(
      createChannel,
      fakeBootstrap,
    )({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      authMode: "key-only",
      remotePath: "/srv/project",
    });
    await Promise.resolve();

    expect(calls).toEqual([]);
    ready.resolve();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(fakeBootstrap).toHaveBeenCalledWith({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      authMode: "key-only",
      remotePath: "/srv/project",
    });
    expect(createChannel).toHaveBeenCalledWith({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      authMode: "key-only",
      remoteCommand:
        "bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 /srv/project'",
    });
    expect(calls).toEqual([{ method: "fs.readdir", params: { relPath: "." } }]);
    expect(channel.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized SshErrorCode failures without raw stderr", async () => {
    const rawError = new Error("Permission denied (publickey). raw stderr");
    (rawError as Error & { code: string }).code = "ssh.auth-failed";
    const channel: SshChannel = {
      ready: Promise.reject(rawError),
      call: mock(async () => []),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    channel.ready.catch(() => {});

    const createChannel = mock((() => channel) as TestSshCreateChannel);
    const result = await testSshHandler(
      createChannel,
      fakeBootstrap,
    )({
      host: "dev.example.com",
      remotePath: "/srv/project",
    });

    expect(result).toEqual({
      ok: false,
      code: "ssh.auth-failed",
      message: "SSH authentication failed",
    });
    expect(JSON.stringify(result)).not.toContain("raw stderr");
    expect(channel.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the temporary channel when the router call signal aborts", async () => {
    const ready = deferred<void>();
    const channel: SshChannel = {
      ready: ready.promise,
      call: mock(async () => []),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {
        ready.reject(createAbortError());
      }),
    };
    const createChannel = mock((() => channel) as TestSshCreateChannel);
    const controller = new AbortController();

    const promise = testSshHandler(createChannel, fakeBootstrap)(
      { host: "dev.example.com", remotePath: "/srv/project" },
      { signal: controller.signal },
    );
    await Promise.resolve();

    controller.abort();

    expect(channel.dispose).toHaveBeenCalledTimes(1);
    // Per T4 Result-contract migration, cancellation resolves with ipcErr("cancelled")
    // instead of rejecting with AbortError — the router stays log-silent.
    const result = await promise;
    expect(result).toMatchObject({ ok: false, kind: "cancelled" });
  });

  it("reuses the bootstrap ControlMaster for interactive validation and disposes it", async () => {
    const bootstrapDispose = mock(() => {});
    const sshBootstrap = mock(async () => ({
      remoteCommand:
        "bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 /srv/project'",
      platform: { os: "linux" as const, arch: "amd64" as const },
      uploaded: true,
      controlPath: "/tmp/nexus-ssh/control.sock",
      dispose: bootstrapDispose,
    })) as TestSshBootstrap;
    const channel: SshChannel = {
      ready: Promise.resolve(),
      call: mock(async () => []),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    const createChannel = mock((() => channel) as TestSshCreateChannel);

    await expect(
      testSshHandler(
        createChannel,
        sshBootstrap,
      )({
        host: "127.0.0.1",
        user: "nexus-dev",
        port: 2223,
        authMode: "interactive",
        remotePath: "/home/nexus-dev/workspace",
      }),
    ).resolves.toEqual({ ok: true });

    expect(sshBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "interactive", remotePath: "/home/nexus-dev/workspace" }),
    );
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "interactive",
        remoteCommand:
          "bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 /srv/project'",
        controlPath: "/tmp/nexus-ssh/control.sock",
      }),
    );
    expect(bootstrapDispose).toHaveBeenCalledTimes(1);
  });
});
