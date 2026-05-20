// LSP host launcher — main process side.
// The Go agent owns the LSP server processes; this module exposes the stable
// handle consumed by IPC.

import {
  type AgentLspHostOptions,
  type AgentLspWorkspaceManager,
  startAgentLspHost,
} from "./agent-host";

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
  /**
   * Dispose the LSP server for a single language within a workspace and
   * broadcast a workspaceLspReset event for that (workspace, language) pair.
   * No-op when the server is not live. Called from the IPC layer when the
   * user toggles a language off.
   */
  disposeLanguage: (workspaceId: string, languageId: string, reason: string) => void;
}

export interface LspHostSelectionOptions {
  workspaceManager: AgentLspWorkspaceManager;
  agentHostOptions?: AgentLspHostOptions;
  agentHostFactory?: (
    workspaceManager: AgentLspWorkspaceManager,
    options?: AgentLspHostOptions,
  ) => LspHostHandle;
}

export function startConfiguredLspHost(options: LspHostSelectionOptions): LspHostHandle {
  if (!options.workspaceManager) {
    throw new Error("workspaceManager is required for LSP host startup");
  }

  const factory = options.agentHostFactory ?? startAgentLspHost;
  return factory(options.workspaceManager, options.agentHostOptions ?? {});
}
