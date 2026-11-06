/**
 * What the nexus CLI asks of the renderer, which owns the tabs, the layout
 * and the terminals' screens. Main sends "cli.uiRequest" to the active
 * window and the renderer answers with "cli.uiRespond".
 */
import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";

/** One tab as the CLI lists it. */
/** A shell a terminal can run. */
export interface CliShellInfo {
  name: string;
  /** "detected" for one found on this machine, "custom" for one added in the settings. */
  kind: "detected" | "custom";
  id: string;
  path: string;
  /** What a new terminal runs when no shell is named. */
  isDefault: boolean;
}

export interface CliTabInfo {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** The group (editor split) the tab is in. */
  readonly groupId: string;
  /** Whether it is the tab its group shows. */
  readonly shown: boolean;
  /** A terminal's starting directory. */
  readonly cwd?: string;
  /** An editor's file. */
  readonly filePath?: string;
  /** A browser tab's page. */
  readonly url?: string;
  /** A terminal whose process has ended. */
  readonly dead?: boolean;
  /** An editor, diff or untitled buffer with changes not saved. */
  readonly unsaved?: boolean;
}

/** Where a tab the CLI opens goes. */
export interface CliPlacement {
  /** Open it behind the tab its group shows instead of showing it. */
  readonly background: boolean;
  /**
   * The terminal the command ran in. A tab that is shown goes in another
   * group than this one's, so the terminal stays in view.
   */
  readonly besideTabId?: string;
}

/** How `terminal.input` types its text: as one paste, or as keystrokes. */
export type CliInputMode = "paste" | "keys";

/** What `browser.navigate` does. */
export type CliBrowserAction = "goto" | "back" | "forward" | "reload";

/**
 * A workspace's editor area: groups of tabs, split in two again and again.
 * A split's `ratio` is its first part's share, from 0 to 1.
 */
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
      /** Side by side, or one above the other. */
      readonly direction: "columns" | "rows";
      readonly ratio: number;
      readonly first: CliLayoutNode;
      readonly second: CliLayoutNode;
    };

/** Which side of a group a split puts the new group on. */
export type CliSplitSide = "left" | "right" | "up" | "down";

/** The columns left of the editor area: the workspace list, and the files panel. */
export type CliPanel = "sidebar" | "files";

/** What the files panel shows. */
export type CliFilesMode = "tree" | "search" | "git";

export interface CliPanels {
  readonly sidebar: { readonly visible: boolean; readonly width: number };
  readonly files: {
    readonly visible: boolean;
    readonly width: number;
    readonly mode: CliFilesMode;
  };
}

/** A problem a language server reports in a file open in the editor. */
export interface CliProblem {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "info" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
}

/** An app setting as nexus settings shows it; see ./settings. */
export interface CliSettingInfo {
  /** Its name, as "editor.fontSize". */
  readonly key: string;
  readonly summary: string;
  readonly type: CliSettingType;
  /** What a "choice" takes. */
  readonly choices?: readonly string[];
  /** The range of an "integer" or a "number". */
  readonly min?: number;
  readonly max?: number;
  /** What it is now: its default when it was never changed. */
  readonly value: CliSettingValue;
  /** Whether it was changed from its default. */
  readonly changed: boolean;
  /** One only the user changes, in Settings. */
  readonly readOnly?: boolean;
}

export type CliSettingType = "boolean" | "integer" | "number" | "choice" | "text";
export type CliSettingValue = string | number | boolean;

/** What nexus asks the user's leave for, in a workspace other than its terminal's own. */
export type CliChangeKind =
  | "open"
  | "diff"
  | "commit"
  | "terminalNew"
  | "terminalInput"
  | "chatNew"
  | "chatInput"
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
  | "workspaceRemove";

export interface CliChange {
  readonly kind: CliChangeKind;
  /** The file, tab title or URL it is about, if any. */
  readonly detail?: string;
}

/** The user's answer: allowed this once, until the app restarts, refused, or no answer in time. */
export type CliConsentAnswer = "once" | "session" | "deny" | "timeout";

/**
 * Where a Claude or Codex tab's conversation stands: working on a turn (or a
 * message sent it has yet to take), asking the user (a permission or a
 * question), idle between turns, or stopped on an error.
 */
export type CliChatState = "working" | "asking" | "idle" | "error";

/** A Claude or Codex tab as the CLI tells it. */
export interface CliChatInfo {
  readonly agent: ChatAgent;
  readonly state: CliChatState;
  /** Its last answer; when asking, what it asks; on an error, what went wrong. */
  readonly message?: string;
}

/** One message of a conversation as chat read prints it. */
export interface CliChatEntry {
  /** Who said it: the user, the agent, a tool the agent ran, or the app. */
  readonly role: "user" | "agent" | "tool" | "notice";
  readonly text: string;
}

/** What a new task starts with: an agent's tab, or a terminal running a command ("" for none). */
export type CliTaskStart = { readonly agent: ChatAgent } | { readonly command: string };

/** The operations, with what each takes and gives. */
export interface CliUiOps {
  /** The tabs of a workspace, in layout order. */
  "tabs.list": {
    args: { workspaceId: string };
    result: { tabs: CliTabInfo[] };
  };
  /** The text of a terminal: its last `lines` lines, scrollback included. */
  "terminal.read": {
    args: { workspaceId: string; tabId: string; lines: number };
    result: { text: string };
  };
  /** Opens a file of the workspace, or shows its tab, at a line if given. */
  "editor.open": {
    args: {
      workspaceId: string;
      filePath: string;
      line?: number;
      column?: number;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  /**
   * Opens the tab of the commit `rev` names (a sha or a prefix of one, a
   * branch, a tag, HEAD~2), showing its message and the files it changed.
   */
  "commit.open": {
    args: { workspaceId: string; rev: string; placement: CliPlacement };
    result: { tabId: string; sha: string; subject: string };
  };
  /** Saves the file of an editor or diff tab; `saved` is false when it had no changes. */
  "tab.save": {
    args: { workspaceId: string; tabId: string };
    result: { filePath: string; saved: boolean };
  };
  /** Drops an editor or diff tab's unsaved changes for what is on disk. */
  "tab.revert": {
    args: { workspaceId: string; tabId: string };
    result: { filePath: string; reverted: boolean };
  };
  /** Opens a file's changes between two refs (HEAD, INDEX, WORKING or a commit). */
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
  /** Opens a terminal, renamed to `title` and typing `command` once its shell starts. */
  "terminal.open": {
    args: {
      workspaceId: string;
      cwd: string;
      title?: string;
      command?: string;
      /** A shell of this machine's, by its name, id or program (see "terminal.shells"). */
      shell?: string;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  /** The shells a terminal of a local workspace can run, as "New terminal with" lists them. */
  "terminal.shells": {
    args: Record<string, never>;
    result: { shells: CliShellInfo[] };
  };
  /**
   * Types into a terminal: pasted, as the app's paste does, or as keys; then
   * Enter if asked.
   */
  "terminal.input": {
    args: { workspaceId: string; tabId: string; text: string; mode: CliInputMode; enter: boolean };
    result: Record<string, never>;
  };
  /** Shows a tab, and its workspace if another one is shown. */
  "tab.show": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  /**
   * Closes a tab. Refuses one with unsaved changes, and a terminal running a
   * program unless `force`.
   */
  "tab.close": {
    args: { workspaceId: string; tabId: string; force: boolean };
    result: Record<string, never>;
  };
  /** Opens a browser tab on a URL or an address such as localhost:3000. */
  "browser.open": {
    args: { workspaceId: string; url: string; placement: CliPlacement };
    result: { tabId: string; url: string };
  };
  /** Moves a browser tab: to a URL, back, forward, or reloads it. */
  "browser.navigate": {
    args: { workspaceId: string; tabId: string; action: CliBrowserAction; url?: string };
    /** Where "goto" went. */
    result: { url?: string };
  };
  /** A workspace's editor area and its active group. */
  "layout.get": {
    args: { workspaceId: string };
    result: { root: CliLayoutNode; activeGroupId: string };
  };
  /** Moves a tab into a new group on a side of `groupId`, its own group or another. */
  "layout.split": {
    args: { workspaceId: string; tabId: string; groupId: string; side: CliSplitSide };
    result: { groupId: string };
  };
  /** Sets the share of the first part of splits, by split id. */
  "layout.ratios": {
    args: { workspaceId: string; ratios: { splitId: string; ratio: number }[] };
    result: Record<string, never>;
  };
  /** Moves a tab into another group, or within its own, before the tab at `index`. */
  "tab.move": {
    args: { workspaceId: string; tabId: string; groupId: string; index?: number };
    result: Record<string, never>;
  };
  /**
   * Closes a group and its tabs. Refuses one holding unsaved changes, and a
   * terminal running a program unless `force`.
   */
  "group.close": {
    args: { workspaceId: string; groupId: string; force: boolean };
    result: { closed: number };
  };
  /** Names a tab; "" gives it back the name the app chooses. */
  "tab.rename": {
    args: { workspaceId: string; tabId: string; title: string };
    result: { title: string };
  };
  "tab.pin": {
    args: { workspaceId: string; tabId: string; pinned: boolean };
    result: Record<string, never>;
  };
  /** The panels beside the editor area, and the files panel's mode in a workspace. */
  "panels.get": {
    args: { workspaceId: string };
    result: CliPanels;
  };
  /** Shows, hides or resizes a panel, or sets the files panel's mode in a workspace. */
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
  /** Shows a file or folder in the files panel's tree, unfolding the folders above it. */
  "files.reveal": {
    args: { workspaceId: string; filePath: string };
    result: Record<string, never>;
  };
  /** The problems language servers report in a workspace's files open in the editor. */
  "problems.list": {
    args: { workspaceId: string };
    result: { problems: CliProblem[] };
  };
  /** Shows a workspace, as clicking it in the sidebar does. */
  "workspace.show": {
    args: { workspaceId: string };
    result: Record<string, never>;
  };
  /**
   * Makes a task of `parentId`, as New Task does: its worktree, branch and
   * one tab, `start` (the task agent when absent): an agent's tab sent
   * `prompt`, or a terminal running the command with `prompt`. Shown if
   * `show`, else started behind the user's view.
   */
  "task.create": {
    args: {
      parentId: string;
      name: string;
      prompt: string;
      start?: CliTaskStart;
      show: boolean;
      /** The terminal whose agent asks for the task. */
      createdBy: { workspaceId: string; tabId: string };
    };
    /** `start` is what its tab runs: an agent, or a command ("" for a plain shell). */
    result: { workspaceId: string; tabId: string; start: CliTaskStart };
  };
  /** Opens a Claude or Codex tab in `cwd` and sends it `prompt` when there is one. */
  "chat.open": {
    args: {
      workspaceId: string;
      agent: ChatAgent;
      cwd: string;
      prompt: string;
      placement: CliPlacement;
    };
    result: { tabId: string };
  };
  /**
   * Where a Claude or Codex tab's conversation stands; its program is opened
   * if it was not, unless `peek`, which tells such a tab idle.
   */
  "chat.state": {
    args: { workspaceId: string; tabId: string; peek?: boolean };
    result: CliChatInfo;
  };
  /** A Claude or Codex tab's last `messages` messages, and where it stands. */
  "chat.read": {
    args: { workspaceId: string; tabId: string; messages: number };
    result: CliChatInfo & { entries: CliChatEntry[] };
  };
  /**
   * Sends a Claude or Codex tab a message, as its composer does: during a
   * turn, the agent reads it after the tool it runs.
   */
  "chat.send": {
    args: { workspaceId: string; tabId: string; text: string };
    result: Record<string, never>;
  };
  /**
   * Removes a task, as Delete Task does. Refuses one with unsaved files, and
   * a worktree with changes unless `force`. A `deleteBranch` of "merged"
   * deletes the branch only if git finds it merged.
   */
  "task.remove": {
    args: { taskId: string; force: boolean; deleteBranch: boolean | "merged" };
    result: Record<string, never>;
  };
  /** The app's settings that nexus settings reads and changes. */
  "settings.list": {
    args: Record<string, never>;
    result: { settings: CliSettingInfo[] };
  };
  /**
   * Changes a setting, as Settings does, to `value` as typed (as "14" or
   * "on"), or back to its default when null.
   */
  "settings.set": {
    args: { key: string; value: string | null };
    result: { setting: CliSettingInfo };
  };
  /**
   * Removes a workspace from the app with its tasks, as Remove Workspace
   * does; their folders stay. Refuses one with unsaved files.
   */
  "workspace.remove": {
    args: { workspaceId: string };
    result: Record<string, never>;
  };
  /**
   * Asks the user whether a terminal of one workspace may make a change in
   * another. Unanswered after `timeoutMs`, the answer is "timeout".
   */
  "consent.ask": {
    args: {
      fromWorkspaceId: string;
      fromTabId: string;
      toWorkspaceId: string;
      change: CliChange;
      timeoutMs: number;
    };
    result: { answer: CliConsentAnswer };
  };
}

export type CliUiOp = keyof CliUiOps;

export const CliUiRequestSchema = z.object({
  requestId: z.string().min(1),
  op: z.string().min(1),
  args: z.unknown(),
});
export type CliUiRequest = z.infer<typeof CliUiRequestSchema>;

export const CliUiRespondArgsSchema = z.object({
  requestId: z.string().min(1),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export type CliUiRespondArgs = z.infer<typeof CliUiRespondArgsSchema>;
