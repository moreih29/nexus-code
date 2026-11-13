/**
 * What the nexus CLI asks of the renderer, which owns the tabs, the layout
 * and the terminals' screens. Main sends "cli.uiRequest" to the active
 * window and the renderer answers with "cli.uiRespond".
 */
import { z } from "zod";
import type { ChatPage } from "../../../packages/remote-protocol/src/rpc";
import type { RelaySender } from "../chat/relay";
import type { ChatAgent } from "../sessions/task-agent";
import type { SettingsPage } from "./settings";

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
  /** Pinned to the front of its group. */
  readonly pinned?: boolean;
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

/** What the window shows: the agent view, or the workspaces. */
export type CliView = "agents" | "workspaces";

/** A session the agent view holds: a Claude or Codex tab, or a terminal. */
export interface CliViewAgent {
  /** "<workspace id>:<tab id>", as the agent view's panels list it. */
  readonly key: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly type: string;
}

/**
 * The agent view: whether the window shows it, and its panels, split as a
 * workspace's editor area is; a panel's tabIds are the keys of the
 * sessions it holds.
 */
/** How the agent view's list groups its agents: by their state, or by their workspace. */
export type CliAgentGrouping = "status" | "workspace";

export interface CliAgentView {
  readonly view: CliView;
  readonly grouping: CliAgentGrouping;
  readonly root: CliLayoutNode;
  readonly activePanelId: string;
  readonly agents: readonly CliViewAgent[];
}

/** The columns left of the editor area: the workspace list, and the files panel. */
export type CliPanel = "sidebar" | "files";

/** What the files panel shows: the file tree, search, git, or the agent list. */
export type CliFilesMode = "tree" | "search" | "git" | "agents";

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
  | "chatInterrupt"
  | "chatSettings"
  | "chatMode"
  | "chatProfile"
  | "chatProfileNew"
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
  | "permissionAllow"
  | "permissionDeny";

export interface CliChange {
  readonly kind: CliChangeKind;
  /** The file, tab title or URL it is about, if any. */
  readonly detail?: string;
  /** What it lets happen, whole and shown as it is: the command a permission answer lets run. */
  readonly body?: string;
}

/** What a Claude or Codex tab runs with: those given of its model, effort and permission mode. */
export interface CliChatSettings {
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
}

/** What a Claude or Codex tab runs with, and what it may be set to. */
export interface CliChatChoices {
  readonly agent: ChatAgent;
  /** The model it runs, as its list names it; null before it says. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly mode: string;
  /** The models it offers: the name to give, and the one shown. */
  readonly models: readonly { readonly value: string; readonly name: string }[];
  /** The effort levels its model takes; none when it takes none. */
  readonly efforts: readonly string[];
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
  /** When its turn began while working; else when it last said or did something. */
  readonly since?: number;
  /** When asking to run a tool: the request, whole. */
  readonly request?: CliChatRequest;
  /** The agent profile it runs with, by name, where the agent has more than the default. */
  readonly profile?: string;
  /** The goal it works toward (/goal), while it shows one. */
  readonly goal?: CliChatGoal;
}

/** A tab's goal (/goal) as the CLI tells it. */
export interface CliChatGoal {
  readonly objective: string;
  /** active, paused, blocked, usageLimited, budgetLimited, met or failed. */
  readonly status: string;
  /** What the last check said of it, once it ended. */
  readonly reason?: string;
}

/** A tool's permission request a tab waits on. */
export interface CliChatRequest {
  /** Its id: an answer goes to this request and no other. */
  readonly id: string;
  readonly tool: string;
  /** What it would run or work on, in full: the command, or the tool's input as JSON. */
  readonly input: string;
}

/** One message of a conversation as chat read prints it. */
export interface CliChatEntry {
  /**
   * Its place in the whole conversation, from 0, subagents' tool calls
   * counted: a later read can start after it, and chat tool names a call by it.
   */
  readonly i: number;
  /** Who said it: the user, the agent, a tool the agent ran, or the app. */
  readonly role: "user" | "agent" | "tool" | "notice";
  readonly text: string;
  /** A tool call's id. */
  readonly toolUseId?: string;
  /** A tool call's: streaming, running, done, error, denied or stopped. */
  readonly status?: string;
  /** A subagent's tool call: the id of the Agent call it runs under. */
  readonly parentToolUseId?: string;
  /** A message another agent sent through the nexus command: who did. */
  readonly from?: RelaySender;
}

/** A tool call whole, as chat tool prints it: what it was given and what came back. */
export interface CliChatTool {
  readonly i: number;
  readonly toolUseId: string;
  readonly name: string;
  readonly status: string;
  readonly input: unknown;
  readonly result?: { readonly text: string; readonly isError: boolean };
  readonly parentToolUseId?: string;
}

/**
 * A session's state changing, as nexus events tells it: a terminal's agent,
 * or a Claude or Codex tab. `from` is null for a session that just appeared;
 * `to` is "closed" for one whose tab went.
 */
export interface CliSessionEvent {
  /** Counts up from 1 while the app runs; nexus events --since takes it. */
  readonly seq: number;
  readonly at: number;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  /** The tab: a terminal, or a Claude or Codex tab. */
  readonly kind: "terminal" | "claude" | "codex";
  readonly agent?: string;
  readonly from: string | null;
  readonly to: string;
  /** attention (waits on the user), running, done (a finished turn) or idle; closed. */
  readonly phase: string;
  /** Its last answer or question, or what went wrong. */
  readonly message?: string;
  /**
   * A Claude or Codex tab's goal (/goal), when it was set or its status
   * changed: `from` is its status before, null for a goal just set. Such a
   * change alone leaves `from` and `to` the same.
   */
  readonly goal?: CliSessionGoal;
}

/** A goal's change, as nexus events tells it. */
export interface CliSessionGoal {
  readonly objective: string;
  readonly from: string | null;
  readonly status: string;
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
  /**
   * Shows a tab, and its workspace if another one is shown. While the agent
   * view is shown, a session shows there instead, beside `caller` when a
   * panel shows it.
   */
  "tab.show": {
    args: { workspaceId: string; tabId: string; caller?: { workspaceId: string; tabId: string } };
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
  /** The window's view, and the agent view's panels and the sessions they hold. */
  "agentView.get": {
    args: Record<string, never>;
    result: CliAgentView;
  };
  /** Shows the agent view or the workspaces, as the title bar's toggle does. */
  "agentView.show": {
    args: { view: CliView };
    result: Record<string, never>;
  };
  /**
   * Puts a session in the agent view: with `side`, into a new panel on that
   * side of `panelId`; with `panelId`, into that panel (at `index` of its
   * tabs); else in front of the panel holding it, or of the active one.
   * With `show`, the window shows the agent view and that panel becomes
   * the active one; otherwise the active panel stays.
   */
  "agentView.place": {
    args: {
      workspaceId: string;
      tabId: string;
      panelId?: string;
      side?: CliSplitSide;
      index?: number;
      show: boolean;
    };
    result: { panelId: string };
  };
  /** Takes a session out of the agent view; its tab goes on in its workspace. */
  "agentView.remove": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  /** Closes a panel, taking its sessions out of the view; the only one is emptied. */
  "agentView.close": {
    args: { panelId: string };
    result: { removed: number };
  };
  /** Sets the share of the first part of the agent view's splits, by split id. */
  "agentView.ratios": {
    args: { ratios: { splitId: string; ratio: number }[] };
    result: Record<string, never>;
  };
  /** Makes a panel the active one, the keyboard in it while the view is shown. */
  "agentView.focus": {
    args: { panelId: string };
    result: Record<string, never>;
  };
  /** Groups the agent view's list by the agents' state or by their workspace, as its switch does. */
  "agentView.group": {
    args: { grouping: CliAgentGrouping };
    result: Record<string, never>;
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
      /** The agent that sends the prompt, as the task's tab shows it; none for the user. */
      from?: RelaySender;
    };
    /** `start` is what its tab runs: an agent, or a command ("" for a plain shell). */
    result: { workspaceId: string; tabId: string; start: CliTaskStart };
  };
  /**
   * Opens a Claude or Codex tab in `cwd` and sends it `prompt` when there is
   * one. With `settings`, its program starts and is set to them first; when
   * that fails, `error` says why and nothing is sent.
   */
  "chat.open": {
    args: {
      workspaceId: string;
      agent: ChatAgent;
      cwd: string;
      prompt: string;
      placement: CliPlacement;
      settings?: CliChatSettings;
      /** The agent profile to run with, by name or id; absent = the workspace's. */
      profile?: string;
      /** The agent that sends the prompt, as the tab shows it; none for the user. */
      from?: RelaySender;
    };
    result: { tabId: string; error?: string };
  };
  /** Stops the turn a Claude or Codex tab is working on, as its stop button does. */
  "chat.interrupt": {
    args: { workspaceId: string; tabId: string };
    result: Record<string, never>;
  };
  /**
   * Sets a Claude or Codex tab's model, effort and permission mode, as its
   * composer's chips do, those given only; tells what it runs with then and
   * what it takes. Its program is started if it was not.
   */
  "chat.settings": {
    args: { workspaceId: string; tabId: string; settings: CliChatSettings };
    result: CliChatChoices;
  };
  /**
   * Has a Claude or Codex tab run with another agent profile (by name or id),
   * as its profile chip does: its conversation goes on in that profile, or,
   * `fresh`, a new one starts there. `dryRun` only checks that it can.
   * Refused while it works or asks the user.
   */
  "chat.profile": {
    args: {
      workspaceId: string;
      tabId: string;
      profile: string;
      fresh: boolean;
      dryRun?: boolean;
    };
    /** The profiles by name: the one it ran with, the one it runs with now. */
    result: { from: string; to: string };
  };
  /**
   * Where a Claude or Codex tab's conversation stands; its program is opened
   * if it was not, unless `peek`, which tells such a tab idle.
   */
  "chat.state": {
    args: { workspaceId: string; tabId: string; peek?: boolean };
    result: CliChatInfo;
  };
  /**
   * A Claude or Codex tab's messages, and where it stands: those after
   * `since` (an entry's i), the last `messages` of them; all when neither.
   * Subagents' tool calls only with `subagents`. A conversation that now
   * ends before `since`, cleared or rewound since, is read from its start.
   */
  "chat.read": {
    args: {
      workspaceId: string;
      tabId: string;
      messages?: number;
      since?: number;
      subagents?: boolean;
    };
    /** `end`: the i of the conversation's last entry, -1 when it has none. */
    result: CliChatInfo & { entries: CliChatEntry[]; end: number };
  };
  /**
   * A Claude or Codex tab's conversation as another device of the account
   * draws it (the remote's chat.read): the last `limit` items, or those
   * before `before`, with the tool calls they name and where it stands.
   */
  "chat.page": {
    args: { workspaceId: string; tabId: string; before?: number; limit?: number };
    result: ChatPage;
  };
  /**
   * Starts telling main what changes in a Claude or Codex tab's
   * conversation, for another device watching it (the remote's chat.watch):
   * its page now, then remote.chatChanged with `watchId` as it changes.
   */
  "chat.watch": {
    args: { workspaceId: string; tabId: string; watchId: string; limit?: number };
    result: ChatPage;
  };
  /** Stops a watch chat.watch started; nothing when there is none. */
  "chat.unwatch": {
    args: { watchId: string };
    result: Record<string, never>;
  };
  /** A tool call of a Claude or Codex tab whole, named by its entry's i or its id. */
  "chat.tool": {
    args: { workspaceId: string; tabId: string; ref: string };
    result: CliChatTool;
  };
  /**
   * The sessions' state changes after `since`, the first `limit` of them
   * (`more` when some were left out); with no `since`, the last `limit`.
   * `cursor`: the seq of the latest one there is.
   */
  "events.read": {
    args: { since?: number; limit: number };
    result: { events: CliSessionEvent[]; cursor: number; more: boolean };
  };
  /**
   * Sends a Claude or Codex tab a message, as its composer does: during a
   * turn, the agent reads it after the tool it runs.
   */
  "chat.send": {
    /**
     * `from`: the agent that sends it, as the tab shows it; none for the user.
     * `user`: the user sends it (from another computer of theirs), so it goes
     * even while the tab asks them something, as its composer's would.
     */
    args: {
      workspaceId: string;
      tabId: string;
      text: string;
      from?: RelaySender;
      user?: boolean;
    };
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
  /** Opens the Settings dialog for the user: at `page`, or where it was left. */
  "settings.open": {
    args: { page?: SettingsPage };
    result: Record<string, never>;
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
   * Answers the permission request a Claude or Codex tab waits on, if it
   * still asks what `expect` says (chat.state's message): a tool's, not a
   * question or a plan, which only the user answers.
   */
  "chat.answer": {
    args: {
      workspaceId: string;
      tabId: string;
      decision: "allow" | "deny";
      /** With deny: what to tell the agent. */
      message?: string;
      /** The request's id (CliChatRequest): main allowed an answer to it, not to another. */
      expect: string;
      /** With allow: the input the tool runs with, as the user filled it (a question's answers). */
      updatedInput?: Record<string, unknown>;
      /** With deny: stop the turn too. */
      stop?: boolean;
    };
    result: Record<string, never>;
  };
  /**
   * The agent manager handed work to a session, sending it `text` when it
   * did: the session is its task from now (services/manager).
   */
  "manager.dispatched": {
    args: { workspaceId: string; tabId: string; text?: string };
    result: Record<string, never>;
  };
  /** Opens or shuts the agent manager's dock; tells whether the manager is on. */
  "manager.dock": {
    args: { open: boolean };
    result: { enabled: boolean };
  };
  /**
   * Starts the agent manager over, as its dock's New conversation does: the
   * old conversation is left to resume. Refused while the manager is off.
   */
  "manager.new": {
    args: Record<string, never>;
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
