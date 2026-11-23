import type { RemoteSession, SessionState } from "../../../../packages/remote-protocol/src/rpc";
import type { TerminalOpener } from "../../../shared/chat/relay";
import type { AgentSession } from "../agent-sessions/model";
import type { RowGroup } from "../agent-sessions/rows";
import {
  type SessionTreeNode,
  searchSessionTree,
  sessionTree,
} from "../agent-sessions/session-tree";
import { remoteDisplayName, remoteTitle } from "../remote/display-name";
import { remoteSessionKey } from "./layout";

export const GROUP_OF: Record<SessionState, RowGroup> = {
  "needs-you": "attention",
  running: "running",
  "new-result": "done",
  idle: "idle",
  ended: "idle",
};

export function remoteGroupOf(session: RemoteSession): RowGroup {
  return session.failed && session.state !== "ended" ? "attention" : GROUP_OF[session.state];
}

export function remoteSessionTree(
  deviceId: string,
  sessions: readonly RemoteSession[],
  query: string,
  available: readonly RemoteSession[] = sessions,
) {
  const byKey = new Map(
    sessions.map((session) => [remoteSessionKey({ deviceId, ...session }), session]),
  );
  const rowsByTab = new Map<string, RemoteSession | undefined>();
  for (const row of available) {
    rowsByTab.set(row.tabId, rowsByTab.has(row.tabId) ? undefined : row);
  }

  function openerOf(opener: RemoteSession["openedBy"]): TerminalOpener | undefined {
    if (!opener) return undefined;
    const { kind = "tab", agent, device } = opener;
    const parent = device ? undefined : rowsByTab.get(opener.tabId);
    const name = remoteTitle(parent?.title) || remoteTitle(opener.name);
    if (device)
      return { ...opener, kind, name, device: { ...device, name: remoteDisplayName(device.name) } };
    const parentKey = parent && remoteSessionKey({ deviceId, ...parent });
    const tabId = parentKey && byKey.has(parentKey) ? parentKey : undefined;
    return { kind, agent, name, tabId };
  }

  const rows: AgentSession[] = Array.from(byKey, ([key, session]) => ({
    key,
    workspaceId: session.workspaceId,
    tabId: key,
    title: remoteTitle(session.title),
    parent: openerOf(session.openedBy),
    kind: session.kind,
    agent: session.kind === "terminal" ? session.agent : session.kind,
    state: session.state === "ended" ? "exited" : session.state,
    phase: remoteGroupOf(session),
    estimated: false,
    since: session.since,
    message: session.last,
    prompt: undefined,
  }));
  const roots = sessionTree(rows).map((node): SessionTreeNode => {
    const opener = byKey.get(node.session.key)?.openedBy;
    if (!opener || opener.device || node.session.parent?.tabId) return node;
    return { ...node, parentClosed: rowsByTab.has(opener.tabId) ? undefined : true };
  });
  return { byKey, roots: searchSessionTree(roots, query) };
}
