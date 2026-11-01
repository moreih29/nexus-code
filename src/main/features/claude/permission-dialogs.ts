// The permission dialogs open in each Claude session, and whose they are.
//
// Claude Code asks for a tool call of the session's own turn or of one of its
// subagents, and a background agent's dialog can open after the session's
// turn ended (seen with Claude Code 2.1.316: the turn's Stop, then the
// agent's PermissionRequest). While a dialog is open the session waits on the
// user, whatever else its hooks say: a tool another agent starts, or the end
// of the turn, does not close it. Only the agent it is for moves past it: the
// tool ran (allowed), the agent went on to another tool or ended (denied).

import type { ClaudeStatus } from "../../../shared/claude/status";

/** The session's own turn, as against a subagent's id. */
export const MAIN_AGENT = "";

interface Dialog {
  /** The subagent the call is for, or MAIN_AGENT. */
  readonly agent: string;
  /** The tool call, as toolCall gives it; undefined when not told. */
  readonly call: string | undefined;
}

/** The state the session shows once its dialogs close. */
export interface StateUnder {
  readonly status: ClaudeStatus;
  readonly message?: string;
}

interface TabDialogs {
  open: Dialog[];
  under: StateUnder;
}

export class PermissionDialogs {
  private readonly tabs = new Map<string, TabDialogs>();

  /**
   * A dialog opened for `agent`'s call. `under` is the state the session was
   * in, for the first dialog to open.
   */
  open(key: string, agent: string, call: string | undefined, under: StateUnder): void {
    const tab = this.tabs.get(key);
    if (!tab || tab.open.length === 0) {
      this.tabs.set(key, { open: [{ agent, call }], under });
      return;
    }
    // A dialog told only by its notification is this one.
    tab.open = tab.open.filter((d) => d.agent !== MAIN_AGENT || d.call !== undefined);
    tab.open.push({ agent, call });
  }

  isOpen(key: string): boolean {
    return (this.tabs.get(key)?.open.length ?? 0) > 0;
  }

  /** The session's state moved on under the dialogs, to show once they close. */
  setUnder(key: string, under: StateUnder): void {
    const tab = this.tabs.get(key);
    if (tab) tab.under = under;
  }

  /**
   * `agent`'s call ran, or failed as it ran: its dialog, if it had one, was
   * allowed. A dialog whose call is not known is taken to be it.
   */
  closeCall(key: string, agent: string, call: string | undefined): boolean {
    return this.close(key, (d) => d.agent === agent && (d.call === undefined || d.call === call));
  }

  /** `agent` started `call`: its dialogs for other calls were answered. */
  closeOthers(key: string, agent: string, call: string | undefined): boolean {
    return this.close(key, (d) => d.agent === agent && (d.call === undefined || d.call !== call));
  }

  /** `agent` ended, or the session's turn did: none of its dialogs is open. */
  closeAgent(key: string, agent: string): boolean {
    return this.close(key, (d) => d.agent === agent);
  }

  /**
   * The state to show now that the last dialog closed, once: undefined while
   * one is still open, or when none was.
   */
  takeUnder(key: string): StateUnder | undefined {
    const tab = this.tabs.get(key);
    if (!tab || tab.open.length > 0) return undefined;
    this.tabs.delete(key);
    return tab.under;
  }

  /** The session ended or started again, or no longer shows a dialog. */
  clear(key: string): void {
    this.tabs.delete(key);
  }

  private close(key: string, closes: (dialog: Dialog) => boolean): boolean {
    const tab = this.tabs.get(key);
    if (!tab) return false;
    const before = tab.open.length;
    tab.open = tab.open.filter((d) => !closes(d));
    return tab.open.length < before;
  }
}
