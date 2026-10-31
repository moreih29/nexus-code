/**
 * What the nexus CLI asks of the renderer, which owns the tabs, the layout
 * and the terminals' screens. Main sends "cli.uiRequest" to the active
 * window and the renderer answers with "cli.uiRespond".
 */
import { z } from "zod";

/** One tab as the CLI lists it. */
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

/** What nexus asks the user's leave for, in a workspace other than its terminal's own. */
export type CliChangeKind =
  | "open"
  | "diff"
  | "terminalNew"
  | "terminalInput"
  | "tabClose"
  | "browserOpen"
  | "browserNavigate"
  | "browserControl";

export interface CliChange {
  readonly kind: CliChangeKind;
  /** The file, tab title or URL it is about, if any. */
  readonly detail?: string;
}

/** The user's answer: allowed this once, until the app restarts, refused, or no answer in time. */
export type CliConsentAnswer = "once" | "session" | "deny" | "timeout";

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
      placement: CliPlacement;
    };
    result: { tabId: string };
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
  /** Shows a workspace, as clicking it in the sidebar does. */
  "workspace.show": {
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
