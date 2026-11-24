import type {
  PermissionAlways,
  PermissionAnswer,
  PermissionAsk,
} from "../../../shared/claude/activity";
import type { HookResponse } from "../../../shared/claude/status";
import { MAIN_AGENT } from "./permission-dialogs";
import { describeTool } from "./session-activity";

export type HookAnswerResult = "answered" | "gone" | "unavailable";

export type HookResponder = (
  workspaceId: string,
  hookId: string,
  response: HookResponse,
) => Promise<HookAnswerResult>;

export interface AnsweredAsk {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly agent: string;
  readonly call: string | undefined;
  readonly tool: string;
  readonly target?: string;
}

export type AnsweredListener = (ask: AnsweredAsk, answer: PermissionAnswer) => void;

export type TerminalAnswerListener = (ask: AnsweredAsk) => void;

interface Held extends AnsweredAsk {
  readonly suggestions: readonly unknown[];
  readonly ask: PermissionAsk;
}

export const DENIED_MESSAGE = "The user denied this tool call.";

export const DISMISS_WINDOW_MS = 10_000;

export const TERMINAL_RELEASE_MS = 2_000;

export type Schedule = (run: () => void, ms: number) => () => void;

function scheduleTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

interface Releasing {
  readonly held: Held;
  readonly cancel: () => void;
}

const ESCAPE = "\x1b";

const FOCUS_REPORTS = new Set(["\x1b[I", "\x1b[O"]);

type Payload = Record<string, unknown>;

export class PermissionAsks {
  private readonly held = new Map<string, Held>();
  private readonly answering = new Set<Held>();
  private readonly listeners = new Set<AnsweredListener>();
  private readonly terminalListeners = new Set<TerminalAnswerListener>();
  private readonly dismissListeners = new Set<TerminalAnswerListener>();
  private readonly keyedAt = new Map<string, number>();
  private readonly releasing = new Map<string, Releasing>();

  constructor(
    private readonly respond: HookResponder,
    private readonly now: () => number = Date.now,
    private readonly schedule: Schedule = scheduleTimer,
  ) {}

  hold(
    workspaceId: string,
    tabId: string,
    hookId: string,
    agent: string,
    call: string | undefined,
    payload: unknown,
  ): void {
    const p = record(payload);
    const tool = typeof p.tool_name === "string" ? p.tool_name : "";
    const suggestions = Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [];
    const cwd = typeof p.cwd === "string" && p.cwd !== "" ? p.cwd : undefined;
    const described = describeTool(tool, record(p.tool_input), cwd);
    this.held.set(hookId, {
      workspaceId,
      tabId,
      agent,
      call,
      tool,
      ...(described.target === undefined ? {} : { target: described.target }),
      suggestions,
      ask: {
        id: hookId,
        ...(agent === MAIN_AGENT ? {} : { agentId: agent }),
        tool,
        ...described,
        always: alwaysOf(suggestions),
        since: this.now(),
      },
    });
  }

  list(workspaceId: string, tabId: string): PermissionAsk[] {
    return [...this.held.values()]
      .filter((held) => held.workspaceId === workspaceId && held.tabId === tabId)
      .map((held) => held.ask);
  }

  async answer(
    workspaceId: string,
    tabId: string,
    id: string,
    answer: PermissionAnswer,
    message?: string,
  ): Promise<boolean> {
    const held = this.held.get(id);
    if (!held || held.workspaceId !== workspaceId || held.tabId !== tabId) return false;
    if (this.answering.has(held)) return false;
    if (answer === "denyStop" && held.agent !== MAIN_AGENT) return false;
    if (answer === "allowAlways" && held.suggestions.length === 0) return false;
    this.answering.add(held);
    try {
      const result = await this.respond(workspaceId, id, {
        stdout: decisionOutput(answer, held.suggestions, message),
        exitCode: 0,
      });
      if (result !== "unavailable" && this.held.get(id) === held) {
        this.held.delete(id);
        if (result === "answered") {
          for (const listener of this.listeners) listener(held, answer);
        }
      }
      return result === "answered";
    } finally {
      this.answering.delete(held);
    }
  }

  retain(
    workspaceId: string,
    tabId: string,
    isOpen: (agent: string, call: string | undefined) => boolean,
  ): void {
    this.release((held) => {
      return (
        held.workspaceId === workspaceId && held.tabId === tabId && !isOpen(held.agent, held.call)
      );
    });
  }

  noteTerminalInput(workspaceId: string, tabId: string, data: string): void {
    if (FOCUS_REPORTS.has(data)) return;
    const key = `${workspaceId}:${tabId}`;
    this.keyedAt.delete(key);
    const answers = answersDialog(data);
    if ((!answers && data !== ESCAPE) || this.list(workspaceId, tabId).length === 0) return;
    this.keyedAt.set(key, this.now());
    if (answers) this.answeredInTerminal(workspaceId, tabId);
  }

  answeredInTerminal(workspaceId: string, tabId: string): void {
    const [oldest] = this.list(workspaceId, tabId);
    const held = oldest && this.held.get(oldest.id);
    if (!held) return;
    this.held.delete(oldest.id);
    if (!this.answering.has(held)) this.releaseLater(oldest.id, held);
    for (const listener of this.terminalListeners) listener(held);
  }

  gone(hookId: string): void {
    const releasing = this.releasing.get(hookId);
    releasing?.cancel();
    this.releasing.delete(hookId);
    const held = this.held.get(hookId) ?? releasing?.held;
    if (!held) return;
    this.held.delete(hookId);
    const keyedAt = this.keyedAt.get(`${held.workspaceId}:${held.tabId}`);
    if (keyedAt === undefined || this.now() - keyedAt > DISMISS_WINDOW_MS) return;
    for (const listener of this.dismissListeners) listener(held);
  }

  clear(workspaceId: string, tabId: string): void {
    this.keyedAt.delete(`${workspaceId}:${tabId}`);
    const matches = (held: Held) => held.workspaceId === workspaceId && held.tabId === tabId;
    this.releaseNow(matches);
    this.release(matches);
  }

  clearWorkspace(workspaceId: string): void {
    for (const key of this.keyedAt.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.keyedAt.delete(key);
    }
    const matches = (held: Held) => held.workspaceId === workspaceId;
    this.releaseNow(matches);
    this.release(matches);
  }

  onAnswered(listener: AnsweredListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAnsweredInTerminal(listener: TerminalAnswerListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  onDismissedInTerminal(listener: TerminalAnswerListener): () => void {
    this.dismissListeners.add(listener);
    return () => this.dismissListeners.delete(listener);
  }

  private releaseLater(id: string, held: Held): void {
    const cancel = this.schedule(() => {
      this.releasing.delete(id);
      void this.respond(held.workspaceId, id, { exitCode: 0 });
    }, TERMINAL_RELEASE_MS);
    this.releasing.set(id, { held, cancel });
  }

  private releaseNow(releases: (held: Held) => boolean): void {
    for (const [id, { held, cancel }] of this.releasing) {
      if (!releases(held)) continue;
      cancel();
      this.releasing.delete(id);
      void this.respond(held.workspaceId, id, { exitCode: 0 });
    }
  }

  private release(releases: (held: Held) => boolean): void {
    for (const [id, held] of this.held) {
      if (!releases(held)) continue;
      this.held.delete(id);
      if (!this.answering.has(held)) void this.respond(held.workspaceId, id, { exitCode: 0 });
    }
  }
}

export function answersDialog(data: string): boolean {
  return data === "\r" || /^[1-9]$/.test(data);
}

export function decisionOutput(
  answer: PermissionAnswer,
  suggestions: readonly unknown[],
  message?: string,
): string {
  const decision =
    answer === "allow"
      ? { behavior: "allow" }
      : answer === "allowAlways"
        ? { behavior: "allow", updatedPermissions: suggestions }
        : {
            behavior: "deny",
            message: message?.trim() || DENIED_MESSAGE,
            ...(answer === "denyStop" ? { interrupt: true } : {}),
          };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

export function alwaysOf(suggestions: readonly unknown[]): PermissionAlways[] {
  return suggestions.flatMap((suggestion): PermissionAlways[] => {
    const s = record(suggestion);
    const destination = typeof s.destination === "string" ? s.destination : undefined;
    switch (s.type) {
      case "addRules":
      case "replaceRules":
        if (s.behavior !== "allow" || !Array.isArray(s.rules)) return [];
        return s.rules.flatMap((value): PermissionAlways[] => {
          const rule = record(value);
          if (typeof rule.toolName !== "string") return [];
          const content = typeof rule.ruleContent === "string" ? rule.ruleContent : "";
          return [
            {
              kind: "rule",
              rule: content === "" ? rule.toolName : `${rule.toolName}(${content})`,
              ...(destination ? { destination } : {}),
            },
          ];
        });
      case "setMode":
        return typeof s.mode === "string" ? [{ kind: "mode", mode: s.mode }] : [];
      case "addDirectories":
        return Array.isArray(s.directories)
          ? s.directories.flatMap((path): PermissionAlways[] =>
              typeof path === "string" ? [{ kind: "directory", path }] : [],
            )
          : [];
      default:
        return [];
    }
  });
}

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}
