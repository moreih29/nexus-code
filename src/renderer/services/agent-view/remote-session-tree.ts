import type { RemoteSession, SessionState } from "../../../../packages/remote-protocol/src/rpc";
import type { TerminalOpener } from "../../../shared/chat/relay";
import type { AgentSession } from "../agent-sessions/model";
import type { RowGroup } from "../agent-sessions/rows";
import { searchSessionTree, sessionTree } from "../agent-sessions/session-tree";
import { remoteDisplayName } from "../remote/display-name";
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
  const unlinkedParents = new Set<string>();

  function openerOf(key: string, opener: RemoteSession["openedBy"]): TerminalOpener | undefined {
    if (!opener) return undefined;
    const { kind = "tab", agent, device } = opener;
    const parent = device ? undefined : rowsByTab.get(opener.tabId);
    const name =
      remoteDisplayName(parent?.title) ||
      remoteDisplayName(opener.name) ||
      remoteDisplayName(opener.tabId.slice(0, 8));
    if (device)
      return { ...opener, kind, name, device: { ...device, name: remoteDisplayName(device.name) } };
    const parentKey = parent && remoteSessionKey({ deviceId, ...parent });
    const tabId = parentKey && byKey.has(parentKey) ? parentKey : undefined;
    // A hidden or ambiguous parent is in the listing, but cannot be a tree link.
    if (!tabId && rowsByTab.has(opener.tabId)) unlinkedParents.add(key);
    return { kind, agent, name, tabId };
  }

  const rows: AgentSession[] = Array.from(byKey, ([key, session]) => ({
    key,
    workspaceId: session.workspaceId,
    tabId: key,
    title: remoteDisplayName(session.title),
    parent: openerOf(key, session.openedBy),
    kind: session.kind,
    agent: session.kind === "terminal" ? session.agent : session.kind,
    state: session.state === "ended" ? "exited" : session.state,
    phase: remoteGroupOf(session),
    estimated: false,
    since: session.since,
    message: session.last,
    prompt: undefined,
  }));
  const roots = sessionTree(rows).map((node) =>
    unlinkedParents.has(node.session.key) ? { ...node, parentClosed: undefined } : node,
  );
  return { byKey, roots: searchSessionTree(roots, query) };
}
