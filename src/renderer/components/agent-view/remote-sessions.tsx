// The agent view's list, below this computer's agents: the account's other
// computers in the room, each with its workspaces' sessions in the order
// its own sidebar shows them. A computer folds, and the search box finds
// sessions by their title or last line. A terminal with only its shell is
// out of sight until the user opens its workspace's terminals chip or
// searches for it. Quiet worktrees wait behind their parent's own chip.
//
// Where the computer lets this one control its chats or terminals, a
// workspace's heading has a + to open one there, and a session's row a
// right-click menu to rename or close it; a workspace with none listed
// shows for its +, as one of this computer's does. The computer's consent
// prompts come first in its group, to answer from here.

import i18next from "i18next";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  GitBranch,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import {
  type ComponentProps,
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  RemoteConsent,
  RemoteSession,
  RemoteSessionAgent,
  RemoteWorkspace,
  SessionState,
} from "../../../../packages/remote-protocol/src/rpc";
import type { AgentRun } from "../../../shared/claude/activity";
import type { RoomPeer, RoomState } from "../../../shared/remote/room";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import type { AgentSession } from "../../services/agent-sessions/model";
import {
  compareStatusTime,
  groupOf,
  listed,
  matchesQuery,
  ROW_GROUPS,
  type RowGroup,
} from "../../services/agent-sessions/rows";
import { leafHolding, remoteSessionKey } from "../../services/agent-view/layout";
import { moveKey, movePeer, orderPeers, reorderSubset } from "../../services/agent-view/order";
import { type RemoteResults, useRemoteResults } from "../../services/agent-view/remote-results";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { remoteAccountKey, useRemoteAccount } from "../../services/remote/account";
import {
  offlinePeers,
  type PeerSessions,
  peerServes,
  peerSpeaks,
  type SessionsList,
  servingPeers,
  usePeerSessions,
  useRemoteRoom,
  useShownRoom,
} from "../../services/remote/room";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { askOf, type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { cn } from "../../utils/cn";
import { AgentRows } from "../agent-list/agent-rows";
import {
  FailureLabel,
  HiddenSessionCount,
  StateGlyph,
  useDurationLabel,
} from "../agent-list/session-status";
import { GROUP_STATE, GROUP_TINT } from "../agent-list/status-view";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { OutdatedLine } from "../settings/panels/remote-outdated";
import { BannerDismissButton } from "../ui/banner";
import { Button } from "../ui/button";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
  type MenuItemSpec,
} from "../ui/context-menu";
import { PromptDialog, type PromptRequest } from "../ui/prompt-dialog";
import { useContextMenuHandoff } from "../ui/use-context-menu-handoff";
import { PANEL_SHOWN_BG, PanelMark, type PanelPlace, panelPlaceOf } from "./panel-mark";
import { PeerConsentCard, usePeerConsents } from "./remote-consents";
import { RemoteNewMenu } from "./remote-new-menu";
import { type PeerDrag, type PeerReorder, RemotePeerHeader } from "./remote-peer-header";
import {
  closePeerSession,
  type PeerSessionRef,
  renamePeerSession,
  reorderPeerSessions,
} from "./remote-session-actions";
import {
  endSessionDrag,
  hoverWorkspaceReorder,
  leaveWorkspaceReorder,
  type SessionReorder,
  startSessionDrag,
  useSessionDrop,
  useSessionReordering,
} from "./session-drop";
import { SidebarDropIndicator } from "./sidebar-drop";

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
// Allow a watch that had already started reading to finish and read again.
const ORDER_CONFIRM_MS = 18_000;
const tabIdOf = (session: RemoteSession) => session.tabId;

function canReorderSession(session: RemoteSession): boolean {
  return session.state !== "ended" && (session.kind !== "terminal" || session.agent !== undefined);
}

/** A remote session's state as this list's groups tell it. */
export const GROUP_OF: Record<SessionState, RowGroup> = {
  "needs-you": "attention",
  running: "running",
  "new-result": "done",
  idle: "idle",
  // Left out of the list unasked, as an agent here whose terminal ended is.
  ended: "idle",
};

function remoteGroupOf(session: RemoteSession): RowGroup {
  return session.failed && session.state !== "ended" ? "attention" : GROUP_OF[session.state];
}

const FAILURE_SCHEMA = "0.22.0";

/**
 * Whether the list shows a session without being asked: a chat, or a
 * terminal running an agent. A computer of an older protocol names no
 * terminal's agent; one that waits on the user, works, or said something
 * runs one.
 */
export function listedByDefault(session: RemoteSession): boolean {
  if (session.state === "ended") return false;
  if (session.kind !== "terminal") return true;
  return (
    session.failed === true ||
    session.agent !== undefined ||
    session.waiting !== undefined ||
    session.state !== "idle" ||
    session.last !== undefined
  );
}

function isEndedTerminal({ kind, state }: Pick<RemoteSession, "kind" | "state">): boolean {
  return kind === "terminal" && state === "ended";
}

/**
 * The sessions the list shows: those it shows unasked, a terminal in a
 * panel too, and those a search finds; and by workspace, its terminals with
 * only their shell, which wait behind its heading's chip (none searched).
 */
export function listedSessions(
  sessions: readonly RemoteSession[],
  query: string,
  inPanel: (session: RemoteSession) => boolean,
): { listed: RemoteSession[]; plain: ReadonlyMap<string, RemoteSession[]> } {
  if (query.trim()) return { listed: sessions.filter((s) => matches(s, query)), plain: new Map() };
  const listed: RemoteSession[] = [];
  const plain = new Map<string, RemoteSession[]>();
  for (const s of sessions) {
    if (isEndedTerminal(s)) continue;
    if (listedByDefault(s) || inPanel(s)) listed.push(s);
    else plain.set(s.workspaceId, [...(plain.get(s.workspaceId) ?? []), s]);
  }
  return { listed, plain };
}

function matches(session: RemoteSession, query: string): boolean {
  if (isEndedTerminal(session)) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return session.title.toLowerCase().includes(q) || (session.last ?? "").toLowerCase().includes(q);
}

export type RemoteStatusSource = { peer: RoomPeer; list: SessionsList };

export type StatusRow =
  | { kind: "local"; session: AgentSession }
  | { kind: "remote"; session: RemoteSession; peer: RoomPeer; workspace?: RemoteWorkspace };

export function statusGroups(
  local: readonly AgentSession[],
  remote: readonly RemoteStatusSource[],
  query: string,
  pending: (deviceId: string, consentId: string) => boolean,
) {
  const groups = ROW_GROUPS.map((group) => ({ group, rows: [] as StatusRow[] }));
  const byGroup = new Map(groups.map(({ group, rows }) => [group, rows]));
  const consents: {
    consent: RemoteConsent;
    source: RemoteStatusSource;
    workspace?: RemoteWorkspace;
  }[] = [];
  const searching = query.trim() !== "";
  for (const session of local) {
    if (listed(session) && matchesQuery(session, query))
      byGroup.get(groupOf(session))?.push({ kind: "local", session });
  }
  for (const source of remote) {
    const { peer, list } = source;
    const workspaces = new Map(list.workspaces.map((workspace) => [workspace.id, workspace]));
    const found = list.sessions.filter(
      (session) => listedByDefault(session) && matches(session, query),
    );
    for (const session of found) {
      byGroup.get(remoteGroupOf(session))?.push({
        kind: "remote",
        session,
        peer,
        workspace: workspaces.get(session.workspaceId),
      });
    }
    for (const consent of list.consents ?? []) {
      if (!pending(peer.id, consent.id)) continue;
      if (searching && !found.some((session) => session.workspaceId === consent.workspaceId))
        continue;
      consents.push({ consent, source, workspace: workspaces.get(consent.workspaceId) });
    }
  }
  for (const { group, rows } of groups)
    rows.sort((a, b) => compareStatusTime(group, a.session.since, b.session.since));
  return { groups, consents };
}

/** The eligible workspace groups in the peer's order, with quiet worktrees behind their parents. */
export function workspaceGroups(
  list: SessionsList | null,
  {
    query,
    opens,
    inPanel,
    worktreesIn,
    terminalsIn,
    folds,
    reordering,
  }: {
    query: string;
    opens: boolean;
    inPanel: (session: RemoteSession) => boolean;
    worktreesIn: ReadonlySet<string>;
    terminalsIn?: ReadonlySet<string>;
    folds?: ReadonlySet<string>;
    reordering?: ReadonlySet<string>;
  },
) {
  const searching = query.trim().length > 0;
  const { listed, plain } = listedSessions(list?.sessions ?? [], query, inPanel);
  const workspaces = new Map(list?.workspaces.map((w) => [w.id, w]) ?? []);
  const byWorkspace = new Map<string, RemoteSession[]>();
  for (const id of workspaces.keys()) byWorkspace.set(id, []);
  for (const s of list?.sessions ?? []) {
    if (!byWorkspace.has(s.workspaceId)) byWorkspace.set(s.workspaceId, []);
  }
  for (const s of listed) byWorkspace.get(s.workspaceId)?.push(s);

  const eligible = new Set<string>();
  const worktreeCounts = new Map<string, number>();
  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  const plainShown = new Map(plain);
  const foldedWorkspaces = new Set(
    [...byWorkspace.keys()].filter((id) => !searching && !reordering?.has(id) && folds?.has(id)),
  );
  const keepsWorktreeVisible = (s: RemoteSession) =>
    remoteGroupOf(s) !== "idle" ||
    s.limitWait !== undefined ||
    s.waiting !== undefined ||
    s.agents?.some((a) => a.state === "running" || a.state === "permissionPending") ||
    inPanel(s);
  for (const [id, rows] of byWorkspace) {
    const workspace = workspaces.get(id);
    const parent =
      workspace?.parentId === undefined ? undefined : workspaces.get(workspace.parentId);
    const rootParent = parent?.parentId === undefined ? parent : undefined;
    const canStart =
      opens && !searching && workspace && (workspace.parentId === undefined || rootParent);
    const terminals = plain.get(id);
    if (rows.length === 0 && !terminals && !canStart) continue;
    eligible.add(id);
    if (rootParent && !searching) eligible.add(rootParent.id);

    const parentFolded =
      rootParent && !searching && !reordering?.has(id) && folds?.has(rootParent.id);
    const ownFolded = foldedWorkspaces.has(id);
    if (parentFolded || ownFolded) {
      const visible = rows.filter((session) => remoteGroupOf(session) !== "idle");
      byWorkspace.set(id, visible);
      plainShown.delete(id);
      const owner = parentFolded ? rootParent.id : id;
      const disclosedTerminals = terminalsIn?.has(id) ? (terminals?.length ?? 0) : 0;
      const count = rows.length - visible.length + disclosedTerminals;
      hiddenCounts.set(owner, (hiddenCounts.get(owner) ?? 0) + count);
      if (parentFolded && visible.length === 0) hidden.add(id);
    }

    if (searching || !rootParent || parentFolded || reordering?.has(id)) continue;
    if (rows.some(keepsWorktreeVisible) || terminals?.some(keepsWorktreeVisible)) continue;
    worktreeCounts.set(rootParent.id, (worktreeCounts.get(rootParent.id) ?? 0) + 1);
    if (!worktreesIn.has(rootParent.id)) hidden.add(id);
  }

  const groups = [...byWorkspace].filter(([id]) => eligible.has(id) && !hidden.has(id));
  return { groups, workspaces, plain: plainShown, worktreeCounts, foldedWorkspaces, hiddenCounts };
}

function toggleWorkspace(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

type RenderStatus = (sources: readonly RemoteStatusSource[], results: RemoteResults) => ReactNode;

export function RemoteSessions({
  query,
  shown = true,
  renderStatus,
}: {
  query: string;
  shown?: boolean;
  renderStatus?: RenderStatus;
}) {
  const account = useRemoteAccount();
  const accountKey = remoteAccountKey(account);
  return (
    <AccountRemoteSessions
      key={accountKey}
      accountKey={accountKey}
      signedOut={account?.status === "signed-out"}
      query={query}
      shown={shown}
      renderStatus={renderStatus}
    />
  );
}

function AccountRemoteSessions({
  accountKey,
  signedOut,
  query,
  shown,
  renderStatus,
}: {
  accountKey: string | null;
  signedOut: boolean;
  query: string;
  shown: boolean;
  renderStatus?: RenderStatus;
}) {
  const { t } = useTranslation();
  const room = useRemoteRoom();
  // Keep brief relay and peer drops off the screen while watching the real room.
  const seen = useShownRoom(room);
  const roomStatus = seen?.status;
  const outdated = roomStatus === "outdated";
  const signInNotice = useBannerDismissal(
    ["remote-sessions-sign-in"],
    signedOut ? [true] : undefined,
    true,
  );
  const outdatedNotice = useBannerDismissal(
    ["remote-sessions-outdated"],
    outdated ? [true] : undefined,
    true,
  );
  const peerOrderAccount = useAgentViewStore((s) => s.peerOrderAccount);
  const peerOrder = useAgentViewStore((s) =>
    s.peerOrder?.accountKey === accountKey ? s.peerOrder.ids : undefined,
  );
  const [drag, setDrag] = useState<PeerDrag | null>(null);
  const lastOnline = useRef<RoomState | null>(null);
  const roomOnline = room?.status === "online";
  const connected = roomStatus === "online";
  const connecting = roomStatus === "connecting" || roomStatus === "waiting";
  useEffect(() => {
    if (roomOnline) lastOnline.current = seen;
  }, [roomOnline, seen]);
  const displayedRoom =
    connected && (roomOnline || (seen?.peers.length ?? 0) > 0)
      ? seen
      : (lastOnline.current ?? seen);
  // Searching, an offline computer has no sessions to find.
  const searching = query.trim() !== "";
  const away = searching ? [] : orderPeers(offlinePeers(displayedRoom), peerOrder);
  const online = servingPeers(room);
  const lists = usePeerSessions(
    online.map((peer) => peer.id),
    shown,
  );
  const results = useRemoteResults(online, shown, accountKey);
  const listedPeers = orderPeers(servingPeers(displayedRoom), peerOrder).filter(
    (peer) => connected || lists[peer.id]?.status === "ready",
  );
  const displayList = (peer: RoomPeer, list: SessionsList): SessionsList => ({
    ...list,
    sessions: list.sessions.map((session) =>
      results.session(
        peer.id,
        session,
        peerSpeaks(peer, FAILURE_SCHEMA),
        peerServes(peer, "sessions.markSeen"),
      ),
    ),
  });
  const statusGroups = renderStatus?.(
    connected && accountKey !== null
      ? listedPeers.flatMap((peer) => {
          const listing = lists[peer.id];
          return listing?.status === "ready"
            ? [{ peer, list: displayList(peer, listing.list) }]
            : [];
        })
      : [],
    results,
  );
  const unavailable = renderStatus
    ? listedPeers.filter((peer) => lists[peer.id]?.status === "unavailable")
    : [];
  const peers = searching
    ? listedPeers.filter((peer) => {
        const sessions = lists[peer.id];
        return (
          sessions?.status === "ready" &&
          sessions.list.sessions.some((session) => matches(session, query))
        );
      })
    : listedPeers;
  const canReorder =
    !renderStatus &&
    !searching &&
    accountKey !== null &&
    accountKey === peerOrderAccount &&
    online.length > 1;
  useEffect(() => {
    if (!canReorder) setDrag(null);
  }, [canReorder]);
  if (!renderStatus && searching && peers.length === 0) return null;
  if (signedOut && ((!renderStatus && searching) || signInNotice.dismissed)) return statusGroups;
  if (!signedOut && outdated && outdatedNotice.dismissed) return statusGroups;
  if (!signedOut && !outdated && (accountKey === null || (!connected && !connecting)))
    return statusGroups;
  if (renderStatus && connected && !signedOut && unavailable.length === 0) return statusGroups;
  const status = !connected
    ? roomStatus === "waiting" || lastOnline.current
      ? t("agentView.remote.reconnecting")
      : t("agentView.remote.connecting")
    : !renderStatus && peers.length === 0 && away.length === 0
      ? t("agentView.remote.noComputers")
      : null;
  const ids = canReorder ? orderPeers(online, peerOrder).map((peer) => peer.id) : [];
  const reorder: PeerReorder | undefined = canReorder
    ? {
        ids,
        drag,
        setDrag,
        move(moved, target, edge) {
          const view = useAgentViewStore.getState();
          const next = movePeer(
            room?.peers ?? [],
            view.peerOrder?.ids ?? [],
            ids,
            moved,
            target,
            edge,
          );
          view.setPeerOrder(accountKey, next);
        },
      }
    : undefined;
  return (
    <>
      {statusGroups}
      <section
        className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3"
        data-testid="remote-sessions"
      >
        {(!renderStatus || !connected || signedOut) && (
          <h3 className="px-2 pb-1 text-app-label uppercase text-muted-foreground">
            {t("agentView.remote.title")}
          </h3>
        )}
        {signedOut ? (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <span className="min-w-0 flex-1 break-keep text-app-ui-sm text-muted-foreground">
              {t("agentView.remote.needsSignIn")}
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-6 px-0 text-app-micro"
              onClick={() => useSettingsUIStore.getState().openSettingsAt("remote")}
            >
              {t("voice.signIn")}
            </Button>
            <BannerDismissButton dismiss={signInNotice.dismiss} />
          </div>
        ) : outdated ? (
          <OutdatedLine dismiss={outdatedNotice.dismiss} />
        ) : (
          <>
            {status && (
              <p role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
                {status}
              </p>
            )}
            {unavailable.map((peer) => (
              <p
                key={peer.id}
                role="status"
                className="px-2 py-1 text-app-ui-sm text-muted-foreground"
              >
                {peer.name} · {t("agentView.remote.unavailable")}
              </p>
            ))}
            {!renderStatus && (
              <div
                inert={!connected}
                className={cn(
                  "flex flex-col divide-y divide-border [&>*]:py-1.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0",
                  !connected && "opacity-60",
                )}
              >
                {peers.map((peer) => (
                  <PeerGroup
                    key={peer.id}
                    peer={peer}
                    sessions={lists[peer.id]}
                    results={results}
                    query={query}
                    reorder={reorder?.ids.includes(peer.id) ? reorder : undefined}
                  />
                ))}
                {away.map((peer) => (
                  <OfflinePeer key={peer.id} peer={peer} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

/** A computer of the account out of the room: greyed, its sessions out of reach until it is back. */
export function OfflinePeer({ peer }: { peer: RoomPeer }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-muted-foreground"
      data-testid="remote-peer-offline"
    >
      <ChevronRight aria-hidden className="size-3 shrink-0 opacity-40" />
      <Monitor aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate text-app-ui-sm">{peer.name}</span>
      <span className="min-w-0 truncate text-app-micro">
        {PLATFORMS[peer.platform] ?? peer.platform}
      </span>
      <span className="ml-auto shrink-0 text-app-micro whitespace-nowrap">
        {t("agentView.remote.offlineTag")}
      </span>
    </div>
  );
}

export function PeerGroup({
  peer,
  sessions,
  query,
  reorder,
  results,
}: {
  peer: RoomPeer;
  sessions: PeerSessions | undefined;
  query: string;
  reorder?: PeerReorder;
  results?: RemoteResults;
}) {
  const { t } = useTranslation();
  const folds = useAgentViewStore((s) => s.folded);
  const peerFoldKey = `peer:${peer.id}`;
  const workspaceFoldKey = (id: string) => `peer-ws:${peer.id}:${id}`;
  const reorderingRow = useSessionReordering(peer.id);
  const searching = query.trim() !== "";
  // The workspaces whose terminals with only their shell are shown, each
  // asked for on its own; not kept.
  const [terminalsIn, setTerminalsIn] = useState<ReadonlySet<string>>(() => new Set());
  const [worktreesIn, setWorktreesIn] = useState<ReadonlySet<string>>(() => new Set());
  // The session being renamed, while the dialog asks its new title.
  const [renaming, setRenaming] = useState<PeerSessionRef | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const folded = !searching && folds.has(peerFoldKey);
  const Chevron = folded ? ChevronRight : ChevronDown;
  const rawList = sessions?.status === "ready" ? sessions.list : null;
  const list =
    rawList && results
      ? {
          ...rawList,
          sessions: rawList.sessions.map((session) =>
            results.session(
              peer.id,
              session,
              peerSpeaks(peer, FAILURE_SCHEMA),
              peerServes(peer, "sessions.markSeen"),
            ),
          ),
        }
      : rawList;
  const root = useAgentViewStore((s) => s.root);
  // Where it lets this one open chats or terminals there, each workspace's heading has a +.
  const opens = peerServes(peer, "chat.control") || peerServes(peer, "terminal.control");
  const canReorder = !searching && peerServes(peer, "sessions.reorder");
  const ids = new Set([
    ...(list?.workspaces ?? []).map((workspace) => workspace.id),
    ...(list?.sessions ?? []).map((session) => session.workspaceId),
  ]);
  const workspaceFolds = new Set([...ids].filter((id) => folds.has(workspaceFoldKey(id))));
  const reordering = reorderingRow ? new Set([reorderingRow.workspaceId]) : undefined;
  const { groups, workspaces, plain, worktreeCounts, foldedWorkspaces, hiddenCounts } =
    workspaceGroups(list, {
      query,
      opens,
      inPanel: (s) => leafHolding(root, remoteSessionKey({ deviceId: peer.id, ...s })) !== null,
      worktreesIn,
      terminalsIn,
      folds: workspaceFolds,
      reordering,
    });
  const consents = usePeerConsents(peer.id, list?.consents);
  const counts = [
    [
      "attention",
      (list?.sessions.filter((s) => remoteGroupOf(s) === "attention").length ?? 0) +
        consents.length,
    ],
    ["running", list?.sessions.filter((s) => s.state === "running").length ?? 0],
  ] as const;
  const names = new Map(list?.workspaces.map((w) => [w.id, w.name]) ?? []);
  useEffect(() => {
    if (!rawList) return;
    setPendingOrders((pending) => {
      if (pending.size === 0) return pending;
      const next = new Map(pending);
      for (const [workspaceId, tabIds] of pending) {
        const rows = rawList.sessions.filter((session) => session.workspaceId === workspaceId);
        if (reorderSubset(rows, tabIds, tabIdOf) === rows) next.delete(workspaceId);
      }
      return next.size === pending.size ? pending : next;
    });
  }, [rawList]);

  const reorderIn =
    (workspaceId: string, rows: readonly RemoteSession[]): SessionReorder =>
    (moved, target, edge) => {
      const keys = rows.filter(canReorderSession).map(tabIdOf);
      const tabIds = moveKey(keys, moved, target, edge).filter((id, i) => id !== keys[i]);
      if (tabIds.length === 0) return;
      const preview = (order: readonly string[] | undefined) =>
        setPendingOrders((pending) => {
          if (order) return new Map(pending).set(workspaceId, order);
          if (pending.get(workspaceId) !== tabIds) return pending;
          const next = new Map(pending);
          next.delete(workspaceId);
          return next;
        });
      void reorderPeerSessions(peer.id, workspaceId, tabIds, preview).then((ok) => {
        // A later edit on the host can supersede a successful reorder before a watch sees it.
        if (ok) setTimeout(() => preview(undefined), ORDER_CONFIRM_MS);
      });
    };
  const headed = new Set(groups.map(([id]) => id));
  const renameRequest = useMemo<PromptRequest | null>(
    () =>
      renaming && {
        title: t("tabBar.rename_tab"),
        defaultValue: renaming.title,
        confirmLabel: t("action.save"),
      },
    [renaming, t],
  );
  const rowOf = (workspaceId: string, session: RemoteSession, reorder?: SessionReorder) => {
    const row = (
      <OpenRemoteSessionRow
        session={session}
        peer={peer}
        workspace={workspaces.get(workspaceId)}
        reorder={reorder}
        resultFeed={results}
      />
    );
    const ref: PeerSessionRef = {
      deviceId: peer.id,
      deviceName: peer.name,
      workspaceId,
      tabId: session.tabId,
      kind: session.kind,
      title: session.title,
    };
    // Renamed and closed as it is controlled: a chat with the chats, a terminal with the terminals.
    const controls = peerServes(
      peer,
      session.kind === "terminal" ? "terminal.control" : "chat.control",
    );
    return (
      <Fragment key={session.tabId}>
        {controls ? (
          <SessionMenu onRename={() => setRenaming(ref)} onClose={() => void closePeerSession(ref)}>
            {row}
          </SessionMenu>
        ) : (
          row
        )}
        <AgentRows agents={agentRunsOf(session.agents)} selectedId={undefined} className="pl-4" />
      </Fragment>
    );
  };

  return (
    <div className="flex flex-col" data-testid="remote-peer">
      <RemotePeerHeader
        id={peer.id}
        reorder={reorder}
        expanded={!folded}
        onToggle={() => useAgentViewStore.getState().toggleFolded(peerFoldKey)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-control) px-2 py-1 hover:bg-[var(--state-hover-bg)]"
      >
        <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <Monitor aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-app-ui-sm text-foreground">{peer.name}</span>
        <span className="min-w-0 truncate text-app-micro text-muted-foreground">
          {PLATFORMS[peer.platform] ?? peer.platform}
        </span>
        {folded && list && (
          <span className="ml-auto flex shrink-0 items-center gap-2 text-app-micro whitespace-nowrap tabular-nums">
            {counts.map(
              ([group, count]) =>
                count > 0 && (
                  <span
                    key={group}
                    className={cn("inline-flex items-center gap-0.5", GROUP_TINT[group])}
                    title={t(`agentList.group.${group}`)}
                    data-testid={`remote-peer-count-${group}`}
                  >
                    <StateGlyph state={GROUP_STATE[group]} still />
                    <span className="sr-only">{t(`agentList.group.${group}`)} </span>
                    {count}
                  </span>
                ),
            )}
          </span>
        )}
      </RemotePeerHeader>
      {!folded && (
        <div className="flex flex-col pl-3">
          {!sessions || sessions.status === "loading" ? (
            <p className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("agentView.remote.loading")}
            </p>
          ) : sessions.status === "unavailable" ? (
            <p className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("agentView.remote.unavailable")}
            </p>
          ) : (
            <>
              {/* What waits on the user there comes first: it runs out. */}
              {consents.length > 0 && (
                <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="remote-consents">
                  {consents.map((consent) => (
                    <PeerConsentCard
                      key={consent.id}
                      consent={consent}
                      deviceId={peer.id}
                      device={peer.name}
                      sessions={sessions.list.sessions}
                      workspaceName={
                        names.get(consent.workspaceId) ?? consent.workspaceId.slice(0, 8)
                      }
                    />
                  ))}
                </div>
              )}
              {groups.length === 0 ? (
                <p className="px-2 py-1 text-app-micro text-muted-foreground">
                  {t("agentView.remote.empty")}
                </p>
              ) : (
                groups.map(([workspaceId, rows]) => {
                  const pending = pendingOrders.get(workspaceId);
                  const ordered = pending ? reorderSubset(rows, pending, tabIdOf) : rows;
                  const orderRows =
                    rawList?.sessions.filter((session) => session.workspaceId === workspaceId) ??
                    rows;
                  const reorder =
                    canReorder && !pending && orderRows.filter(canReorderSession).length > 1
                      ? reorderIn(workspaceId, orderRows)
                      : undefined;
                  const terminals = plain.get(workspaceId) ?? [];
                  const unfolded = terminalsIn.has(workspaceId);
                  const workspace = workspaces.get(workspaceId);
                  const worktreeCount = worktreeCounts.get(workspaceId);
                  // A task hangs from a line under its workspace's folder, where
                  // that is listed (the computer lists a workspace's tasks right
                  // after it), so its rows read as its own, as the phone shows them.
                  const parent = workspace?.parentId;
                  const hung = parent !== undefined && workspaces.has(parent) && headed.has(parent);
                  const workspaceFolded = foldedWorkspaces.has(workspaceId);
                  const parentFolded = parent !== undefined && foldedWorkspaces.has(parent);
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: restores the fold when a native row drag leaves
                    <div
                      key={workspaceId}
                      onDragLeave={(event) => leaveWorkspaceReorder(event, peer.id, workspaceId)}
                      className={cn(
                        "flex flex-col not-first:mt-1.5",
                        hung && "ml-3.5 border-border border-l",
                      )}
                      data-task={hung ? "" : undefined}
                    >
                      <WorkspaceHeading
                        name={names.get(workspaceId) ?? workspaceId}
                        workspace={workspace}
                        onDragOver={
                          reorder
                            ? (event) => hoverWorkspaceReorder(event, workspaceId, peer.id)
                            : undefined
                        }
                        fold={
                          parentFolded
                            ? undefined
                            : {
                                folded: workspaceFolded,
                                hidden: hiddenCounts.get(workspaceId) ?? 0,
                                toggle: () =>
                                  useAgentViewStore
                                    .getState()
                                    .toggleFolded(workspaceFoldKey(workspaceId)),
                              }
                        }
                        worktrees={
                          workspaceFolded || worktreeCount === undefined
                            ? undefined
                            : {
                                count: worktreeCount,
                                open: worktreesIn.has(workspaceId),
                                toggle: () =>
                                  setWorktreesIn((now) => toggleWorkspace(now, workspaceId)),
                              }
                        }
                        terminals={
                          terminals.length > 0
                            ? {
                                count: terminals.length,
                                open: unfolded,
                                toggle: () =>
                                  setTerminalsIn((now) => toggleWorkspace(now, workspaceId)),
                              }
                            : undefined
                        }
                        menu={
                          opens && workspace ? (
                            <RemoteNewMenu peer={peer} workspace={workspace} />
                          ) : undefined
                        }
                      />
                      {unfolded && terminals.length > 0 && (
                        <HungTerminals
                          rows={terminals.map((session) => ({
                            key: session.tabId,
                            row: rowOf(workspaceId, session),
                          }))}
                        />
                      )}
                      {ordered.map((session) =>
                        rowOf(
                          workspaceId,
                          session,
                          canReorderSession(session) ? reorder : undefined,
                        ),
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      )}
      <PromptDialog
        request={renameRequest}
        busy={renameBusy}
        onCancel={() => setRenaming(null)}
        onConfirm={(title) => {
          if (!renaming) return;
          setRenameBusy(true);
          void renamePeerSession(renaming, title).then(() => {
            setRenameBusy(false);
            setRenaming(null);
          });
        }}
      />
    </div>
  );
}

export function OpenRemoteSessionRow({
  session,
  peer,
  workspace,
  reorder,
  resultFeed,
  showContext,
  ...buttonProps
}: {
  session: RemoteSession;
  peer: RoomPeer;
  workspace?: RemoteWorkspace;
  reorder?: SessionReorder;
  resultFeed?: RemoteResults;
  showContext?: boolean;
} & Omit<ComponentProps<"button">, "type" | "onClick" | "children" | "title">) {
  const where = useAgentViewStore((s) =>
    panelPlaceOf(s.root, remoteSessionKey({ deviceId: peer.id, ...session })),
  );
  return (
    <RemoteSessionRow
      {...buttonProps}
      session={session}
      deviceId={peer.id}
      onReorder={reorder}
      where={where}
      context={
        showContext
          ? { device: peer.name, workspace: workspace?.name ?? session.workspaceId }
          : undefined
      }
      onOpen={() => {
        const ask = askOf(session);
        useRemoteViewStore.getState().open({
          deviceId: peer.id,
          deviceName: peer.name,
          workspaceId: session.workspaceId,
          workspaceName: workspace?.name ?? session.workspaceId,
          path: workspace?.path ?? "",
          tabId: session.tabId,
          kind: session.kind,
          title: session.title,
          state: session.state,
          ...(session.profile ? { profile: session.profile } : {}),
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(ask ? { ask } : {}),
        });
        resultFeed?.markSeen([
          { deviceId: peer.id, session, hostReceipts: peerServes(peer, "sessions.markSeen") },
        ]);
      }}
    />
  );
}

/**
 * A session's row with its right-click menu: renaming it there, and
 * closing it. Each runs once the menu has let go of the keyboard, for the
 * dialog it opens to take it.
 */
function SessionMenu({
  onRename,
  onClose,
  children,
}: {
  onRename: () => void;
  onClose: () => void;
  children: ReactElement;
}) {
  const handoff = useContextMenuHandoff();
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handoff.onCloseAutoFocus}>
        <ContextMenuItems
          items={remoteSessionMenu({
            rename: () => handoff.defer(onRename),
            close: () => handoff.defer(onClose),
          })}
        />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

/** The right-click menu of another computer's session: rename, then close, as a tab's here. */
export function remoteSessionMenu(actions: { rename(): void; close(): void }): MenuItemSpec[] {
  return [
    { kind: "item", label: i18next.t("tabBar.rename_tab_menu"), onSelect: actions.rename },
    { kind: "separator" },
    { kind: "item", label: i18next.t("tabBar.close"), onSelect: actions.close },
  ];
}

type WorkspaceDisclosure = { count: number; open: boolean; toggle(): void };

/** A workspace's heading, with its git status, disclosures, and new-session menu. */
function WorkspaceHeading({
  name,
  workspace,
  fold,
  worktrees,
  terminals,
  menu,
  onDragOver,
}: {
  name: string;
  workspace: RemoteWorkspace | undefined;
  fold?: { folded: boolean; hidden: number; toggle(): void };
  worktrees?: WorkspaceDisclosure;
  terminals?: WorkspaceDisclosure;
  menu?: ReactNode;
  onDragOver?: ComponentProps<"div">["onDragOver"];
}) {
  const { t } = useTranslation();
  const Icon = workspace?.parentId ? GitBranch : Folder;
  const Chevron = fold?.folded ? ChevronRight : ChevronDown;
  const git = workspace?.git;
  const stands = git
    ? [
        git.branch ?? "",
        git.ahead > 0 ? `↑${git.ahead}` : "",
        git.behind > 0 ? `↓${git.behind}` : "",
        git.uncommitted > 0 ? "●" : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const title = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-semibold text-app-micro text-foreground">{name}</span>
    </>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering during a native row drag reveals its drop targets
    <div
      onDragOver={onDragOver}
      className="flex min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5"
      data-testid="remote-workspace"
    >
      {fold ? (
        <button
          type="button"
          aria-expanded={!fold.folded}
          onClick={fold.toggle}
          className="flex min-w-0 items-center gap-1.5 rounded-(--radius-control) text-left outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="remote-workspace-fold"
        >
          {title}
          <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">{title}</span>
      )}
      {/* The git status takes the space left by the name and controls. */}
      {stands && (
        <span className="w-0 grow truncate font-mono text-app-micro text-muted-foreground">
          {stands}
        </span>
      )}
      {fold && fold.hidden > 0 && <HiddenSessionCount count={fold.hidden} />}
      {(worktrees || terminals || menu) && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {worktrees && (
            <DisclosureChip
              disclosure={worktrees}
              icon={GitBranch}
              label={t(
                worktrees.open
                  ? "agentView.remote.worktreesHide"
                  : "agentView.remote.worktreesShow",
                { count: worktrees.count, workspace: name },
              )}
              testId="remote-worktrees-toggle"
              workspaceId={workspace?.id}
            />
          )}
          {terminals && (
            <DisclosureChip
              disclosure={terminals}
              icon={SquareTerminal}
              label={
                terminals.open
                  ? t("agentView.remote.terminalsHide")
                  : t("agentView.remote.terminalsShow", { count: terminals.count })
              }
              testId="remote-terminals-toggle"
              workspaceId={workspace?.id}
            />
          )}
          {menu}
        </span>
      )}
    </div>
  );
}

function DisclosureChip({
  disclosure: { count, open, toggle },
  icon: Icon,
  label,
  testId,
  workspaceId,
}: {
  disclosure: WorkspaceDisclosure;
  icon: typeof GitBranch;
  label: string;
  testId: string;
  workspaceId: string | undefined;
}) {
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={toggle}
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-app-micro whitespace-nowrap text-(--state-selected-indicator) tabular-nums hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid={testId}
      data-workspace={workspaceId}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {count}
      <Chevron aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/**
 * A workspace's terminals with only their shell, asked for: right under its
 * heading, set in past a tree's line that comes down from the heading's icon
 * and branches to each, so whose they are reads at once.
 */
export function HungTerminals({ rows }: { rows: { key: string; row: ReactNode }[] }) {
  return (
    <div className="flex flex-col" data-testid="remote-hung-terminals">
      {rows.map(({ key, row }, i) => {
        const last = i === rows.length - 1;
        return (
          <div key={key} className="relative pl-5">
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute left-3.5 border-border border-l",
                // The first comes up to the icon, past the heading's space under it.
                i === 0 ? "-top-1" : "top-0",
                last ? "bottom-1/2 w-2.5 rounded-bl-sm border-b" : "bottom-0",
              )}
            />
            {!last && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3.5 w-2.5 border-border border-t"
              />
            )}
            {row}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Another computer's session's agents as this computer's rows read them:
 * what it tells of each, with no tools (nothing opens from them).
 */
export function agentRunsOf(agents: readonly RemoteSessionAgent[] | undefined): AgentRun[] {
  return (agents ?? []).map((agent) => ({
    id: agent.id,
    kind: agent.kind,
    ...(agent.program ? { program: agent.program } : {}),
    ...(agent.type ? { type: agent.type } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    state: agent.state,
    start: agent.start,
    tools: [],
    toolCount: 0,
    failedCount: 0,
  }));
}

/**
 * A session's row: its state, kind and title, and what it waits on the
 * user for or last said. What else a button takes (a menu's trigger's
 * props) goes to it.
 */
export function RemoteSessionRow({
  session,
  where = null,
  deviceId,
  onReorder,
  onOpen,
  context,
  className,
  ...rest
}: {
  session: RemoteSession;
  /** Where the agent view's panels have it, which its mark tells; none where they do not. */
  where?: PanelPlace | null;
  deviceId?: string;
  onReorder?: SessionReorder;
  onOpen?: () => void;
  context?: { device: string; workspace: string };
} & Omit<ComponentProps<"button">, "type" | "onClick" | "children" | "title">) {
  const { t, i18n } = useTranslation();
  const group = remoteGroupOf(session);
  const duration = useDurationLabel(session.since);
  const Icon =
    session.kind === "claude" ? ClaudeIcon : session.kind === "codex" ? CodexIcon : SquareTerminal;
  const state = t(`agentView.remote.state.${session.state}`);
  const message =
    session.waiting?.text ??
    (session.limitWait
      ? t("chat.limit_resume.status", {
          time: resumeTimeText(session.limitWait.at, Date.now(), i18n.language),
        })
      : session.last);
  const dragRow = { key: session.tabId, deviceId, workspaceId: session.workspaceId };
  const { edge, dropProps } = useSessionDrop(dragRow, onReorder);
  return (
    <button
      type="button"
      {...rest}
      {...(onReorder && {
        ...dropProps,
        draggable: true,
        onDragStart: (event) => startSessionDrag(event, dragRow),
        onDragEnd: endSessionDrag,
      })}
      onClick={onOpen}
      aria-current={where === "shown" || undefined}
      className={cn(
        "relative flex min-w-0 flex-col rounded-(--radius-control) px-2 py-1 text-left",
        where === "shown" ? PANEL_SHOWN_BG : "hover:bg-[var(--state-hover-bg)]",
        // Its right-click menu open.
        "data-[state=open]:bg-[var(--state-hover-bg)]",
        className,
      )}
      title={session.last ? `${session.title}\n${session.last}` : session.title}
      data-testid="remote-session-row"
    >
      <SidebarDropIndicator edge={edge} testId="remote-session-drop" />
      {where && (
        <PanelMark where={where} className="top-1 bottom-1" testId="remote-session-panel" />
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        {!context && !session.failed && (
          <StateGlyph state={GROUP_STATE[group]} className={GROUP_TINT[group]} />
        )}
        {!session.failed && <span className="sr-only">{state}</span>}
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate text-app-ui-sm text-foreground">{session.title}</span>
        {(session.failed || duration) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {session.failed && <FailureLabel />}
            {duration && (
              <span className="text-app-micro whitespace-nowrap tabular-nums text-muted-foreground">
                {duration}
              </span>
            )}
          </span>
        )}
      </span>
      {(context || message) && (
        <span className="flex min-w-0 items-center gap-1.5 pl-4.5 text-app-micro text-muted-foreground">
          {context && (
            <>
              <DeviceChip name={context.device} className="shrink-0" />
              <span className="max-w-[40%] shrink-0 truncate" title={context.workspace}>
                {context.workspace}
              </span>
            </>
          )}
          {message && (
            <span
              className={cn(
                "min-w-0 truncate",
                session.failed
                  ? "text-(--state-error-fg)"
                  : session.waiting && "text-(--state-warning-fg)",
              )}
            >
              {message}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** The computer a tab's session runs on, as a chip. */
export function DeviceChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex max-w-24 min-w-0 items-center gap-1 overflow-hidden rounded-full border border-border px-1.5 text-app-micro whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <Monitor aria-hidden className="size-2.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * A tab's face for another computer's session: the computer (unless the
 * panel shows it once for all), the kind of session, its title, and its
 * state while it is active or its terminal has ended.
 */
export function RemoteTabLabel({
  target,
  showDevice = true,
}: {
  target: RemoteTarget;
  showDevice?: boolean;
}) {
  const { t } = useTranslation();
  const Icon =
    target.kind === "claude" ? ClaudeIcon : target.kind === "codex" ? CodexIcon : SquareTerminal;
  const { state } = target;
  const group = state ? GROUP_OF[state] : "idle";
  const ended = target.kind === "terminal" && state === "ended";
  return (
    <>
      {showDevice && <DeviceChip name={target.deviceName} />}
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{target.title}</span>
      {state && (ended || group !== "idle") && (
        <span
          role="img"
          aria-label={t(`agentView.remote.state.${state}`)}
          className="inline-flex shrink-0"
        >
          <StateGlyph state={ended ? "exited" : GROUP_STATE[group]} className={GROUP_TINT[group]} />
        </span>
      )}
    </>
  );
}
