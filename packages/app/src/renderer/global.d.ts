import type {
  TerminalIpcCommand,
  TerminalIpcEvent,
} from "../../../shared/src/contracts/terminal-ipc";
import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";
import type {
  ClaudeSettingsConsentRequest,
  ClaudeSettingsConsentResponse,
} from "../../../shared/src/contracts/claude-settings";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../shared/src/contracts/workspace-shell";
import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../shared/src/contracts/e3-surfaces";
import type {
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResultFor,
} from "../../../shared/src/contracts/e4-editor";

interface NexusPreloadDisposable {
  dispose(): void;
}

interface NexusTerminalApi {
  invoke(command: TerminalIpcCommand): Promise<unknown>;
  onEvent(listener: (event: TerminalIpcEvent) => void): NexusPreloadDisposable;
}

interface NexusHarnessApi {
  onObserverEvent(
    listener: (event: HarnessObserverEvent) => void,
  ): NexusPreloadDisposable;
}

interface NexusClaudeSettingsApi {
  onConsentRequest(
    listener: (request: ClaudeSettingsConsentRequest) => void,
  ): NexusPreloadDisposable;
  respondConsentRequest(response: ClaudeSettingsConsentResponse): Promise<void>;
}

interface NexusWorkspaceApi {
  openFolder(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  restoreSession(): Promise<WorkspaceSidebarState>;
  getSidebarState(): Promise<WorkspaceSidebarState>;
  onSidebarStateChanged(
    listener: (nextState: WorkspaceSidebarState) => void,
  ): NexusPreloadDisposable;
}

interface NexusWorkspaceDiffApi {
  readWorkspaceDiff(request: WorkspaceDiffRequest): Promise<WorkspaceDiffResult>;
}

interface NexusClaudeSessionApi {
  readTranscript(
    request: ClaudeTranscriptReadRequest,
  ): Promise<ClaudeTranscriptReadResult>;
}

interface NexusEditorApi {
  invoke<TRequest extends E4EditorRequest>(
    request: TRequest,
  ): Promise<E4EditorResultFor<TRequest>>;
  onEvent(listener: (event: E4EditorEvent) => void): NexusPreloadDisposable;
}

declare global {
  interface Window {
    nexusTerminal: NexusTerminalApi;
    nexusWorkspace: NexusWorkspaceApi;
    nexusHarness: NexusHarnessApi;
    nexusClaudeSettings: NexusClaudeSettingsApi;
    nexusWorkspaceDiff: NexusWorkspaceDiffApi;
    nexusClaudeSession: NexusClaudeSessionApi;
    nexusEditor: NexusEditorApi;
  }
}

export {};
