import { createAbortError, isAbortError } from "../../../shared/abort";
import { ipcContract } from "../../../shared/ipc/contract";
import { type SshErrorCode, SshErrorCodeSchema } from "../../../shared/ssh/errors";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  ensureRemoteAgent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
} from "../../infra/agent/ssh/channel";
import type { WorkspaceManager } from "./manager";
import type { SshBrowseSessionRegistry } from "../ssh/browse-session-registry";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import { AuthCancelledError } from "../../infra/agent/ssh/auth-prompt";

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
  /**
   * Browse-session registry, supplied in production so a workspace created
   * from an SSH directory picker can claim that session's authenticated
   * ControlMaster instead of opening a second, separately-authenticated
   * connection.
   */
  readonly browseRegistry?: SshBrowseSessionRegistry;
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
        const meta = manager.create(createArgs);
        const browseSessionId =
          "sshBrowseSessionId" in createArgs ? createArgs.sshBrowseSessionId : undefined;
        if (browseSessionId && meta.location.kind === "ssh" && dependencies.browseRegistry) {
          // Reuse the browse session's authenticated ControlMaster so the
          // workspace's first connection does not prompt for credentials
          // again. A null result (session expired/already claimed) simply
          // falls back to a fresh authenticated connection.
          const master = dependencies.browseRegistry.claimMaster(browseSessionId);
          if (master) {
            manager.adoptSshControlMaster(meta.id, master);
          }
        }
        return meta;
      },
      createAndConnect: async (args: unknown, ctx?: CallContext) => {
        const createArgs = validateArgs(c.createAndConnect.args, args);
        const browseSessionId =
          "sshBrowseSessionId" in createArgs ? createArgs.sshBrowseSessionId : undefined;

        // ── Local or directory-picker SSH (already authenticated) ─────────────
        // When a browse session id is supplied the user already authenticated
        // via the SSH directory picker; use the legacy create+claimMaster path
        // which reuses that session's ControlMaster without a second prompt.
        if (createArgs && "location" in createArgs && createArgs.location.kind !== "ssh") {
          // Local: commit immediately — no connection step needed.
          const meta = manager.create(createArgs);
          return ipcOk(meta);
        }

        if (browseSessionId && dependencies.browseRegistry) {
          // Directory-picker SSH: workspace is pre-authenticated via the
          // browse session. Commit then adopt the ControlMaster.
          const meta = manager.create(createArgs);
          const master = dependencies.browseRegistry.claimMaster(browseSessionId);
          if (master) {
            manager.adoptSshControlMaster(meta.id, master);
          }
          return ipcOk(meta);
        }

        // ── Standalone SSH (reconnect bookmark or new server) ─────────────────
        // Auth-before-commit path: run SSH bootstrap before persisting so a
        // cancelled or failed authentication never creates an orphaned entry.
        try {
          const meta = await manager.createAndConnectSsh(createArgs);
          return ipcOk(meta);
        } catch (error) {
          // User-initiated cancellation (password dialog closed / signal aborted).
          // Return a Result so the router passes through silently — no log.
          if (isSshAuthCancellation(error) || isAbortError(error)) {
            return ipcErr("cancelled", "SSH authentication cancelled");
          }
          // Typed SSH failures (wrong credentials, host unreachable, …) —
          // surface as auth-failed so the renderer can show a human message.
          const code = sshErrorCodeFromError(error);
          if (code) {
            return ipcErr("auth-failed", messageForSshErrorCode(code), { code });
          }
          // Unexpected bug — rethrow so the router logs it.
          throw error;
        }
      },
      update: (args: unknown) => {
        const { id, ...partial } = validateArgs(c.update.args, args);
        return manager.update(id, partial);
      },
      reorder: (args: unknown) => {
        const { id, beforeId, afterId, targetGroup } = validateArgs(c.reorder.args, args);
        return manager.reorder(id, { beforeId, afterId, targetGroup });
      },
      remove: (args: unknown) => {
        const { id } = validateArgs(c.remove.args, args);
        // remove() is idempotent — a missing workspace is silently ignored.
        // Return ipcOk so the router passes this through without logging.
        manager.remove(id);
        return ipcOk(undefined);
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
      reordered: {},
    },
  });
}

/**
 * Builds the SSH workspace validation handler with an injectable channel
 * factory so unit tests can exercise lifecycle behavior without OpenSSH.
 *
 * Cancellation (signal aborted or AbortError) is returned as
 * ipcErr("cancelled") so the router stays log-silent — the invariant
 * "a log = real bug" is preserved now that the router's special-case
 * AbortError branch has been removed.
 */
export function testSshHandler(
  createChannel: TestSshCreateChannel = createSshChannel,
  sshBootstrap: TestSshBootstrap = ensureRemoteAgent,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
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
      return { ok: true } satisfies TestSshResult;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        // User-initiated cancellation — return ipcErr so the router stays
        // silent. The renderer uses ipcCallResult to branch on kind "cancelled".
        return ipcErr("cancelled", "SSH validation cancelled");
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
    case "ssh.auth-cancelled":
      return "SSH authentication cancelled";
    case "ssh.session-expired":
      return "SSH browse session expired";
    case "ssh.path-not-found":
      return "Remote path not found";
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
 * Walks the error cause chain to detect user-initiated SSH authentication
 * cancellations. AuthCancelledError can be wrapped inside a createSshError
 * envelope by auth-pty, so the chain must be traversed recursively.
 */
function isSshAuthCancellation(error: unknown): boolean {
  if (error instanceof AuthCancelledError) return true;
  if (error instanceof Error && error.cause !== undefined) {
    return isSshAuthCancellation(error.cause);
  }
  return false;
}
