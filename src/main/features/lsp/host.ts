import type {
  LspLogEntry,
  LspServerMemory,
  LspServerStatus,
  LspStopReason,
} from "../../../shared/lsp/status";
import {
  type AgentLspHostOptions,
  type AgentLspWorkspaceManager,
  startAgentLspHost,
} from "./agent-host";

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
  dispose: () => Promise<void> | void;
  disposeLanguage: (
    workspaceId: string,
    languageId: string,
    reason: LspStopReason,
    options?: { reopen?: boolean },
  ) => void;
  disposeServers: (
    matches: (workspaceId: string, languageId: string) => boolean,
    reason: LspStopReason,
    options?: { reopen?: boolean },
  ) => void;
  restartLanguage: (workspaceId: string, languageId: string) => void;
  enforceMaxActiveWorkspaces: () => void;
  serverStatuses: () => LspServerStatus[];
  serverLog: (workspaceId: string, languageId: string, afterSeq?: number) => LspLogEntry[];
  serverMemory: (workspaceId: string) => Promise<LspServerMemory[]>;
  forgetWorkspace: (workspaceId: string) => void;
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
