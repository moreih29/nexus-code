// The permission requests of Claude sessions the app holds for the user's
// answer, so the agent list can answer them.
//
// Claude Code (2.1.316) shows its permission dialog in the terminal and runs
// the PermissionRequest hook beside it: whichever answers first wins. A
// decision the hook prints allows or denies the call and closes the dialog;
// an answer picked in the dialog leaves the hook running, and an interrupt
// there ends it. So the hook is held here until the user answers it from the
// app, answers its dialog in the terminal (the keys typed there tell it), the
// dialog closes otherwise (the session's hooks tell it), its client goes away
// (the agent tells it), or the agent's deadline answers it with Claude
// Code's own fallback, the dialog. A hook held past its dialog's answer
// would show in Claude Code as running until the call it allowed ends.

import type {
  PermissionAlways,
  PermissionAnswer,
  PermissionAsk,
} from "../../../shared/claude/activity";
import type { HookResponse } from "../../../shared/claude/status";
import { MAIN_AGENT } from "./permission-dialogs";
import { describeTool } from "./session-activity";

/** Answers a waiting hook; false when it is no longer waiting. */
export type HookResponder = (
  workspaceId: string,
  hookId: string,
  response: HookResponse,
) => Promise<boolean>;

/** The request an answer from the app was for. */
export interface AnsweredAsk {
  readonly workspaceId: string;
  readonly tabId: string;
  /** The subagent that asked, or MAIN_AGENT. */
  readonly agent: string;
  /** The call, as the session's permission dialogs key it. */
  readonly call: string | undefined;
  readonly tool: string;
  /** What the call works on, as its tool run tells it. */
  readonly target?: string;
}

export type AnsweredListener = (ask: AnsweredAsk, answer: PermissionAnswer) => void;

/** Called with a request answered in the terminal, the answer unknown. */
export type TerminalAnswerListener = (ask: AnsweredAsk) => void;

interface Held extends AnsweredAsk {
  /** Claude Code's permission_suggestions, given back as they came to allow always. */
  readonly suggestions: readonly unknown[];
  readonly ask: PermissionAsk;
}

/** What Claude is told of a call the user denied from the app with no words of their own. */
export const DENIED_MESSAGE = "The user denied this tool call.";

type Payload = Record<string, unknown>;

export class PermissionAsks {
  /** By the hook's id, oldest first. */
  private readonly held = new Map<string, Held>();
  private readonly listeners = new Set<AnsweredListener>();
  private readonly terminalListeners = new Set<TerminalAnswerListener>();

  constructor(
    private readonly respond: HookResponder,
    private readonly now: () => number = Date.now,
  ) {}

  /** Holds the PermissionRequest hook `hookId` of the session in `tabId`. */
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

  /** The requests of the session in `tabId` held for an answer, oldest first. */
  list(workspaceId: string, tabId: string): PermissionAsk[] {
    return [...this.held.values()]
      .filter((held) => held.workspaceId === workspaceId && held.tabId === tabId)
      .map((held) => held.ask);
  }

  /**
   * Answers the request `id` of the session in `tabId` as the user chose:
   * false when it is no longer held, or no longer waits. Stopping the turn
   * is for the session's own requests: a subagent's is not answered so.
   */
  async answer(
    workspaceId: string,
    tabId: string,
    id: string,
    answer: PermissionAnswer,
    message?: string,
  ): Promise<boolean> {
    const held = this.held.get(id);
    if (!held || held.workspaceId !== workspaceId || held.tabId !== tabId) return false;
    if (answer === "denyStop" && held.agent !== MAIN_AGENT) return false;
    if (answer === "allowAlways" && held.suggestions.length === 0) return false;
    this.held.delete(id);
    const answered = await this.respond(workspaceId, id, {
      stdout: decisionOutput(answer, held.suggestions, message),
      exitCode: 0,
    });
    if (answered) {
      for (const listener of this.listeners) listener(held, answer);
    }
    return answered;
  }

  /**
   * Lets go of the requests of the session in `tabId` whose dialog `isOpen`
   * no longer finds open, answering each with Claude Code's own fallback.
   */
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

  /**
   * The user answered the dialog on the session's screen in its terminal:
   * its request, the oldest, is let go of. (An interrupt there ends its hook
   * instead, which `gone` tells.)
   */
  answeredInTerminal(workspaceId: string, tabId: string): void {
    const [oldest] = this.list(workspaceId, tabId);
    const held = oldest && this.held.get(oldest.id);
    if (!held) return;
    this.release((other) => other === held);
    for (const listener of this.terminalListeners) listener(held);
  }

  /** The hook `hookId` no longer waits: its client went away. */
  gone(hookId: string): void {
    this.held.delete(hookId);
  }

  /** The session in `tabId` ended, or no longer shows its state. */
  clear(workspaceId: string, tabId: string): void {
    this.release((held) => held.workspaceId === workspaceId && held.tabId === tabId);
  }

  clearWorkspace(workspaceId: string): void {
    this.release((held) => held.workspaceId === workspaceId);
  }

  /** Called once an answer from the app reached Claude Code. */
  onAnswered(listener: AnsweredListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called once a request is answered in the terminal. */
  onAnsweredInTerminal(listener: TerminalAnswerListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private release(releases: (held: Held) => boolean): void {
    for (const [id, held] of this.held) {
      if (!releases(held)) continue;
      this.held.delete(id);
      void this.respond(held.workspaceId, id, { exitCode: 0 });
    }
  }
}

/**
 * Whether input typed into a terminal answers a permission dialog on its
 * screen: Enter takes the option picked, a digit picks one.
 */
export function answersDialog(data: string): boolean {
  return data === "\r" || /^[1-9]$/.test(data);
}

/** The PermissionRequest hook's output for `answer`, as Claude Code reads it. */
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

/** What Claude Code's suggestions would let through, in the words of its dialog. */
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
