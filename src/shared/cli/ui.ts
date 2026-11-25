import { z } from "zod";
import type {
  ChatCommand,
  ChatConfig,
  ChatPage,
  ChatPeek,
  RemoteConsent,
  RpcParams,
  RpcResult,
  TerminalCaret,
} from "../../../packages/remote-protocol/src/rpc";
import type { ChatPanel, ViewToolCall } from "../../../packages/remote-protocol/src/view";
import type { InstructionScope } from "../chat/instructions";
import type { RelaySender, TerminalOpener } from "../chat/relay";
import type { ParticipantCount } from "../notes/transcript";
import type { NoteStorageEntry } from "../notes/types";
import type { CustomShell } from "../pty/shell";
import type { ChatAgent } from "../sessions/task-agent";
import type { UpdateProgress, UpdateStatus } from "../updates/status";
import type {
  ProfileDefaultCopy,
  ProfileEditCopy,
  ProfileRemoveCopy,
  ProfileRuleCopy,
  SettingsEditCopy,
} from "./consent-copy";
import type { SettingsPage } from "./settings";

export const PROFILE_USAGE_REFRESH_TIMEOUT_MS = 120_000;

export interface CliPastSession {
  sessionId: string;
  title: string;
  at: number;
  bytes?: number;
  cwd: string;
  profile: string;
  firstPrompt?: string;
  gitBranch?: string;
  tabId?: string;
}

export interface CliChatImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  width?: number;
  height?: number;
}

export interface CliShellInfo {
  name: string;
  kind: "detected" | "custom";
  id: string;
  path: string;
  isDefault: boolean;
}

export type CliShellChange =
  | {
      readonly op: "add";
      readonly name: string;
      readonly program: string;
      readonly args: readonly string[];
    }
  | {
      readonly op: "edit";
      readonly shell: string;
      readonly name?: string;
      readonly program?: string;
      readonly args?: readonly string[];
    }
  | { readonly op: "remove"; readonly shell: string };

export interface CliShellPlan {
  readonly shell: CustomShell;
  readonly before?: CustomShell;
  readonly found?: string;
  readonly wasDefault: boolean;
  readonly snapshot: string;
  readonly saved: boolean;
}

export type CliNoteStorageEntry = NoteStorageEntry & { workspaceIds?: string[] };

export interface CliTabInfo {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly groupId: string;
  readonly shown: boolean;
  readonly session?: string;
  readonly cwd?: string;
  readonly filePath?: string;
  readonly url?: string;
  readonly dead?: boolean;
  readonly unstarted?: boolean;
  readonly openedBy?: TerminalOpener;
  readonly unsaved?: boolean;
  readonly pinned?: boolean;
}

export interface CliPlacement {
  readonly background: boolean;
  readonly besideTabId?: string;
}

export interface CliSessionTab {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly dead?: boolean;
  readonly unstarted?: boolean;
  readonly openedBy?: TerminalOpener;
  readonly chat?: CliSessionChat;
}

export interface CliSessionChat {
  readonly state: CliChatState;
  readonly since?: number;
  readonly message?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly waiting?: CliChatWaiting;
  readonly limitResume?: CliLimitResume;
  readonly waitingId?: string;
}

export interface CliSessionsSnapshotCursor {
  readonly workspace: number;
  readonly tab: number;
}

export type CliEditorView = "source" | "preview";

export type CliInputMode = "paste" | "keys";

export type CliBrowserAction = "goto" | "back" | "forward" | "reload";

export type CliLayoutNode =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly tabIds: readonly string[];
      readonly shownTabId: string | null;
    }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly direction: "columns" | "rows";
      readonly ratio: number;
      readonly first: CliLayoutNode;
      readonly second: CliLayoutNode;
    };

export type CliSplitSide = "left" | "right" | "up" | "down";

export type CliView = "agents" | "workspaces";

export interface CliViewAgent {
  readonly key: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly type: string;
}

export type CliViewHeldTab = {
  readonly key: string;
  readonly workspaceId: string;
  readonly title: string;
} & (
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "remote-file"; readonly device: string; readonly path: string }
  | { readonly kind: "remote-session"; readonly device: string; readonly path?: string }
);

export type CliAgentGrouping = "status" | "workspace";

export interface CliAgentView {
  readonly view: CliView;
  readonly grouping: CliAgentGrouping;
  readonly root: CliLayoutNode;
  readonly activePanelId: string;
  readonly agents: readonly CliViewAgent[];
  readonly held: readonly CliViewHeldTab[];
}

export type CliPanel = "sidebar" | "files";

export type CliFilesMode = "tree" | "search" | "git" | "agents" | "notes";

export interface CliPanels {
  readonly sidebar: { readonly visible: boolean; readonly width: number };
  readonly files: {
    readonly visible: boolean;
    readonly width: number;
    readonly mode: CliFilesMode;
  };
}

export interface CliProblem {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "info" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
}

export interface CliSettingInfo {
  readonly key: string;
  readonly summary: string;
  readonly type: CliSettingType;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly value: CliSettingValue;
  readonly changed: boolean;
  readonly readOnly?: boolean;
  readonly unavailable?: string;
}

export type CliSettingType = "boolean" | "integer" | "number" | "choice" | "text";
export type CliSettingValue = string | number | boolean;

export interface CliRecorder {
  readonly phase: string;
  readonly workspaceId?: string;
  readonly noteId?: string;
  readonly elapsedMs?: number;
  readonly voice: "unknown" | "signed-out" | "unavailable" | "ready";
}

export type CliSpeakerChange =
  | { op: "rename"; speaker: string; name: string }
  | { op: "merge"; from: string; into: string }
  | { op: "move"; first: string; last: string; into: string }
  | { op: "regroup"; participants: number | "auto" };

export type CliVoiceSuggestionAction =
  | { op: "list" }
  | { op: "accept" | "reject"; speaker: string; name: string };

export interface CliKeyBinding {
  readonly command: string;
  readonly area: "app" | "editor";
  readonly primary: string | null;
  readonly chord?: readonly [string, string];
  readonly when?: string;
}

export type CliKeyChange =
  | { readonly op: "set"; readonly command: string; readonly keys: readonly string[] }
  | { readonly op: "unbind"; readonly command: string }
  | { readonly op: "reset"; readonly command?: string };

export type CliChangeKind =
  | "open"
  | "diff"
  | "commit"
  | "terminalNew"
  | "terminalInput"
  | "fileWrite"
  | "fileWriteTree"
  | "fileMkdir"
  | "fileRead"
  | "fileReadTree"
  | "chatNew"
  | "chatInput"
  | "chatInterrupt"
  | "chatSettings"
  | "instructionsEdit"
  | "chatMode"
  | "chatProfile"
  | "chatProfileNew"
  | "profileAdd"
  | "profileEdit"
  | "profileRemove"
  | "profileDefault"
  | "profileRule"
  | "chatRewind"
  | "chatRewindFiles"
  | "chatFork"
  | "chatBackground"
  | "chatTaskStop"
  | "chatRemoteControlToggle"
  | "chatRemoteControlOn"
  | "chatRemoteControlOff"
  | "noteNew"
  | "noteWrite"
  | "noteSpeakers"
  | "voiceNamesDelete"
  | "noteRecord"
  | "noteRecordStop"
  | "tabClose"
  | "tabSave"
  | "tabRevert"
  | "browserOpen"
  | "browserNavigate"
  | "browserControl"
  | "portForward"
  | "layout"
  | "groupClose"
  | "tabRename"
  | "tabPin"
  | "worktreeNew"
  | "worktreeRemove"
  | "worktreeRemoveBranch"
  | "workspaceRemove"
  | "workspaceEdit"
  | "workspacePin"
  | "workspaceMove"
  | "permissionAllow"
  | "permissionDeny"
  | "sandboxExecution"
  | "settingTurnOn"
  | "browserPermissionRevoke"
  | "shellAdd"
  | "shellEdit"
  | "shellRemove"
  | "lspPath"
  | "noteStorageRemove";

export interface CliChange extends Pick<RemoteConsent["change"], "instructionEdit" | "profileAdd"> {
  readonly profileEdit?: ProfileEditCopy;
  readonly profileRemove?: ProfileRemoveCopy;
  readonly settingsEdit?: SettingsEditCopy;
  readonly profileDefault?: ProfileDefaultCopy;
  readonly profileRule?: ProfileRuleCopy;
  readonly kind: CliChangeKind;
  readonly detail?: string;
  readonly body?: string;
  readonly eachTime?: boolean;
  readonly terminal?: boolean;
}

export function isTerminalChange(change: CliChange): boolean {
  return (
    change.kind === "terminalInput" ||
    change.kind === "terminalNew" ||
    change.kind === "groupClose" ||
    change.terminal === true
  );
}

export interface CliChatSettings {
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
}

export interface CliChatChoices {
  readonly agent: ChatAgent;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mode: string;
  readonly models: readonly { readonly value: string; readonly name: string }[];
  readonly efforts: readonly string[];
  readonly dangerousBlocked?: string;
}

export type CliConsentAnswer = "once" | "session" | "deny" | "timeout";

export type CliChatState = "working" | "asking" | "idle" | "error";

export interface CliChatInfo {
  readonly agent: ChatAgent;
  readonly state: CliChatState;
  readonly message?: string;
  readonly since?: number;
  readonly request?: CliChatRequest;
  readonly waiting?: CliChatWaiting;
  readonly profile?: string;
  readonly goal?: CliChatGoal;
  readonly cwd?: string;
  readonly failure?: "usage_limit" | "transient" | "auth" | "request" | "other";
  readonly limitResume?: CliLimitResume;
}

export interface CliLimitResume {
  readonly state: "waiting" | "unknown" | "cancelled" | "gave_up";
  readonly at?: number;
  readonly resetsAt?: number;
  readonly tries?: number;
}

export interface CliChatWaiting {
  readonly kind: "permission" | "question" | "plan";
  readonly text: string;
}

export interface CliChatGoal {
  readonly objective: string;
  readonly status: string;
  readonly reason?: string;
}

export interface CliChatRequest {
  readonly id: string;
  readonly tool: string;
  readonly input: string;
}

export interface CliChatEntry {
  readonly i: number;
  readonly role: "user" | "agent" | "tool" | "notice";
  readonly text: string;
  readonly toolUseId?: string;
  readonly status?: string;
  readonly parentToolUseId?: string;
  readonly from?: RelaySender;
}

export interface CliChatTool {
  readonly i: number;
  readonly toolUseId: string;
  readonly name: string;
  readonly status: string;
  readonly input: unknown;
  readonly result?: { readonly text: string; readonly isError: boolean };
  readonly parentToolUseId?: string;
}

export interface CliSessionEvent {
  readonly seq: number;
  readonly at: number;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly kind: "terminal" | "claude" | "codex";
  readonly agent?: string;
  readonly from: string | null;
  readonly to: string;
  readonly phase: string;
  readonly message?: string;
  readonly goal?: CliSessionGoal;
}

export interface CliSessionGoal {
  readonly objective: string;
  readonly from: string | null;
  readonly status: string;
}

export type CliTaskStart = { readonly agent: ChatAgent } | { readonly command: string };

export interface CliUiOps {
  "tabs.list": {
    args: { workspaceId: string; agentOrder?: true; includeSession?: true };
    result: { tabs: CliTabInfo[] };
  };
  "terminal.read": {
    args: { workspaceId: string; tabId: string; lines: number; ansi?: boolean };
    result: { text: string; caret?: TerminalCaret };
  };
  "terminal.watch": {
    args: { workspaceId: string; tabId: string; watchId: string; lines: number; ansi?: boolean };
    result: { text: string; caret?: TerminalCaret };
  };
  "terminal.unwatch": {
    args: { watchId: string };
    result: Record<string, never>;
  };
  "editor.open": {
    args: {
      workspaceId: string;
      filePath: string;
      line?: number;
      column?: number;
      view?: CliEditorView;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  "commit.open": {
    args: { workspaceId: string; rev: string; placement: CliPlacement };
    result: { tabId: string; sha: string; subject: string };
  };
  "tab.save": {
    args: { workspaceId: string; tabId: string };
    result: { filePath: string; saved: boolean };
  };
  "tab.revert": {
    args: { workspaceId: string; tabId: string };
    result: { filePath: string; reverted: boolean };
  };
  "diff.open": {
    args: {
      workspaceId: string;
      relPath: string;
      leftRef: string;
      rightRef: string;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  "terminal.open": {
    args: {
      workspaceId: string;
      cwd: string;
      title?: string;
      command?: string;
      shell?: string;
      profile?: string;
      openedBy?: TerminalOpener;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  "terminal.reopen": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  "terminal.shells": {
    args: Record<string, never>;
    result: { shells: CliShellInfo[] };
  };
  "terminal.shells.change": {
    args: { change: CliShellChange; approved?: true; before?: string };
    result: CliShellPlan;
  };
  "terminal.input": {
    args: { workspaceId: string; tabId: string; text: string; mode: CliInputMode; enter: boolean };
    result: Record<string, never>;
  };
  "tab.show": {
    args: { workspaceId: string; tabId: string; caller?: { workspaceId: string; tabId: string } };
    result: Record<string, never>;
  };
  "tab.close": {
    args: { workspaceId: string; tabId: string; force: boolean };
    result: Record<string, never>;
  };
  "tab.sandboxSession": {
    args: { workspaceId: string; tabId: string };
    result: string | null;
  };
  "browser.open": {
    args: { workspaceId: string; url: string; placement: CliPlacement };
    result: { tabId: string; url: string };
  };
  "browser.navigate": {
    args: { workspaceId: string; tabId: string; action: CliBrowserAction; url?: string };
    result: { url?: string };
  };
  "browser.permissions": {
    args: { workspaceId: string };
    result: {
      global: Record<string, boolean>;
      sites: { origin: string; permission: string; decision: "allow" | "block" }[];
    };
  };
  "browser.devtools": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  "layout.get": {
    args: { workspaceId: string };
    result: { root: CliLayoutNode; activeGroupId: string };
  };
  "layout.focus": {
    args: { workspaceId: string; groupId: string };
    result: Record<string, never>;
  };
  "layout.split": {
    args: { workspaceId: string; tabId: string; groupId: string; side: CliSplitSide };
    result: { groupId: string };
  };
  "layout.ratios": {
    args: { workspaceId: string; ratios: { splitId: string; ratio: number }[] };
    result: Record<string, never>;
  };
  "tab.move": {
    args: { workspaceId: string; tabId: string; groupId: string; index?: number };
    result: Record<string, never>;
  };
  "group.close": {
    args: { workspaceId: string; groupId: string; force: boolean };
    result: { closed: number };
  };
  "tab.rename": {
    args: { workspaceId: string; tabId: string; title: string };
    result: { title: string };
  };
  "tab.pin": {
    args: { workspaceId: string; tabId: string; pinned: boolean };
    result: Record<string, never>;
  };
  "panels.get": {
    args: { workspaceId: string };
    result: CliPanels;
  };
  "panels.set": {
    args: {
      workspaceId: string;
      panel: CliPanel;
      visible?: boolean;
      width?: number;
      mode?: CliFilesMode;
    };
    result: CliPanels;
  };
  "files.reveal": {
    args: { workspaceId: string; filePath: string };
    result: Record<string, never>;
  };
  "problems.list": {
    args: { workspaceId: string };
    result: { problems: CliProblem[] };
  };
  "agentView.get": {
    args: Record<string, never>;
    result: CliAgentView;
  };
  "agentView.show": {
    args: { view: CliView };
    result: Record<string, never>;
  };
  "agentView.place": {
    args: ({ workspaceId: string; tabId: string } | { key: string }) & {
      panelId?: string;
      side?: CliSplitSide;
      index?: number;
      show: boolean;
    };
    result: { panelId: string };
  };
  "agentView.openFile": {
    args: { workspaceId: string; filePath: string; panelId?: string };
    result: { key: string; tabId: string; panelId: string };
  };
  "agentView.remove": {
    args: { workspaceId: string; tabId: string } | { key: string };
    result: Record<string, never>;
  };
  "agentView.close": {
    args: { panelId: string };
    result: { removed: number };
  };
  "agentView.ratios": {
    args: { ratios: { splitId: string; ratio: number }[] };
    result: Record<string, never>;
  };
  "agentView.focus": {
    args: { panelId: string };
    result: Record<string, never>;
  };
  "agentView.group": {
    args: { grouping: CliAgentGrouping };
    result: Record<string, never>;
  };
  "agentView.reorderSessions": {
    args: { workspaceId: string; tabIds: string[] };
    result: { found: boolean };
  };
  "workspace.folders": {
    args: { workspaceId: string };
    result: { folders: string[] };
  };
  "workspace.show": {
    args: { workspaceId: string };
    result: Record<string, never>;
  };
  "task.create": {
    args: {
      parentId: string;
      name: string;
      prompt: string;
      start?: CliTaskStart;
      show: boolean;
      allowTerminal?: boolean;
      openedBy?: TerminalOpener;
      createdBy?: { workspaceId: string; tabId: string };
      from?: RelaySender;
    };
    result: { workspaceId: string; tabId?: string; start: CliTaskStart };
  };
  "chat.open": {
    args: {
      workspaceId: string;
      agent: ChatAgent;
      cwd: string;
      prompt: string;
      placement: CliPlacement;
      settings?: CliChatSettings;
      profile?: string;
      instructions?: string;
      openedBy?: TerminalOpener;
      from?: RelaySender;
      user?: boolean;
      allowDangerousMode?: boolean;
    };
    result: { tabId: string; error?: string };
  };
  "chat.instructions": {
    args: { workspaceId: string; tabId: string; text?: string };
    result: Required<RpcResult<"chat.instructions">>;
  };
  "chat.profiles": {
    args: { agent?: ChatAgent; workspaceId?: string };
    result: {
      profiles: {
        id: string;
        name: string;
        agent: ChatAgent;
        isDefault: boolean;
        workspaceDefault?: boolean;
        path?: string;
      }[];
    };
  };
  "chat.usage": {
    args: Omit<RpcParams<"profiles.usage">, "from">;
    result: RpcResult<"profiles.usage">;
  };
  "chat.interrupt": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  "chat.restart": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  "chat.checkSignIn": {
    args: { workspaceId: string; tabId: string };
    result: { signedOut: boolean };
  };
  "chat.sandbox": {
    args: { workspaceId: string; tabId: string };
    result:
      | { agent: "codex"; current?: string; next?: string; running?: boolean }
      | { agent: "claude"; enabled: boolean }
      | null;
  };
  "chat.mode": {
    args: { workspaceId: string; tabId: string };
    result: { agent: ChatAgent; mode?: string } | null;
  };
  "chat.outsideFiles": {
    args: { workspaceId: string };
    result: { files: string[] };
  };
  "chat.settings": {
    args: {
      workspaceId: string;
      tabId: string;
      settings: CliChatSettings;
      expectedMode?: string;
      user?: boolean;
      allowDangerousMode?: boolean;
    };
    result: CliChatChoices;
  };
  "chat.history": {
    args: {
      workspaceId: string;
      agent: ChatAgent;
      query?: string;
      limit?: number;
      peer?: boolean;
    };
    result: { sessions: CliPastSession[] };
  };
  "chat.resume": {
    args: {
      workspaceId: string;
      agent: ChatAgent;
      sessionId: string;
      tabId?: string;
      emptyOnly?: true;
      openedBy?: TerminalOpener;
    };
    result: { tabId: string };
  };
  "chat.commands": {
    args: { workspaceId: string; tabId: string };
    result: { commands: ChatCommand[] };
  };
  "chat.fileSuggestions": {
    args: { workspaceId: string; tabId: string; query: string };
    result: { paths: string[] };
  };
  "chat.command": {
    args: { workspaceId: string; tabId: string; name: string; args?: string };
    result: { message?: string; card?: boolean; tabId?: string };
  };
  "chat.profile": {
    args: {
      workspaceId: string;
      tabId: string;
      profile: string;
      fresh: boolean;
      dryRun?: boolean;
      stop?: boolean;
    };
    result: { from: string; to: string };
  };
  "chat.state": {
    args: {
      workspaceId: string;
      tabId: string;
      peek?: boolean;
      submissionId?: string;
      after?: number;
      includeWaitingId?: boolean;
    };
    result: CliChatInfo & { trackedSubmission?: boolean; waitingId?: string };
  };
  "chat.read": {
    args: {
      workspaceId: string;
      tabId: string;
      messages?: number;
      since?: number;
      subagents?: boolean;
    };
    result: CliChatInfo & { entries: CliChatEntry[]; end: number };
  };
  "chat.page": {
    args: { workspaceId: string; tabId: string; before?: number; limit?: number };
    result: ChatPage;
  };
  "chat.peek": {
    args: { workspaceId: string; tabId: string; turns?: number };
    result: ChatPeek;
  };
  "chat.runPage": {
    args: { workspaceId: string; tabId: string; runId: string; before?: number; limit?: number };
    result: ChatPage | null;
  };
  "chat.watch": {
    args: {
      workspaceId: string;
      tabId: string;
      watchId: string;
      limit?: number;
      appends?: boolean;
    };
    result: ChatPage & { panel?: ChatPanel };
  };
  "chat.rename": {
    args: { workspaceId: string; tabId: string; title: string };
    result: { title: string };
  };
  "chat.pageEntries": {
    args: { page: ChatPage; subagents?: boolean };
    result: { entries: CliChatEntry[] };
  };
  "chat.panel": {
    args: { workspaceId: string; tabId: string };
    result: ChatPanel;
  };
  "chat.stopTask": {
    args: { workspaceId: string; tabId: string; taskId: string };
    result: Record<string, never>;
  };
  "chat.rewindPreview": {
    args: { workspaceId: string; tabId: string; itemKey: string };
    result: {
      canRewind: boolean;
      error?: string;
      filesChanged: string[];
      insertions: number;
      deletions: number;
    };
  };
  "chat.rewind": {
    args: { workspaceId: string; tabId: string; itemKey: string; files: boolean };
    result: Record<string, never>;
  };
  "chat.fork": {
    args: { workspaceId: string; tabId: string; itemKey?: string; openedBy?: TerminalOpener };
    result: { tabId: string; draft?: string };
  };
  "chat.background": {
    args: { workspaceId: string; tabId: string; toolUseId: string };
    result: Record<string, never>;
  };
  "chat.mcp": {
    args: {
      workspaceId: string;
      tabId: string;
      server: string;
      action: "reconnect" | "enable" | "disable" | "signIn" | "signedIn";
      redirectUri?: string;
      callbackUrl?: string;
    };
    result: { authUrl?: string; back?: boolean };
  };
  "chat.config": {
    args: {
      workspaceId: string;
      tabId: string;
      set?: { changes: Record<string, boolean | string>; effort?: string };
    };
    result: { config?: ChatConfig };
  };
  "chat.remoteControl": {
    args: { workspaceId: string; tabId: string; enabled?: boolean };
    result: { enabled: boolean; url?: string };
  };
  "chat.unwatch": {
    args: { watchId: string };
    result: Record<string, never>;
  };
  "chat.image": {
    args: {
      workspaceId: string;
      tabId: string;
      runId?: string;
      ref:
        | { kind: "user"; itemKey: string; index: number }
        | { kind: "tool"; toolUseId: string; index: number }
        | { kind: "held"; id: string; index: number };
      maxChars: number;
      maxEdge?: number;
      versioned?: true;
      ifVersion?: string;
    };
    result: CliChatImage & { version?: string; notModified?: true };
  };
  "chat.toolCall": {
    args: {
      workspaceId: string;
      tabId: string;
      toolUseId: string;
      maxText: number;
      runId?: string;
    };
    result: ViewToolCall;
  };
  "chat.original": {
    args: { workspaceId: string; tabId: string; path: string };
    result: { found: boolean; before: string | null };
  };
  "chat.tool": {
    args: { workspaceId: string; tabId: string; ref: string; runId?: string };
    result: CliChatTool;
  };
  "events.read": {
    args: { since?: number; limit: number };
    result: { events: CliSessionEvent[]; cursor: number; more: boolean };
  };
  "sessions.results": {
    args: Record<string, never>;
    result: { unread: Record<string, Record<string, number>> };
  };
  "sessions.snapshot": {
    args: { workspaceIds: string[]; cursor?: CliSessionsSnapshotCursor };
    result: {
      revision: number;
      workspaces: { tabs?: CliSessionTab[] }[];
      unread?: Record<string, Record<string, number>>;
      next?: CliSessionsSnapshotCursor;
    };
  };
  "sessions.markSeen": {
    args: RpcParams<"sessions.markSeen">;
    result: RpcResult<"sessions.markSeen">;
  };
  "chat.send": {
    args: {
      workspaceId: string;
      tabId: string;
      text: string;
      from?: RelaySender;
      user?: boolean;
      images?: { mediaType: string; data: string }[];
      files?: { name: string; data: string }[];
      when?: "next" | "now" | "after";
      device?: string;
      submission?: { clientNonce: string; clientDeviceId: string };
      wait?: { receiptAt?: number };
    };
    result: { heldId?: string; itemKey?: string; rejected?: string; submissionId?: string };
  };
  "chat.unqueue": {
    args: { workspaceId: string; tabId: string; id: string };
    result: { text: string };
  };
  "chat.editHeld": {
    args: {
      workspaceId: string;
      tabId: string;
      id: string;
      text: string;
      device?: string;
      from?: RelaySender;
    };
    result: Record<string, never>;
  };
  "chat.dropHeld": {
    args: { agentsOnly?: boolean };
    result: { dropped: number };
  };
  "chat.withdraw": {
    args: { workspaceId: string; tabId: string; itemKey: string };
    result: { withdrawn: boolean };
  };
  "chat.hurry": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  "chat.export": {
    args: { workspaceId: string; tabId: string };
    result: { markdown: string };
  };
  "chat.entryItem": {
    args: { workspaceId: string; tabId: string; i: number };
    result: { itemKey: string; kind: string; text?: string };
  };
  "task.remove": {
    args: { taskId: string; force: boolean; deleteBranch: boolean | "merged" };
    result: Record<string, never>;
  };
  "note.show": {
    args: { workspaceId: string; noteId: string; title?: string };
    result: Record<string, never>;
  };
  "note.recorder": {
    args: {
      action: "status" | "start" | "pause" | "resume" | "stop";
      workspaceId?: string;
      noteId?: string;
      participants?: ParticipantCount;
    };
    result: CliRecorder;
  };
  "editor.newUntitled": {
    args: { workspaceId: string };
    result: { tabId: string };
  };
  "editor.encoding": {
    args: { workspaceId: string; tabId: string; reopen?: string; saveAs?: string };
    result: {
      encoding: string;
      dirty: boolean;
      readOnly: boolean;
      choices: { id: string; name: string }[];
    };
  };
  "workspace.dismissNotifications": {
    args: { workspaceId: string };
    result: Record<string, never>;
  };
  "settings.lspStatus": {
    args: { workspaceId: string };
    result: {
      enabled: boolean;
      maxActiveWorkspaces: number;
      servers: { language: string; state: string }[];
    };
  };
  "settings.updateStatus": {
    args: Record<string, never>;
    result: { status: UpdateStatus | null; progress: UpdateProgress | null };
  };
  "settings.updateCheck": {
    args: Record<string, never>;
    result: { status: UpdateStatus | null; progress: UpdateProgress | null };
  };
  "settings.logsPath": {
    args: Record<string, never>;
    result: { path: string };
  };
  "note.rename": {
    args: { workspaceId: string; noteId: string; title: string };
    result: { title: string };
  };
  "note.storage": {
    args: Record<string, never>;
    result: { entries: CliNoteStorageEntry[] };
  };
  "note.storage.remove": {
    args: { location: string; approved?: true; before?: string };
    result: { entry: CliNoteStorageEntry; snapshot: string; removed: boolean };
  };
  "note.speakers": {
    args: { workspaceId: string; noteId: string; recording?: string; change: CliSpeakerChange };
    result: { recordingId: string };
  };
  "note.voiceSuggestions": {
    args: {
      workspaceId: string;
      noteId: string;
      recording?: string;
      action: CliVoiceSuggestionAction;
    };
    result: { recordingId: string; suggestions: { speaker: string; name: string }[] };
  };
  "note.voiceNames": {
    args: { action: { op: "list" } | { op: "delete"; name?: string } };
    result: { names: string[] };
  };
  "settings.instructions": {
    args: { workspaceId: string; agent: ChatAgent; profileId?: string };
    result: RpcResult<"settings.instructions">;
  };
  "settings.keys": {
    args: Record<string, never>;
    result: { bindings: CliKeyBinding[] };
  };
  "browser.permissions.revoke": {
    args:
      | { scope: "global"; permission: string }
      | { scope: "site"; workspaceId: string; origin: string; permission: string };
    result: { revoked: string[] };
  };
  "settings.keys.set": {
    args: { change: CliKeyChange };
    result: { bindings: CliKeyBinding[]; warnings: string[] };
  };
  "settings.instructions.set": {
    args: { scope: InstructionScope; text: string };
    result: Record<string, never>;
  };
  "settings.list": {
    args: { key?: string };
    result: { settings: CliSettingInfo[] };
  };
  "settings.set": {
    args: { key: string; value: string | null; approved?: true; expected?: CliSettingValue };
    result: { setting: CliSettingInfo };
  };
  "settings.open": {
    args: { page?: SettingsPage };
    result: Record<string, never>;
  };
  "workspace.remove": {
    args: { workspaceId: string };
    result: Record<string, never>;
  };
  "chat.answer": {
    args: {
      workspaceId: string;
      tabId: string;
      decision: "allow" | "deny";
      message?: string;
      expect: string;
      byAgent?: true;
      updatedInput?: Record<string, unknown>;
      stop?: boolean;
      always?: number[];
      planMode?: "acceptEdits" | "default";
    };
    result: Record<string, never>;
  };
  "consent.ask": {
    args: {
      fromWorkspaceId: string;
      fromTabId: string;
      toWorkspaceId: string;
      change: CliChange;
      timeoutMs?: number;
      fromDevice?: string;
      fromDeviceId?: string;
      fromName?: string;
      id?: string;
    };
    result: { answer: CliConsentAnswer };
  };
  "consent.settle": {
    args: { id: string; answer: "once" | "session" | "deny"; by?: string };
    result: { settled: boolean };
  };
}

export type CliUiOp = keyof CliUiOps;

export const CliUiRequestSchema = z.object({
  requestId: z.string().min(1),
  op: z.string().min(1),
  args: z.unknown().optional(),
});
export type CliUiRequest = z.infer<typeof CliUiRequestSchema>;

export const CliUiRespondArgsSchema = z.object({
  requestId: z.string().min(1),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export type CliUiRespondArgs = z.infer<typeof CliUiRespondArgsSchema>;
