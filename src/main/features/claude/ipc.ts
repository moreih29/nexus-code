import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { register, validateArgs } from "../../infra/ipc-router";
import type { ActiveContextStore } from "./active-context";
import type { ChatAnswers } from "./chat-answers";
import type { PermissionAsks } from "./permission-asks";
import type { SessionActivityLog } from "./session-activity";
import type { ClaudeStatusBroker } from "./status";

const c = ipcContract.claude.call;

export function registerClaudeChannel(
  broker: ClaudeStatusBroker,
  activeContext: ActiveContextStore,
  activity: SessionActivityLog,
  asks: PermissionAsks,
  chatAnswers: ChatAnswers,
  stopPrintRun: (workspaceId: string, tabId: string, agentId: string) => Promise<boolean>,
): void {
  register("claude", {
    call: {
      snapshot: async () => ipcOk(broker.snapshot()),
      setActiveContext: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.setActiveContext.args, args);
        activeContext.set(workspaceId, tabId);
        return ipcOk(undefined);
      },
      markSeen: async (args: unknown) => {
        const { workspaceId, tabId, completedAt, resultAt } = validateArgs(c.markSeen.args, args);
        const entry = broker.get(workspaceId, tabId);
        const completed =
          entry?.status === "completed" &&
          (completedAt === undefined || entry.since === completedAt) &&
          (resultAt === undefined ||
            entry.turnStartedAt === undefined ||
            entry.turnStartedAt <= resultAt);
        if (completed || (completedAt === undefined && entry?.status === "needsInput")) {
          broker.set(workspaceId, tabId, "idle");
        }
        return ipcOk(undefined);
      },
      clearWorkspace: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.clearWorkspace.args, args);
        broker.clearWorkspace(workspaceId);
        activity.clearWorkspace(workspaceId);
        asks.clearWorkspace(workspaceId);
        return ipcOk(undefined);
      },
      activity: async (args: unknown) => {
        const { workspaceIds } = validateArgs(c.activity.args, args);
        return ipcOk(
          activity.list(workspaceIds).map((session) => {
            const held = asks.list(session.workspaceId, session.tabId);
            return held.length > 0 ? { ...session, asks: held } : session;
          }),
        );
      },
      answerPermission: async (args: unknown) => {
        const { workspaceId, tabId, askId, answer, message } = validateArgs(
          c.answerPermission.args,
          args,
        );
        return ipcOk(await asks.answer(workspaceId, tabId, askId, answer, message));
      },
      answeredInChat: async (args: unknown) => {
        const { workspaceId, tabId, stopped } = validateArgs(c.answeredInChat.args, args);
        chatAnswers.answered(workspaceId, tabId, stopped);
        return ipcOk(undefined);
      },
      stopPrintRun: async (args: unknown) => {
        const { workspaceId, tabId, agentId } = validateArgs(c.stopPrintRun.args, args);
        return ipcOk(await stopPrintRun(workspaceId, tabId, agentId));
      },
    },
    listen: {
      status: {},
    },
  });
}
