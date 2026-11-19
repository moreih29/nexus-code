import { createWslChannel, ensureWslAgent, ensureWslLspServer } from "../../../infra/agent/wsl";

/** How a WSL workspace's agent is installed, reached, and given language servers. */
export interface WorkspaceWslTransport {
  readonly bootstrap: typeof ensureWslAgent;
  readonly createChannel: typeof createWslChannel;
  readonly lspBootstrap: typeof ensureWslLspServer;
}
export const defaultWslTransport: WorkspaceWslTransport = {
  bootstrap: ensureWslAgent,
  createChannel: createWslChannel,
  lspBootstrap: ensureWslLspServer,
};
