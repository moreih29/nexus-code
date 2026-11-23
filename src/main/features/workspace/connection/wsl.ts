import { createWslChannel, ensureWslAgent, ensureWslLspServer } from "../../../infra/agent/wsl";

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
