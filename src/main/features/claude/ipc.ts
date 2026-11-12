// Claude IPC channel registration — snapshot/setActiveContext/markSeen call + status listen.
// Follows the register pattern of the existing pty/ipc.ts as is.

import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { register, validateArgs } from "../../infra/ipc-router";
import type { ActiveContextStore } from "./active-context";
import type { ChatAnswers } from "./chat-answers";
import type { PermissionAsks } from "./permission-asks";
import type { SessionActivityLog } from "./session-activity";
import type { ClaudeStatusBroker } from "./status";

const c = ipcContract.claude.call;

/**
 * Registers the claude IPC channels.
 *
 * - call.snapshot: returns every current (workspaceId, tabId) status. Called once when the renderer initializes.
 * - call.setActiveContext: pushed by the renderer when the active tab changes. main caches it and uses it to decide Stop notifications.
 * - call.markSeen: notifies that the user activated the tab. If the status was completed/needsInput,
 *   it moves to idle. permissionPending/error are kept until the user takes explicit action.
 * - call.clearWorkspace: resets every tab status of a workspace. The path for the user to recover
 *   manually from the context menu when a hook left a stale state.
 * - call.activity: what the sessions of the workspaces are doing, as their hooks tell it,
 *   with the permission requests held for the user's answer.
 * - call.answerPermission: answers a held permission request as the user chose.
 * - call.answeredInChat: a Claude tab's user answered the last permission request it showed.
 * - call.stopPrintRun: stops a session's running `claude -p` run.
 * - listen.status: the broker broadcasts directly on a status change, so it is declared here as an empty object.
 */
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
        const { workspaceId, tabId } = validateArgs(c.markSeen.args, args);
        // Only states whose notification meaning is lost once the user has seen the tab
        // move to idle:
        //  - completed: marks that the response finished → once seen, it is done.
        //  - needsInput: a notification that Claude awaits input → if the user is looking at the tab
        //    they will type soon or close it, so the glyph loses its meaning.
        // permissionPending/error/running are kept — the visual mark must stay valid until the user takes explicit action or
        // the system responds.
        const entry = broker.get(workspaceId, tabId);
        if (entry?.status === "completed" || entry?.status === "needsInput") {
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
