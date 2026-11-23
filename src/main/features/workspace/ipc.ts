import { createAbortError, isAbortError, throwIfAborted } from "../../../shared/abort";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { SshErrorCode } from "../../../shared/ssh/errors";
import { messageForSshErrorCode } from "../../infra/agent/pipe";
import {
  type CreateSshChannelOptions,
  createSshChannel,
  type SshChannel,
} from "../../infra/agent/ssh/channel";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  ensureRemoteAgent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { agentCallError, sshErrorCode } from "../../infra/ipc-router/agent-errors";
import type { SshBrowseSessionRegistry } from "../ssh/browse-session-registry";
import type { WorkspaceManager } from "./manager";

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
      connectionSnapshot: () => ipcOk(manager.connectionSnapshot()),
      active: (_args: unknown) => {
        return manager.getActiveId();
      },
      create: (args: unknown) => {
        const createArgs = validateArgs(c.create.args, args);
        const meta = manager.create(createArgs);
        const browseSessionId =
          "sshBrowseSessionId" in createArgs ? createArgs.sshBrowseSessionId : undefined;
        if (browseSessionId && meta.location.kind === "ssh" && dependencies.browseRegistry) {
          const master = dependencies.browseRegistry.claimMaster(browseSessionId);
          if (master) {
            manager.adoptSshControlMaster(meta.id, master);
          }
        }
        return meta;
      },
      createAndConnect: async (args: unknown, _ctx?: CallContext) => {
        const createArgs = validateArgs(c.createAndConnect.args, args);
        const browseSessionId =
          "sshBrowseSessionId" in createArgs ? createArgs.sshBrowseSessionId : undefined;

        if (!("location" in createArgs) || createArgs.location.kind !== "ssh") {
          const meta = manager.create(createArgs);
          return ipcOk(meta);
        }

        if (browseSessionId && dependencies.browseRegistry) {
          const meta = manager.create(createArgs);
          const master = dependencies.browseRegistry.claimMaster(browseSessionId);
          if (master) {
            manager.adoptSshControlMaster(meta.id, master);
          }
          return ipcOk(meta);
        }

        try {
          const meta = await manager.createAndConnectSsh(createArgs);
          return ipcOk(meta);
        } catch (error) {
          const expected = agentCallError(error, "auth-failed");
          if (expected) return expected;
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
      remove: async (args: unknown) => {
        const { id } = validateArgs(c.remove.args, args);
        await manager.remove(id);
        return ipcOk(undefined);
      },
      activate: workspaceConnectionHandler(manager, "activate"),
      connect: workspaceConnectionHandler(manager, "connect"),
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

function workspaceConnectionHandler(manager: WorkspaceManager, action: "activate" | "connect") {
  return async (args: unknown) => {
    const { id } = validateArgs(c[action].args, args);
    if (manager.getName(id) === null) {
      return ipcErr("not-found", `Workspace not found: ${id}`, { category: "failed" });
    }
    try {
      await manager[action](id);
      return ipcOk(undefined);
    } catch (error) {
      const expected = agentCallError(error, "connection-failed");
      if (expected) return expected;
      throw error;
    }
  };
}

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
        signal,
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

function sshFailureResult(error: unknown): TestSshResult {
  const code = sshErrorCode(error) ?? "ssh.unknown";
  return {
    ok: false,
    code,
    message: messageForSshErrorCode(code),
  };
}
