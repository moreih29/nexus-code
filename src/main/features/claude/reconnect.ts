import { isLoginShell } from "../../../shared/pty/login-shell";
import { isClaudeIdleTitle } from "./idle-title";
import type { ClaudeStatusBroker } from "./status";

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

const MAX_CARRY = 1024;

interface Restoring {
  readonly entry: NonNullable<ReturnType<ClaudeStatusBroker["get"]>>;
  checking?: boolean;
  title: string | undefined;
  carry: string;
}

export class ClaudeReconnectCheck {
  private readonly restoring = new Map<string, Restoring>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set" | "clear">,
    private readonly foregroundProcess: (
      workspaceId: string,
      tabId: string,
    ) => Promise<string | null>,
  ) {}

  noteRestored(workspaceId: string, tabId: string, withReplay: boolean): void {
    const key = `${workspaceId}:${tabId}`;
    const entry = this.broker.get(workspaceId, tabId);
    if (!withReplay || entry === null) {
      this.restoring.delete(key);
      return;
    }
    this.restoring.set(key, {
      entry,
      title: undefined,
      carry: "",
    });
  }

  noteReplay(workspaceId: string, tabId: string, chunk: string): void {
    const restoring = this.restoring.get(`${workspaceId}:${tabId}`);
    if (!restoring || restoring.checking) return;
    const text = restoring.carry + chunk;
    let end = 0;
    for (const match of text.matchAll(TITLE)) {
      restoring.title = match[1];
      end = match.index + match[0].length;
    }
    const open = text.lastIndexOf("\x1b]");
    if (open >= end && text.length - open <= MAX_CARRY) restoring.carry = text.slice(open);
    else restoring.carry = text.endsWith("\x1b") ? "\x1b" : "";
  }

  async noteReplayed(workspaceId: string, tabId: string): Promise<void> {
    const key = `${workspaceId}:${tabId}`;
    const restoring = this.restoring.get(key);
    if (!restoring || restoring.checking) return;
    if (this.broker.get(workspaceId, tabId) !== restoring.entry) {
      this.restoring.delete(key);
      return;
    }
    restoring.checking = true;
    const program = await this.foregroundProcess(workspaceId, tabId).catch(() => null);
    if (this.restoring.get(key) !== restoring) return;
    this.restoring.delete(key);
    if (this.broker.get(workspaceId, tabId) !== restoring.entry) return;
    if (program !== null && isLoginShell(program)) {
      this.broker.clear(workspaceId, tabId);
      return;
    }
    if (restoring.entry.status === "running" && isClaudeIdleTitle(restoring.title)) {
      this.broker.set(workspaceId, tabId, "needsInput");
    }
  }

  forget(workspaceId: string, tabId: string): void {
    this.restoring.delete(`${workspaceId}:${tabId}`);
  }

  dispose(): void {
    this.restoring.clear();
  }
}
