import { create } from "zustand";
import {
  type AgentInstructions,
  chatInstructionHistoryKey,
  EMPTY_INSTRUCTIONS,
  type InstructionEdit,
} from "../../../shared/chat/instructions";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { flushStatePersistence } from "../persistence";
import { useTabsStore } from "./tabs";

type History = NonNullable<AppState["chatInstructionHistory"]>;

export const useAgentInstructionsStore = create<{ config: AgentInstructions; history: History }>(
  () => ({ config: EMPTY_INSTRUCTIONS, history: {} }),
);

export async function saveInstructionEdits(instructionEdits: InstructionEdit[]): Promise<void> {
  unwrapIpcResult(await ipcCallResult("appState", "set", { instructionEdits }));
}

/** Snapshot a previous conversation's layer onto newly opened tabs. */
export function reopenedSessionInstructions(
  workspaceId: string,
  agent: ChatAgent,
  conversationId: string,
): string | undefined {
  return useAgentInstructionsStore.getState().history[workspaceId]?.[
    chatInstructionHistoryKey(agent, conversationId)
  ];
}

export function currentSessionInstructions(
  workspaceId: string,
  tabId: string,
  sessionToOpen?: string,
): string {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "claude" && tab?.type !== "codex") return "";
  const current = tab.type === "claude" ? tab.props.sessionId : tab.props.threadId;
  return (
    tab.props.instructions ??
    (sessionToOpen && sessionToOpen !== current
      ? reopenedSessionInstructions(workspaceId, tab.type, sessionToOpen)
      : undefined) ??
    ""
  );
}

export function rememberSessionInstructions(
  workspaceId: string,
  tabId: string,
  conversationId: string,
): void {
  const instructions = currentSessionInstructions(workspaceId, tabId, conversationId);
  if (instructions.trim())
    useTabsStore.getState().setChatInstructions(workspaceId, tabId, instructions);
}

export async function saveSessionInstructions(
  workspaceId: string,
  tabId: string,
  instructions: string,
): Promise<void> {
  const tab = () => useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  const before = tab();
  if (before?.type !== "claude" && before?.type !== "codex")
    throw new Error("The chat tab was closed.");
  useTabsStore.getState().setChatInstructions(workspaceId, tabId, instructions);
  if (await flushStatePersistence()) return;

  const current = tab();
  if (current?.type === before.type && current.props.instructions === instructions) {
    useTabsStore.getState().setChatInstructions(workspaceId, tabId, before.props.instructions);
  }
  throw new Error("Could not save the session instructions.");
}
