// WSL IPC: the distributions to offer when adding a workspace, and a browse
// session that starts the agent in one of them so the add dialog can pick a
// folder. The session joins the SSH browse sessions' registry, so
// `ssh.browseSession` and `ssh.closeBrowseSession` serve it unchanged.

import { throwIfAborted } from "../../../shared/abort";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { AgentChannel } from "../../infra/agent/channel";
import type { LspBootstrapProgressEvent } from "../../infra/agent/ssh/ssh-bootstrap/index";
import { createWslChannel, ensureWslAgent, listWslDistros } from "../../infra/agent/wsl";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { agentCallError } from "../../infra/ipc-router/agent-errors";
import type { SshBrowseSessionRegistry } from "../ssh/browse-session-registry";
import type { BrowseProgressBroadcast } from "../ssh/ipc";

const c = ipcContract.wsl.call;

export interface WslChannelDependencies {
  readonly listDistros?: typeof listWslDistros;
  readonly bootstrap?: typeof ensureWslAgent;
  readonly createChannel?: typeof createWslChannel;
}

export function registerWslChannel(
  registry: SshBrowseSessionRegistry,
  broadcast?: BrowseProgressBroadcast,
  dependencies: WslChannelDependencies = {},
): void {
  const listDistros = dependencies.listDistros ?? listWslDistros;
  register("wsl", {
    call: {
      listDistros: async () => ipcOk(await listDistros()),
      openBrowseSession: openWslBrowseSessionHandler(registry, broadcast, dependencies),
    },
    listen: {},
  });
}

/**
 * Starts the agent in the distribution, rooted at "/" like an SSH browse
 * agent so every absolute path reads, and registers its channel. The picker
 * opens at the distribution user's home.
 */
export function openWslBrowseSessionHandler(
  registry: SshBrowseSessionRegistry,
  broadcast?: BrowseProgressBroadcast,
  dependencies: WslChannelDependencies = {},
): (
  args: unknown,
  ctx?: CallContext,
) => Promise<IpcResult<{ sessionId: string; initialPath: string }>> {
  const bootstrap = dependencies.bootstrap ?? ensureWslAgent;
  const createChannel = dependencies.createChannel ?? createWslChannel;
  return async (args, ctx) => {
    const { distro, progressId } = validateArgs(c.openBrowseSession.args, args);
    const onProgress =
      progressId && broadcast
        ? (event: LspBootstrapProgressEvent): void => {
            broadcast("ssh", "browseProgress", {
              progressId,
              name: event.name,
              phase: event.phase,
              bytesDone: event.bytesDone,
              bytesTotal: event.bytesTotal,
            });
          }
        : undefined;

    let channel: AgentChannel | null = null;
    const signal = ctx?.signal;
    const disposeChannel = () => {
      channel?.dispose();
      channel = null;
    };
    try {
      throwIfAborted(signal);
      const result = await bootstrap(
        { distro, remotePath: "/", ...(signal ? { signal } : {}) },
        { onProgress },
      );
      throwIfAborted(signal);
      channel = createChannel({ distro, remoteCommand: result.remoteCommand });
      signal?.addEventListener("abort", disposeChannel, { once: true });
      await channel.ready;
      throwIfAborted(signal);
      const sessionId = registry.register(channel, null);
      return ipcOk({ sessionId, initialPath: result.remoteHome });
    } catch (error) {
      disposeChannel();
      if (signal?.aborted) return ipcErr("cancelled", "Operation cancelled");
      const expected = agentCallError(error);
      if (expected) {
        if (expected.kind === "cancelled") return expected;
        return { ...expected, domain: undefined, message: wslFailureMessage(error) };
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", disposeChannel);
    }
  };
}

/**
 * Keeps diagnostic detail in the envelope for logging: the generic message hides
 * what wsl.exe said (an unknown distribution, WSL not installed), which it
 * carries as its cause.
 */
export function wslFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return error.message;
}
