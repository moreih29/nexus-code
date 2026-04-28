import type {
  TerminalIpcCommand,
  TerminalIpcEvent,
} from "../../../shared/src/contracts/terminal/terminal-ipc";
import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness/harness-observer";
import type {
  ClaudeSettingsConsentRequest,
  ClaudeSettingsConsentResponse,
} from "../../../shared/src/contracts/claude/claude-settings";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../shared/src/contracts/workspace/workspace-shell";
import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
} from "../../../shared/src/contracts/claude/claude-session-transcript";
import type {
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../shared/src/contracts/workspace/workspace-diff";
import type {
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResultFor,
} from "../../../shared/src/contracts/editor/editor-bridge";
import type {
  SearchCancelCommand,
  SearchCompletedEvent,
  SearchFailedEvent,
  SearchStartedReply,
  SearchStartCommand,
  SearchCanceledEvent,
} from "../../../shared/src/contracts/generated/search-lifecycle";
import type { SearchResultChunkMessage } from "../../../shared/src/contracts/generated/search-relay";
import type {
  GitBranchCreateCommand,
  GitBranchCreateReply,
  GitBranchDeleteCommand,
  GitBranchDeleteReply,
  GitBranchListCommand,
  GitBranchListReply,
  GitCheckoutCommand,
  GitCheckoutReply,
  GitCommitCommand,
  GitCommitReply,
  GitDiffCommand,
  GitDiffReply,
  GitDiscardCommand,
  GitDiscardReply,
  GitFailedEvent,
  GitStageCommand,
  GitStageReply,
  GitStatusCommand,
  GitStatusReply,
  GitUnstageCommand,
  GitUnstageReply,
  GitWatchStartCommand,
  GitWatchStartedReply,
  GitWatchStopCommand,
  GitWatchStoppedReply,
} from "../../../shared/src/contracts/generated/git-lifecycle";
import type { GitStatusChangeEvent } from "../../../shared/src/contracts/generated/git-relay";
import type {
  FileActionStartFileDragRequest,
  FileActionStartFileDragResult,
  FileActionsRequest,
  FileActionsResult,
} from "../common/file-actions";

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
  invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>>;
  onEvent(listener: (event: EditorBridgeEvent) => void): NexusPreloadDisposable;
}

type NexusSearchEvent =
  | SearchStartedReply
  | SearchCompletedEvent
  | SearchFailedEvent
  | SearchCanceledEvent
  | SearchResultChunkMessage;

type NexusGitRequest =
  | GitStatusCommand
  | GitBranchListCommand
  | GitCommitCommand
  | GitStageCommand
  | GitUnstageCommand
  | GitDiscardCommand
  | GitCheckoutCommand
  | GitBranchCreateCommand
  | GitBranchDeleteCommand
  | GitDiffCommand
  | GitWatchStartCommand
  | GitWatchStopCommand;

type NexusGitResult =
  | GitStatusReply
  | GitBranchListReply
  | GitCommitReply
  | GitStageReply
  | GitUnstageReply
  | GitDiscardReply
  | GitCheckoutReply
  | GitBranchCreateReply
  | GitBranchDeleteReply
  | GitDiffReply
  | GitWatchStartedReply
  | GitWatchStoppedReply
  | GitFailedEvent;

type NexusGitEvent = NexusGitResult | GitStatusChangeEvent;

interface NexusSearchApi {
  startSearch(command: SearchStartCommand): Promise<SearchStartedReply | SearchFailedEvent>;
  cancelSearch(command: SearchCancelCommand): Promise<void>;
  onEvent(listener: (event: NexusSearchEvent) => void): NexusPreloadDisposable;
}

interface NexusGitApi {
  invoke(request: NexusGitRequest): Promise<NexusGitResult>;
  onEvent(listener: (event: NexusGitEvent) => void): NexusPreloadDisposable;
}

interface NexusFileActionsApi {
  invoke<TRequest extends FileActionsRequest>(request: TRequest): Promise<FileActionsResult>;
  startFileDrag(request: Omit<FileActionStartFileDragRequest, "type">): Promise<FileActionStartFileDragResult>;
  getPathForFile(file: File): string;
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
    nexusSearch: NexusSearchApi;
    nexusGit: NexusGitApi;
    nexusFileActions: NexusFileActionsApi;
  }
}

export {};
