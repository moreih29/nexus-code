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
} from "../../../../packages/remote-protocol/src/rpc";
import type { AgentRun } from "../../../shared/claude/activity";
import { type RemoteAccountState, SIGNUP_FAILURES } from "../../../shared/remote/account";
import type { RoomPeer, RoomState } from "../../../shared/remote/room";
import { boundedPeerFoldKey } from "../../../shared/types/agent-view";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import type { AgentSession } from "../../services/agent-sessions/model";
import {
  compareStatusTime,
  groupOf,
  listed,
  matchesQuery,
  ROW_GROUPS,
} from "../../services/agent-sessions/rows";
import { type SessionTreeNode, treeSessions } from "../../services/agent-sessions/session-tree";
import { leafHolding, remoteSessionKey } from "../../services/agent-view/layout";
import { movePeer, orderPeers, reorderSubset } from "../../services/agent-view/order";
import { type RemoteResults, useRemoteResults } from "../../services/agent-view/remote-results";
import {
  GROUP_OF,
  remoteGroupOf,
  remoteSessionTree,
} from "../../services/agent-view/remote-session-tree";
import { moveSessionRoot } from "../../services/agent-view/sidebar-tree";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { remoteAccountKey, useRemoteAccount } from "../../services/remote/account";
import { remoteDisplayName, remoteTitle } from "../../services/remote/display-name";
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
import {
  listedRemoteTarget,
  type OpenRemoteSession,
  openRemoteSession,
  type RemoteTarget,
} from "../../state/stores/remote-view";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { cn } from "../../utils/cn";
import { AgentRows } from "../agent-list/agent-rows";
import { PlaceTag, type RowPlace, rowShellClass, SessionRowLines } from "../agent-list/session-row";
import {
  FailureLabel,
  HiddenSessionCount,
  LookGlyph,
  StateGlyph,
  useDurationLabel,
  WaitSign,
} from "../agent-list/session-status";
import { FoldChevron } from "../agent-list/session-tree-rows";
import { GROUP_STATE, GROUP_TINT, remoteStateLook } from "../agent-list/state-look";
import { TaskRowLine } from "../agent-list/task-row-line";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { OutdatedLine } from "../settings/panels/remote-outdated";
import { type ShownSignInFailure, SignInNotice } from "../settings/panels/sign-in-notice";
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
import { ConsentPages, PeerConsentCard, usePeerConsents } from "./remote-consents";
import { RemoteNewMenu } from "./remote-new-menu";
import { type PeerDrag, type PeerReorder, RemotePeerHeader } from "./remote-peer-header";
import {
  closePeerSession,
  type PeerSessionRef,
  renamePeerSession,
  reorderPeerSessions,
} from "./remote-session-actions";
import {
  type RemoteRowTree,
  RemoteSessionBranch,
  type RemoteTreeNavigation,
} from "./remote-session-branch";
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

const PLATFORMS = new Map([
  ["darwin", "macOS"],
  ["win32", "Windows"],
  ["linux", "Linux"],
]);
const ORDER_CONFIRM_MS = 18_000;
const tabIdOf = (session: RemoteSession) => session.tabId;

function canReorderSession(session: RemoteSession): boolean {
  return session.state !== "ended" && (session.kind !== "terminal" || session.agent !== undefined);
}

export { GROUP_OF } from "../../services/agent-view/remote-session-tree";

export const FAILURE_SCHEMA = "0.22.0";

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
  return (
    remoteTitle(session.title).toLowerCase().includes(q) ||
    (session.last ?? "").toLowerCase().includes(q)
  );
}

export type RemoteStatusSource = {
  peer: RoomPeer;
  list: SessionsList;
  navigation?: RemoteTreeNavigation;
};

export type StatusRow =
  | { kind: "local"; session: AgentSession }
  | {
      kind: "remote";
      session: RemoteSession;
      peer: RoomPeer;
      node: SessionTreeNode;
      byKey: ReadonlyMap<string, RemoteSession>;
      workspaces: ReadonlyMap<string, RemoteWorkspace>;
      navigation?: RemoteTreeNavigation;
    };

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
    const visible = list.sessions.filter(listedByDefault);
    const { roots, byKey } = remoteSessionTree(peer.id, visible, query, list.sessions);
    for (const node of roots) {
      const session = byKey.get(node.session.key);
      if (!session) continue;
      byGroup.get(node.group)?.push({
        kind: "remote",
        session,
        peer,
        node,
        byKey,
        workspaces,
        navigation: source.navigation,
      });
    }
    for (const consent of list.consents ?? []) {
      if (!pending(peer.id, consent.id)) continue;
      if (
        searching &&
        !visible.some(
          (session) => session.workspaceId === consent.workspaceId && matches(session, query),
        )
      )
        continue;
      consents.push({ consent, source, workspace: workspaces.get(consent.workspaceId) });
    }
  }
  const since = (row: StatusRow) => (row.kind === "remote" ? row.node.since : row.session.since);
  for (const { group, rows } of groups)
    rows.sort((a, b) => compareStatusTime(group, since(a), since(b)));
  return { groups, consents };
}

export function workspaceGroups(
  list: SessionsList | null,
  {
    query,
    deviceId = "",
    opens,
    inPanel,
    worktreesIn,
    terminalsIn,
    folds,
    reordering,
  }: {
    query: string;
    deviceId?: string;
    opens: boolean;
    inPanel: (session: RemoteSession) => boolean;
    worktreesIn: ReadonlySet<string>;
    terminalsIn?: ReadonlySet<string>;
    folds?: ReadonlySet<string>;
    reordering?: ReadonlySet<string>;
  },
) {
  const searching = query.trim().length > 0;
  const sessions = list?.sessions ?? [];
  const { listed, plain } = listedSessions(sessions, "", inPanel);
  const { roots, byKey } = remoteSessionTree(
    deviceId,
    listed.filter(listedByDefault),
    query,
    sessions,
  );
  const keyOf = (session: RemoteSession) => remoteSessionKey({ deviceId, ...session });
  const branches = new Map(roots.map((node) => [node.session.key, node]));
  const workspaces = new Map(list?.workspaces.map((w) => [w.id, w]) ?? []);
  const byWorkspace = new Map<string, RemoteSession[]>(
    [...workspaces.keys()].map((id) => [id, []]),
  );
  const hosts = new Set<string>();
  for (const root of roots) {
    for (const child of treeSessions(root.children)) {
      if (
        child.workspaceId !== root.session.workspaceId &&
        workspaces.get(child.workspaceId)?.parentId
      )
        hosts.add(child.workspaceId);
    }
  }
  const shownRoots = new Set(branches.keys());
  const panelShells = new Set(listed.filter((session) => !listedByDefault(session)).map(keyOf));
  for (const session of sessions) {
    const rows = byWorkspace.get(session.workspaceId) ?? [];
    byWorkspace.set(session.workspaceId, rows);
    const key = keyOf(session);
    const showFlat =
      !byKey.has(key) && (searching ? matches(session, query) : panelShells.has(key));
    if (shownRoots.delete(key) || showFlat) rows.push(session);
  }
  const groupOfRoot = (session: RemoteSession) =>
    branches.get(keyOf(session))?.group ?? remoteGroupOf(session);
  const eligible = new Set<string>();
  const worktreeCounts = new Map<string, number>();
  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  const plainShown = searching ? new Map<string, RemoteSession[]>() : new Map(plain);
  const foldedWorkspaces = new Set(
    [...byWorkspace.keys()].filter((id) => !searching && !reordering?.has(id) && folds?.has(id)),
  );
  const keepsWorktreeVisible = (s: RemoteSession) =>
    groupOfRoot(s) !== "idle" ||
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
    const terminals = plainShown.get(id);
    const hosting = !searching && hosts.has(id);
    if (rows.length === 0 && !terminals && !canStart && !hosting) continue;
    eligible.add(id);
    if (rootParent && !searching) eligible.add(rootParent.id);

    const parentFolded =
      rootParent && !searching && !reordering?.has(id) && folds?.has(rootParent.id);
    const ownFolded = foldedWorkspaces.has(id);
    if (parentFolded || ownFolded) {
      const visible = rows.filter((session) => groupOfRoot(session) !== "idle");
      byWorkspace.set(id, visible);
      plainShown.delete(id);
      const owner = parentFolded ? rootParent.id : id;
      const disclosedTerminals = terminalsIn?.has(id) ? (terminals?.length ?? 0) : 0;
      const count = rows.reduce(
        (total, row) =>
          groupOfRoot(row) === "idle" ? total + 1 + (branches.get(keyOf(row))?.count ?? 0) : total,
        disclosedTerminals,
      );
      hiddenCounts.set(owner, (hiddenCounts.get(owner) ?? 0) + count);
      if (parentFolded && visible.length === 0) hidden.add(id);
    }

    if (searching || !rootParent || parentFolded || reordering?.has(id)) continue;
    if (rows.some(keepsWorktreeVisible) || terminals?.some(keepsWorktreeVisible)) continue;
    worktreeCounts.set(rootParent.id, (worktreeCounts.get(rootParent.id) ?? 0) + 1);
    if (!worktreesIn.has(rootParent.id)) hidden.add(id);
  }

  const groups = [...byWorkspace].filter(([id]) => eligible.has(id) && !hidden.has(id));
  return {
    groups,
    workspaces,
    branches,
    byKey,
    plain: plainShown,
    worktreeCounts,
    foldedWorkspaces,
    hiddenCounts,
  };
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
      selfId={account?.status === "signed-in" ? account.device.id : undefined}
      signedOut={account?.status === "signed-out" ? account : undefined}
      query={query}
      shown={shown}
      renderStatus={renderStatus}
    />
  );
}

const NOTICE_FAILURES: readonly ShownSignInFailure[] = [...SIGNUP_FAILURES, "not_invited"];

function SignInLink() {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-6 px-0 text-app-micro"
      onClick={() => useSettingsUIStore.getState().openSettingsAt("remote")}
    >
      {t("voice.signIn")}
    </Button>
  );
}

function AccountRemoteSessions({
  accountKey,
  selfId,
  signedOut,
  query,
  shown,
  renderStatus,
}: {
  accountKey: string | null;
  selfId?: string;
  signedOut: Extract<RemoteAccountState, { status: "signed-out" }> | undefined;
  query: string;
  shown: boolean;
  renderStatus?: RenderStatus;
}) {
  const { t } = useTranslation(["common", "settings"]);
  const room = useRemoteRoom();
  const seen = useShownRoom(room);
  const roomStatus = seen?.status;
  const outdated = roomStatus === "outdated";
  const signInFailure = NOTICE_FAILURES.find((failure) => failure === signedOut?.failure);
  const signInNotice = useBannerDismissal(
    ["remote-sessions-sign-in"],
    signedOut ? [signInFailure ?? true] : undefined,
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
  const navigation = useMemo<RemoteTreeNavigation>(
    () => ({
      selfId,
      peers: new Map(room?.peers.map((peer) => [peer.id, peer])),
      connected: room?.status === "online",
    }),
    [room, selfId],
  );
  const displayedRoom =
    connected && (roomOnline || (seen?.peers.length ?? 0) > 0)
      ? seen
      : (lastOnline.current ?? seen);
  const searching = query.trim() !== "";
  const away = searching ? [] : orderPeers(offlinePeers(displayedRoom), peerOrder);
  const online = servingPeers(room);
  const lists = usePeerSessions(
    online.map((peer) => peer.id),
    shown,
  );
  const listingFor = (id: string) => (Object.hasOwn(lists, id) ? lists[id] : undefined);
  const results = useRemoteResults(online, shown, accountKey);
  const listedPeers = orderPeers(servingPeers(displayedRoom), peerOrder).filter(
    (peer) => connected || listingFor(peer.id)?.status === "ready",
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
          const listing = listingFor(peer.id);
          return listing?.status === "ready"
            ? [{ peer, list: displayList(peer, listing.list), navigation }]
            : [];
        })
      : [],
    results,
  );
  const unavailable = renderStatus
    ? listedPeers.filter((peer) => listingFor(peer.id)?.status === "unavailable")
    : [];
  const peers = searching
    ? listedPeers.filter((peer) => {
        const sessions = listingFor(peer.id);
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
        {signedOut && signInFailure ? (
          <div className="px-2 py-1">
            <SignInNotice
              compact
              failure={signInFailure}
              actions={<SignInLink />}
              dismiss={<BannerDismissButton dismiss={signInNotice.dismiss} className="-my-0.5" />}
            />
          </div>
        ) : signedOut ? (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <span className="min-w-0 flex-1 break-keep text-app-ui-sm text-muted-foreground">
              {t("agentView.remote.needsSignIn")}
            </span>
            <SignInLink />
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
                {remoteDisplayName(peer.name)} · {t("agentView.remote.unavailable")}
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
                    sessions={listingFor(peer.id)}
                    results={results}
                    navigation={navigation}
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

export function OfflinePeer({ peer }: { peer: RoomPeer }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 py-1 pr-2 pl-1 text-muted-foreground"
      data-testid="remote-peer-offline"
    >
      <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-40" />
      <Monitor aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate text-app-ui-sm">{remoteDisplayName(peer.name)}</span>
      <span className="min-w-0 truncate text-app-micro">
        {PLATFORMS.get(peer.platform) ?? remoteDisplayName(peer.platform)}
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
  navigation,
}: {
  peer: RoomPeer;
  sessions: PeerSessions | undefined;
  query: string;
  reorder?: PeerReorder;
  results?: RemoteResults;
  navigation?: RemoteTreeNavigation;
}) {
  const { t } = useTranslation();
  const folds = useAgentViewStore((s) => s.folded);
  const peerFoldKey = boundedPeerFoldKey(`peer:${peer.id}`);
  const workspaceFoldKey = (id: string) => boundedPeerFoldKey(`peer-ws:${peer.id}:${id}`);
  const reorderingRow = useSessionReordering(peer.id);
  const searching = query.trim() !== "";
  const [terminalsIn, setTerminalsIn] = useState<ReadonlySet<string>>(() => new Set());
  const [worktreesIn, setWorktreesIn] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<PeerSessionRef | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const folded = !searching && folds.has(peerFoldKey);
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
  const opens = peerServes(peer, "chat.control") || peerServes(peer, "terminal.control");
  const canReorder = !searching && peerServes(peer, "sessions.reorder");
  const ids = new Set([
    ...(list?.workspaces ?? []).map((workspace) => workspace.id),
    ...(list?.sessions ?? []).map((session) => session.workspaceId),
  ]);
  const workspaceFolds = new Set([...ids].filter((id) => folds.has(workspaceFoldKey(id))));
  const reordering = reorderingRow ? new Set([reorderingRow.workspaceId]) : undefined;
  const {
    groups,
    workspaces,
    branches,
    byKey,
    plain,
    worktreeCounts,
    foldedWorkspaces,
    hiddenCounts,
  } = workspaceGroups(list, {
    query,
    deviceId: peer.id,
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

  const isDraggableRoot = (session: RemoteSession) =>
    canReorderSession(session) && branches.has(remoteSessionKey({ deviceId: peer.id, ...session }));
  const reorderIn =
    (workspaceId: string, rows: readonly RemoteSession[]): SessionReorder =>
    (moved, target, edge) => {
      const keys = rows.filter(canReorderSession).map(tabIdOf);
      const roots = rows.filter(isDraggableRoot).map(tabIdOf);
      const tabIds = moveSessionRoot(keys, roots, moved, target, edge).filter(
        (id, i) => id !== keys[i],
      );
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
  const rowOf = (
    workspaceId: string,
    session: RemoteSession,
    reorder?: SessionReorder,
    tree?: RemoteRowTree,
  ) => {
    const row = (
      <OpenRemoteSessionRow
        session={session}
        peer={peer}
        workspace={workspaces.get(workspaceId)}
        reorder={reorder}
        resultFeed={results}
        tree={tree}
      />
    );
    const ref: PeerSessionRef = {
      deviceId: peer.id,
      deviceName: remoteDisplayName(peer.name),
      workspaceId,
      tabId: session.tabId,
      kind: session.kind,
      title: remoteDisplayName(session.title),
    };
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
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-control) py-1 pr-2 pl-1 hover:bg-[var(--state-hover-bg)]"
      >
        <FoldChevron folded={folded} />
        <Monitor aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-app-ui-sm text-foreground">
          {remoteDisplayName(peer.name)}
        </span>
        <span className="min-w-0 truncate text-app-micro text-muted-foreground">
          {PLATFORMS.get(peer.platform) ?? remoteDisplayName(peer.platform)}
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
              {consents.length > 0 && (
                <div className="flex flex-col px-1 py-1" data-testid="remote-consents">
                  <ConsentPages>
                    {consents.map((consent) => (
                      <PeerConsentCard
                        key={consent.id}
                        consent={consent}
                        deviceId={peer.id}
                        device={remoteDisplayName(peer.name)}
                        sessions={sessions.list.sessions}
                        workspaceName={
                          names.get(consent.workspaceId) ?? consent.workspaceId.slice(0, 8)
                        }
                      />
                    ))}
                  </ConsentPages>
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
                    canReorder && !pending && orderRows.filter(isDraggableRoot).length > 1
                      ? reorderIn(workspaceId, orderRows)
                      : undefined;
                  const terminals = plain.get(workspaceId) ?? [];
                  const unfolded = terminalsIn.has(workspaceId);
                  const workspace = workspaces.get(workspaceId);
                  const worktreeCount = worktreeCounts.get(workspaceId);
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
                      {ordered.map((session) => {
                        const key = remoteSessionKey({ deviceId: peer.id, ...session });
                        const node = branches.get(key);
                        return node ? (
                          <RemoteSessionBranch
                            key={key}
                            root={node}
                            folded={folds}
                            searching={searching}
                            navigation={navigation}
                            workspaceOf={(id) => workspaces.get(id)}
                            renderRow={(branch, tree) => {
                              const row = byKey.get(branch.session.key);
                              return (
                                row &&
                                rowOf(
                                  row.workspaceId,
                                  row,
                                  branch.depth === 0 && canReorderSession(row)
                                    ? reorder
                                    : undefined,
                                  tree,
                                )
                              );
                            }}
                          />
                        ) : (
                          rowOf(workspaceId, session)
                        );
                      })}
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
  tree,
  compact,
  onOpenSession,
  ...buttonProps
}: {
  compact?: boolean;
  session: RemoteSession;
  peer: RoomPeer;
  workspace?: RemoteWorkspace;
  reorder?: SessionReorder;
  resultFeed?: RemoteResults;
  showContext?: boolean;
  tree?: RemoteRowTree;
  onOpenSession?: OpenRemoteSession;
} & Omit<ComponentProps<"button">, "type" | "onClick" | "children" | "title">) {
  const where = useAgentViewStore((s) =>
    onOpenSession
      ? undefined
      : panelPlaceOf(s.root, remoteSessionKey({ deviceId: peer.id, ...session })),
  );
  const top = showContext && (tree === undefined || tree.depth === 0);
  const placed = top ? workspace : tree?.elsewhere;
  return (
    <RemoteSessionRow
      data-agent-row=""
      {...buttonProps}
      session={session}
      compact={compact}
      deviceId={peer.id}
      onReorder={reorder}
      where={where}
      device={top ? remoteDisplayName(peer.name) : undefined}
      place={
        placed
          ? remotePlace(placed)
          : top
            ? { kind: "workspace", name: remoteDisplayName(session.workspaceId) }
            : undefined
      }
      parent={tree?.parent}
      family={tree?.family}
      onOpen={() => {
        (onOpenSession ?? openRemoteSession)(listedRemoteTarget(peer, workspace, session));
        resultFeed?.markSeen([
          { deviceId: peer.id, session, hostReceipts: peerServes(peer, "sessions.markSeen") },
        ]);
      }}
    />
  );
}

export function remotePlace(workspace: RemoteWorkspace): RowPlace {
  return workspace.parentId !== undefined
    ? { kind: "branch", name: remoteDisplayName(workspace.git?.branch ?? workspace.name) }
    : { kind: "workspace", name: remoteDisplayName(workspace.name) };
}

export function SessionMenu({
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

export function remoteSessionMenu(actions: { rename(): void; close(): void }): MenuItemSpec[] {
  return [
    { kind: "item", label: i18next.t("tabBar.rename_tab_menu"), onSelect: actions.rename },
    { kind: "separator" },
    { kind: "item", label: i18next.t("tabBar.close"), onSelect: actions.close },
  ];
}

type WorkspaceDisclosure = { count: number; open: boolean; toggle(): void };

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
      {fold ? (
        <FoldChevron folded={fold.folded} className="size-3" />
      ) : (
        <span aria-hidden className="size-3 shrink-0" />
      )}
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-semibold text-app-micro text-foreground">{name}</span>
      {stands && (
        <span className="w-0 grow truncate font-mono text-app-micro text-muted-foreground">
          {stands}
        </span>
      )}
      {fold && fold.hidden > 0 && <HiddenSessionCount count={fold.hidden} />}
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
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) text-left outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="remote-workspace-fold"
        >
          {title}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{title}</span>
      )}
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

const MARK_TINT: Partial<Record<RemoteSession["kind"], string>> = {
  terminal: "text-muted-foreground",
};

export function RemoteSessionRow({
  session,
  where = null,
  deviceId,
  onReorder,
  onOpen,
  device,
  place,
  parent,
  family,
  compact,
  className,
  ...rest
}: {
  session: RemoteSession;
  compact?: boolean;
  where?: PanelPlace | null;
  deviceId?: string;
  onReorder?: SessionReorder;
  onOpen?: () => void;
  device?: string;
  place?: RowPlace;
  parent?: ReactNode;
  family?: ReactNode;
} & Omit<ComponentProps<"button">, "type" | "onClick" | "children" | "title">) {
  const { t, i18n } = useTranslation();
  const group = remoteGroupOf(session);
  const duration = useDurationLabel(session.since);
  const title = remoteTitle(session.title);
  const Icon =
    session.kind === "claude" ? ClaudeIcon : session.kind === "codex" ? CodexIcon : SquareTerminal;
  const selected = where === "shown" || rest["aria-current"] === true;
  const state = t(remoteStateLook(session.state).labelKey);
  const message =
    session.waiting?.text ??
    (session.limitWait
      ? t("chat.limit_resume.status", {
          time: resumeTimeText(session.limitWait.at, Date.now(), i18n.language),
        })
      : session.last);
  const dragRow = { key: session.tabId, deviceId, workspaceId: session.workspaceId };
  const { edge, dropProps } = useSessionDrop(dragRow, onReorder);
  const sign = session.failed ? (
    <FailureLabel />
  ) : session.state === "needs-you" ? (
    <WaitSign
      kind={session.waiting?.kind}
      label={session.waiting ? `${state} · ${t(`agentList.wait.${session.waiting.kind}`)}` : state}
      testId="remote-session-wait"
    />
  ) : (
    <span role="img" aria-label={state} title={state} className="inline-flex">
      <LookGlyph look={remoteStateLook(session.state)} />
    </span>
  );
  if (compact) {
    const lively = group === "attention" || group === "running" || group === "done";
    return (
      <TaskRowLine
        {...rest}
        mark={<Icon aria-hidden className={cn("size-3.5 shrink-0", MARK_TINT[session.kind])} />}
        title={title}
        tooltip={session.last ? `${title}\n${session.last}` : title}
        emphasized={lively}
        tags={
          (place || parent) && (
            <>
              {place && <PlaceTag place={place} testId="remote-session-place" />}
              {parent}
            </>
          )
        }
        family={family}
        sign={sign}
        duration={duration}
        durationClass={
          group === "attention" || group === "done" ? GROUP_TINT[group] : "text-muted-foreground"
        }
        selected={selected}
        aria-current={selected || rest["aria-current"]}
        onSelect={() => onOpen?.()}
        testId="remote-session-task-row"
      />
    );
  }
  return (
    <div
      {...(onReorder && dropProps)}
      className={cn(
        rowShellClass({ attention: group === "attention", selected: selected && PANEL_SHOWN_BG }),
        className,
      )}
      data-testid="remote-session-item"
    >
      <SidebarDropIndicator edge={edge} testId="remote-session-drop" />
      {where && <PanelMark where={where} testId="remote-session-panel" />}
      <button
        type="button"
        {...rest}
        {...(onReorder && {
          draggable: true,
          onDragStart: (event) => startSessionDrag(event, dragRow),
          onDragEnd: endSessionDrag,
        })}
        onClick={onOpen}
        aria-current={selected || rest["aria-current"]}
        aria-label={title}
        className={cn(
          "absolute inset-0 rounded-(--radius-raised) outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "data-[state=open]:bg-[var(--state-hover-bg)]",
        )}
        title={session.last ? `${title}\n${session.last}` : title}
        data-testid="remote-session-row"
      />
      <SessionRowLines
        icon={<Icon aria-hidden className="size-3.5 shrink-0" />}
        title={title}
        sign={sign}
        time={duration}
        timeHint={state}
        urgent={group === "attention" && !session.failed}
        device={device}
        place={place}
        parent={parent}
        preview={
          message && (
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
          )
        }
        family={family}
      />
    </div>
  );
}

export function DeviceChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex max-w-24 shrink-0 items-center gap-1 overflow-hidden rounded-full border border-border px-1.5 text-app-micro whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <Monitor aria-hidden className="size-2.5 shrink-0" />
      <span className="truncate">{remoteDisplayName(name)}</span>
    </span>
  );
}

export function RemoteTabLabel({
  target,
  showDevice = true,
}: {
  target: RemoteTarget;
  showDevice?: boolean;
}) {
  const Icon =
    target.kind === "claude" ? ClaudeIcon : target.kind === "codex" ? CodexIcon : SquareTerminal;
  return (
    <>
      {showDevice && <DeviceChip name={target.deviceName} />}
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{remoteTitle(target.title)}</span>
      <RemoteStateGlyph target={target} />
    </>
  );
}

export function RemoteStateGlyph({ target }: { target: Pick<RemoteTarget, "kind" | "state"> }) {
  const { t } = useTranslation();
  const { state } = target;
  const group = state ? GROUP_OF[state] : "idle";
  const ended = target.kind === "terminal" && state === "ended";
  if (!state || (!ended && group === "idle")) return null;
  return (
    <span
      role="img"
      aria-label={t(remoteStateLook(state).labelKey)}
      className="inline-flex shrink-0"
    >
      <LookGlyph look={remoteStateLook(state)} />
    </span>
  );
}
