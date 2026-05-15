import { ipcContract } from "../../../shared/ipc/ipc-contract";
import { type SshErrorCode, SshErrorCodeSchema } from "../../../shared/types/ssh-errors";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  ensureRemoteAgent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
} from "../../infra/agent/ssh/ssh-channel";
import type { WorkspaceManager } from "./manager";
import { type CallContext, register, validateArgs } from "../../infra/ipc/router";

const c = ipcContract.workspace.call;

type TestSshResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SshErrorCode; readonly message: string };

export type TestSshCreateChannel = (options: CreateSshChannelOptions) => SshChannel;
export type TestSshBootstrap = (
  options: EnsureRemoteAgentOptions,
) => Promise<EnsureRemoteAgentResult>;

interface WorkspaceChannelDependencies {
  readonly createSshChannel?: TestSshCreateChannel;
  readonly sshBootstrap?: TestSshBootstrap;
}

export function registerWorkspaceChannel(
  manager: WorkspaceManager,
  dependencies: WorkspaceChannelDependencies = {},
): void {
  register("workspace", {
    call: {
      list: (_args: unknown) => {
        return manager.list();
      },
      create: (args: unknown) => {
        const createArgs = validateArgs(c.create.args, args);
        return manager.create(createArgs);
      },
      update: (args: unknown) => {
        const { id, ...partial } = validateArgs(c.update.args, args);
        return manager.update(id, partial);
      },
      remove: (args: unknown) => {
        const { id } = validateArgs(c.remove.args, args);
        manager.remove(id);
      },
      activate: (args: unknown) => {
        const { id } = validateArgs(c.activate.args, args);
        return manager.activate(id);
      },
      testSsh: testSshHandler(dependencies.createSshChannel, dependencies.sshBootstrap),
    },
    listen: {
      changed: {},
      removed: {},
      attention: {},
      connectionChanged: {},
    },
  });
}

/**
 * Builds the SSH workspace validation handler with an injectable channel
 * factory so unit tests can exercise lifecycle behavior without OpenSSH.
 */
export function testSshHandler(
  createChannel: TestSshCreateChannel = createSshChannel,
  sshBootstrap: TestSshBootstrap = ensureRemoteAgent,
): (args: unknown, ctx?: CallContext) => Promise<TestSshResult> {
  return async (args: unknown, ctx?: CallContext): Promise<TestSshResult> => {
    const testArgs = validateArgs(c.testSsh.args, args);
    const signal = ctx?.signal;
    let channel: SshChannel | null = null;
    let disposeBootstrap: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    try {
      throwIfAborted(signal);
      const bootstrap = await sshBootstrap({
        host: testArgs.host,
        user: testArgs.user,
        port: testArgs.port,
        identityFile: testArgs.identityFile,
        authMode: testArgs.authMode,
        remotePath: testArgs.remotePath,
      });
      disposeBootstrap = bootstrap.dispose;
      throwIfAborted(signal);
      channel = createChannel({
        host: testArgs.host,
        user: testArgs.user,
        port: testArgs.port,
        identityFile: testArgs.identityFile,
        authMode: testArgs.authMode,
        remoteCommand: bootstrap.remoteCommand,
        controlPath: bootstrap.controlPath,
      });

      onAbort = () => {
        channel?.dispose();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        channel.dispose();
        throw createAbortError();
      }

      await channel.ready;
      throwIfAborted(signal);
      await channel.call("fs.readdir", { relPath: "." });
      throwIfAborted(signal);
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) {
        throw isAbortError(error) ? error : createAbortError();
      }
      return sshFailureResult(error);
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      channel?.dispose();
      disposeBootstrap?.();
    }
  };
}

/**
 * Converts SSH transport and server failures to the public testSsh result.
 */
function sshFailureResult(error: unknown): TestSshResult {
  const code = sshErrorCodeFromError(error) ?? "ssh.unknown";
  return {
    ok: false,
    code,
    message: messageForSshErrorCode(code),
  };
}

/**
 * Reads a stable SshErrorCode from errors without trusting arbitrary strings.
 */
function sshErrorCodeFromError(error: unknown): SshErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const parsed = SshErrorCodeSchema.safeParse((error as { code?: unknown }).code);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Maps SshErrorCode values to sanitized messages that never include stderr.
 */
function messageForSshErrorCode(code: SshErrorCode): string {
  switch (code) {
    case "ssh.connect-failed":
      return "SSH connection failed";
    case "ssh.auth-failed":
      return "SSH authentication failed";
    case "server.spawn-failed":
      return "Remote agent failed to start";
    case "server.protocol-error":
      return "Remote agent protocol error";
    case "server.protocol-version-mismatch":
      return "Remote agent protocol version mismatch";
    case "ssh.unknown":
      return "SSH workspace validation failed";
    case "transport.unknown":
      return "Agent transport failed";
  }
}

/**
 * Throws the router-compatible AbortError when a call signal is canceled.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

/**
 * Creates the cancellation error shape consumed by the IPC router.
 */
function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Detects the standard AbortError shape.
 */
function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}
