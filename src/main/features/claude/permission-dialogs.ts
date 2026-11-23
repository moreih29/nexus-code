import type { ClaudeStatus } from "../../../shared/claude/status";

export const MAIN_AGENT = "";

interface Dialog {
  readonly agent: string;
  readonly call: string | undefined;
}

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

  open(key: string, agent: string, call: string | undefined, under: StateUnder): void {
    const tab = this.tabs.get(key);
    if (!tab || tab.open.length === 0) {
      this.tabs.set(key, { open: [{ agent, call }], under });
      return;
    }
    tab.open = tab.open.filter((d) => d.agent !== MAIN_AGENT || d.call !== undefined);
    tab.open.push({ agent, call });
  }

  isOpen(key: string): boolean {
    return (this.tabs.get(key)?.open.length ?? 0) > 0;
  }

  isOpenFor(key: string, agent: string, call: string | undefined): boolean {
    return this.tabs.get(key)?.open.some((d) => d.agent === agent && d.call === call) ?? false;
  }

  setUnder(key: string, under: StateUnder): void {
    const tab = this.tabs.get(key);
    if (tab) tab.under = under;
  }

  closeCall(key: string, agent: string, call: string | undefined): boolean {
    return this.close(key, (d) => d.agent === agent && (d.call === undefined || d.call === call));
  }

  closeOthers(key: string, agent: string, call: string | undefined): boolean {
    return this.close(key, (d) => d.agent === agent && (d.call === undefined || d.call !== call));
  }

  closeAgent(key: string, agent: string): boolean {
    return this.close(key, (d) => d.agent === agent);
  }

  closeAll(key: string): boolean {
    return this.close(key, () => true);
  }

  takeUnder(key: string): StateUnder | undefined {
    const tab = this.tabs.get(key);
    if (!tab || tab.open.length > 0) return undefined;
    this.tabs.delete(key);
    return tab.under;
  }

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
