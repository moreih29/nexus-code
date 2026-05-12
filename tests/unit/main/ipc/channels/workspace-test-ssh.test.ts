/**
 * Scenario tests for workspace.testSsh temporary SSH validation.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  type TestSshCreateChannel,
  testSshHandler,
} from "../../../../../src/main/ipc/channels/workspace";
import type {
  CreateSshChannelOptions,
  SshChannel,
} from "../../../../../src/main/transport/ssh-channel";

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

    const promise = testSshHandler(createChannel)({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      remotePath: "/srv/project",
    });
    await Promise.resolve();

    expect(calls).toEqual([]);
    ready.resolve();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(createChannel).toHaveBeenCalledWith({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      remoteCommand: "bash -lc 'cd /srv/project && exec bun src/agent/index.ts /srv/project'",
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
    const result = await testSshHandler(createChannel)({
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

    const promise = testSshHandler(createChannel)(
      { host: "dev.example.com", remotePath: "/srv/project" },
      { signal: controller.signal },
    );

    controller.abort();

    expect(channel.dispose).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
