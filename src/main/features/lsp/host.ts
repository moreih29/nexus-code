// LSP host launcher — main process side.
// The Go agent owns the LSP server processes; this module exposes the stable
// handle consumed by IPC.

import { startAgentLspHost, type AgentLspWorkspaceManager } from "./agent-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventCallback = (args: unknown) => void;

export interface LspHostCallOptions {
  signal?: AbortSignal;
}

export interface LspHostHandle {
  call: (method: string, args: unknown, opts?: LspHostCallOptions) => Promise<unknown>;
  notify: (method: string, args: unknown) => void;
  respondServerRequest: (id: string | number, result: unknown) => void;
  rejectServerRequest: (id: string | number, message: string) => void;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
}

export interface LspHostSelectionOptions {
  workspaceManager: AgentLspWorkspaceManager;
  agentHostFactory?: (workspaceManager: AgentLspWorkspaceManager) => LspHostHandle;
}

export function startConfiguredLspHost(options: LspHostSelectionOptions): LspHostHandle {
  if (!options.workspaceManager) {
    throw new Error("workspaceManager is required for LSP host startup");
  }

  return (options.agentHostFactory ?? startAgentLspHost)(options.workspaceManager);
}
