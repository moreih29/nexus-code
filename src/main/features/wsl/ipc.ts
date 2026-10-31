// WSL IPC: the distributions to offer when adding a workspace, and a browse
// session that starts the agent in one of them so the add dialog can pick a
// folder. The session joins the SSH browse sessions' registry, so
// `ssh.browseSession` and `ssh.closeBrowseSession` serve it unchanged.

import { ipcContract } from "../../../shared/ipc/contract";
import type { AgentChannel } from "../../infra/agent/channel";
import type { LspBootstrapProgressEvent } from "../../infra/agent/ssh/ssh-bootstrap/index";
import { createWslChannel, ensureWslAgent, listWslDistros } from "../../infra/agent/wsl";
import { register, validateArgs } from "../../infra/ipc-router";
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
      listDistros: () => listDistros(),
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
): (args: unknown) => Promise<{ sessionId: string; initialPath: string }> {
  const bootstrap = dependencies.bootstrap ?? ensureWslAgent;
  const createChannel = dependencies.createChannel ?? createWslChannel;
  return async (args) => {
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
    try {
      const result = await bootstrap({ distro, remotePath: "/" }, { onProgress });
      channel = createChannel({ distro, remoteCommand: result.remoteCommand });
      await channel.ready;
      const sessionId = registry.register(channel, null);
      return { sessionId, initialPath: result.remoteHome };
    } catch (error) {
      channel?.dispose();
      throw new Error(wslFailureMessage(error), { cause: error });
    }
  };
}

/**
 * What went wrong, for the dialog: a transport error's generic message hides
 * what wsl.exe said (an unknown distribution, WSL not installed), which it
 * carries as its cause.
 */
export function wslFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return error.message;
}
