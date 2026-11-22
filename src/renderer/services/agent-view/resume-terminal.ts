import { useEffect, useRef } from "react";
import { agentFromProgram, type TerminalRef } from "../../../shared/sessions/agent-state";
import { ipcCallResult } from "../../ipc/client";
import type { AgentSession } from "../agent-sessions/model";
import { startedTerminal } from "../cli/actions";
import { requestTabFocus } from "../tab-focus";
import { getTerminalController, whenTerminalController } from "../terminal/terminal-registry";
import type { TerminalController, TerminalInputCheckpoint } from "../terminal/types";
import type { ResumableAgent } from "./ended";

interface RunCheckpoint {
  tabId: string;
  agent: ResumableAgent;
  input: TerminalInputCheckpoint;
}

/**
 * Records the last input sent while the agent was in the foreground, including
 * when the view has yet to notice the agent exit and the shell already has input.
 */
export function watchAgentInput(
  terminal: TerminalRef,
  controller: TerminalController,
  agent: ResumableAgent,
  remember: (input: TerminalInputCheckpoint) => void,
): () => void {
  let watching = true;
  let reading = false;
  let checked: TerminalInputCheckpoint | undefined;
  const check = async (): Promise<void> => {
    if (!watching || reading) return;
    const input = controller.getInputCheckpoint();
    if (input === checked) return;
    checked = input;
    if (!input.hasInput) {
      remember(input);
      return;
    }
    reading = true;
    try {
      const result = await ipcCallResult("pty", "foregroundProcess", terminal);
      if (watching && result.ok && agentFromProgram(result.value.name) === agent) remember(input);
    } catch {
      // The foreground could not be confirmed. Keep the last known checkpoint.
    } finally {
      reading = false;
      if (controller.getInputCheckpoint() !== input) void check();
    }
  };
  const onInput = () => void check();
  const stopInput = controller.onInput(onInput);
  onInput();
  return () => {
    watching = false;
    stopInput();
  };
}

export function useAgentResumeCheckpoint(session: AgentSession | undefined) {
  const checkpoint = useRef<RunCheckpoint | undefined>(undefined);
  const { kind, workspaceId, tabId, agent } = session ?? {};

  useEffect(() => {
    if (
      kind !== "terminal" ||
      !workspaceId ||
      !tabId ||
      (agent !== "claude" && agent !== "codex")
    ) {
      return;
    }
    checkpoint.current = undefined;
    let stopped = false;
    let stopInput: (() => void) | undefined;
    void whenTerminalController(tabId, 5000).then((controller) => {
      if (stopped || !controller) return;
      stopInput = watchAgentInput({ workspaceId, tabId }, controller, agent, (input) => {
        checkpoint.current = { tabId, agent, input };
      });
    });
    return () => {
      stopped = true;
      stopInput?.();
    };
  }, [kind, workspaceId, tabId, agent]);

  return (endedTabId: string, endedAgent: ResumableAgent | undefined) => {
    const last = checkpoint.current;
    return last?.tabId === endedTabId && last.agent === endedAgent ? last.input : undefined;
  };
}

export function canResumeInTerminal(tabId: string, input: TerminalInputCheckpoint | undefined) {
  return input !== undefined && getTerminalController(tabId)?.getInputCheckpoint() === input;
}

/** Submit one shell command, with no yield between checking the draft and pressing Enter. */
export async function resumeInTerminal(
  terminal: TerminalRef,
  line: string,
  input: TerminalInputCheckpoint | undefined,
): Promise<void> {
  if (!canResumeInTerminal(terminal.tabId, input)) return;
  const controller = await startedTerminal(terminal.workspaceId, terminal.tabId);
  if (
    getTerminalController(terminal.tabId) !== controller ||
    controller.getInputCheckpoint() !== input
  ) {
    return;
  }
  if (controller.input(`${line}\r`, "keys")) requestTabFocus(terminal.tabId);
}
