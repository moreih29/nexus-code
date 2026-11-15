// The agent view's list, below this computer's agents: the account's other
// computers in the room, each with its workspaces' sessions as it lists
// them (sessions.list), asked again every few seconds while the list is
// shown. A computer folds; the search box finds sessions by their title or
// last line, as it does this computer's. A terminal with only its shell is
// out of sight until the user asks for its workspace's terminals or
// searches for it.

import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  GitBranch,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RemoteSession,
  RemoteSessionAgent,
  RemoteWorkspace,
  SessionState,
} from "../../../../packages/remote-protocol/src/rpc";
import type { AgentRun } from "../../../shared/claude/activity";
import type { RoomPeer } from "../../../shared/remote/room";
import type { RowGroup } from "../../services/agent-sessions/rows";
import { leafHolding, remoteSessionKey } from "../../services/agent-view/layout";
import {
  offlinePeers,
  type PeerSessions,
  servingPeers,
  usePeerSessions,
  useRemoteRoom,
} from "../../services/remote/room";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { AgentRows } from "../agent-list/agent-rows";
import { StateGlyph } from "../agent-list/session-status";
import { GROUP_STATE, GROUP_TINT } from "../agent-list/status-view";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { PANEL_SHOWN_BG, PanelMark, type PanelPlace, panelPlaceOf } from "./panel-mark";

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** A remote session's state as this list's groups tell it. */
export const GROUP_OF: Record<SessionState, RowGroup> = {
  "needs-you": "attention",
  running: "running",
  "new-result": "done",
  idle: "idle",
  // Left out of the list unasked, as an agent here whose terminal ended is.
  ended: "idle",
};

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
    session.agent !== undefined ||
    session.waiting !== undefined ||
    session.state !== "idle" ||
    session.last !== undefined
  );
}

/**
 * The sessions the list shows: those it shows unasked, a workspace's
 * terminals too when they are asked for there or one is in a panel, and
 * those a search finds. How many it leaves out, by workspace.
 */
export function listedSessions(
  sessions: readonly RemoteSession[],
  query: string,
  terminalsIn: (workspaceId: string) => boolean,
  inPanel: (session: RemoteSession) => boolean,
): { listed: RemoteSession[]; hidden: ReadonlyMap<string, number> } {
  if (query.trim()) return { listed: sessions.filter((s) => matches(s, query)), hidden: new Map() };
  const listed: RemoteSession[] = [];
  const hidden = new Map<string, number>();
  for (const s of sessions) {
    if (terminalsIn(s.workspaceId) || listedByDefault(s) || inPanel(s)) listed.push(s);
    else hidden.set(s.workspaceId, (hidden.get(s.workspaceId) ?? 0) + 1);
  }
  return { listed, hidden };
}

function matches(session: RemoteSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return session.title.toLowerCase().includes(q) || (session.last ?? "").toLowerCase().includes(q);
}

export function RemoteSessions({ query, shown = true }: { query: string; shown?: boolean }) {
  const { t } = useTranslation();
  const room = useRemoteRoom();
  const peers = servingPeers(room);
  // Searching, an offline computer has no sessions to find.
  const away = query.trim() ? [] : offlinePeers(room);
  const lists = usePeerSessions(
    peers.map((p) => p.id),
    shown,
  );
  if (peers.length === 0 && away.length === 0) return null;
  return (
    // A line apart from this computer's, and between the computers: a space
    // only between workspaces, a line between the larger groups.
    <section
      className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3"
      data-testid="remote-sessions"
    >
      <h3 className="px-2 pb-1 text-app-label uppercase text-muted-foreground">
        {t("agentView.remote.title")}
      </h3>
      <div className="flex flex-col divide-y divide-border [&>*]:py-1.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {peers.map((peer) => (
          <PeerGroup key={peer.id} peer={peer} sessions={lists[peer.id]} query={query} />
        ))}
        {away.map((peer) => (
          <OfflinePeer key={peer.id} peer={peer} />
        ))}
      </div>
    </section>
  );
}

/** A computer of the account out of the room: greyed, its sessions out of reach until it is back. */
export function OfflinePeer({ peer }: { peer: RoomPeer }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground"
      data-testid="remote-peer-offline"
    >
      <ChevronRight aria-hidden className="size-3 shrink-0 opacity-40" />
      <Monitor aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate text-app-ui-sm">{peer.name}</span>
      <span className="shrink-0 text-app-micro">{PLATFORMS[peer.platform] ?? peer.platform}</span>
      <span className="ml-auto shrink-0 text-app-micro">{t("agentView.remote.offlineTag")}</span>
    </div>
  );
}

export function PeerGroup({
  peer,
  sessions,
  query,
}: {
  peer: RoomPeer;
  sessions: PeerSessions | undefined;
  query: string;
}) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState(false);
  // The workspaces whose terminals with only their shell are shown, each
  // asked for on its own; not kept.
  const [terminalsIn, setTerminalsIn] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTerminals = (workspaceId: string) =>
    setTerminalsIn((now) => {
      const next = new Set(now);
      if (!next.delete(workspaceId)) next.add(workspaceId);
      return next;
    });
  const Chevron = folded ? ChevronRight : ChevronDown;
  const list = sessions?.status === "ready" ? sessions.list : null;
  const root = useAgentViewStore((s) => s.root);
  const { listed: shownSessions, hidden } = listedSessions(
    list?.sessions ?? [],
    query,
    (workspaceId) => terminalsIn.has(workspaceId),
    (s) => leafHolding(root, remoteSessionKey({ deviceId: peer.id, ...s })) !== null,
  );
  // A workspace's terminals with only their shell: what its toggle shows and hides.
  const plain = new Map<string, number>();
  for (const s of list?.sessions ?? []) {
    if (!listedByDefault(s)) plain.set(s.workspaceId, (plain.get(s.workspaceId) ?? 0) + 1);
  }
  const toggles = (workspaceId: string) =>
    !query.trim() &&
    ((terminalsIn.has(workspaceId) ? plain.get(workspaceId) : hidden.get(workspaceId)) ?? 0) > 0;
  const waiting = list?.sessions.filter((s) => s.state === "needs-you").length ?? 0;
  const workspaces = new Map(list?.workspaces.map((w) => [w.id, w]) ?? []);
  const names = new Map(list?.workspaces.map((w) => [w.id, w.name]) ?? []);
  const paths = new Map(list?.workspaces.map((w) => [w.id, w.path]) ?? []);
  const open = useRemoteViewStore((s) => s.open);
  // The tabs of this computer's sessions take up their new titles.
  useEffect(() => {
    if (list) useRemoteViewStore.getState().refresh(peer.id, list);
  }, [peer.id, list]);
  // In the order the computer lists them: a workspace with sessions shown, or
  // with only terminals behind its toggle.
  const byWorkspace = new Map<string, RemoteSession[]>();
  for (const s of list?.sessions ?? []) byWorkspace.set(s.workspaceId, []);
  for (const s of shownSessions) byWorkspace.get(s.workspaceId)?.push(s);
  const groups = [...byWorkspace].filter(([id, rows]) => rows.length > 0 || toggles(id));

  return (
    <div className="flex flex-col" data-testid="remote-peer">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => setFolded((f) => !f)}
        className="flex items-center gap-1.5 rounded-(--radius-control) px-2 py-1 text-left hover:bg-[var(--state-hover-bg)]"
      >
        <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <Monitor aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-app-ui-sm text-foreground">{peer.name}</span>
        <span className="shrink-0 text-app-micro text-muted-foreground">
          {PLATFORMS[peer.platform] ?? peer.platform}
        </span>
        {/* Folded, it still tells how many sessions there are and whether one needs the user. */}
        {folded && list && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground">
            {waiting > 0 && (
              <>
                <StateGlyph state={GROUP_STATE.attention} className={GROUP_TINT.attention} />
                <span className="sr-only">{t("agentView.remote.state.needs-you")}</span>
              </>
            )}
            {list.sessions.filter(listedByDefault).length}
          </span>
        )}
      </button>
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
          ) : groups.length === 0 ? (
            <p className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("agentView.remote.empty")}
            </p>
          ) : (
            groups.map(([workspaceId, rows]) => (
              <div key={workspaceId} className="flex flex-col not-first:mt-1.5">
                <WorkspaceHeading
                  name={names.get(workspaceId) ?? workspaceId}
                  workspace={workspaces.get(workspaceId)}
                />
                {rows.map((session) => (
                  <Fragment key={session.tabId}>
                    <RemoteSessionRow
                      session={session}
                      where={panelPlaceOf(
                        root,
                        remoteSessionKey({ deviceId: peer.id, ...session }),
                      )}
                      onOpen={() =>
                        open({
                          deviceId: peer.id,
                          deviceName: peer.name,
                          workspaceId,
                          workspaceName: names.get(workspaceId) ?? workspaceId,
                          path: paths.get(workspaceId) ?? "",
                          tabId: session.tabId,
                          kind: session.kind,
                          title: session.title,
                          state: session.state,
                          ...(session.profile ? { profile: session.profile } : {}),
                          ...(session.cwd ? { cwd: session.cwd } : {}),
                        })
                      }
                    />
                    <AgentRows
                      agents={agentRunsOf(session.agents)}
                      selectedId={undefined}
                      className="pl-4"
                    />
                  </Fragment>
                ))}
                {toggles(workspaceId) && (
                  <button
                    type="button"
                    aria-expanded={terminalsIn.has(workspaceId)}
                    onClick={() => toggleTerminals(workspaceId)}
                    // Lined up with the rows' titles: its icon where theirs is, after the state.
                    className="flex items-center gap-1.5 rounded-(--radius-control) py-1 pr-2 pl-6.5 text-left text-app-micro text-(--state-selected-indicator) hover:bg-[var(--state-hover-bg)] hover:underline"
                    data-testid="remote-terminals-toggle"
                    data-workspace={workspaceId}
                  >
                    {terminalsIn.has(workspaceId) ? (
                      <ChevronUp aria-hidden className="size-3 shrink-0" />
                    ) : (
                      <SquareTerminal aria-hidden className="size-3 shrink-0" />
                    )}
                    {terminalsIn.has(workspaceId)
                      ? t("agentView.remote.terminalsHide")
                      : t("agentView.remote.terminalsShow", {
                          count: hidden.get(workspaceId) ?? 0,
                        })}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** A workspace's sessions' heading: a folder, or a task's branch, and how its git stands. */
function WorkspaceHeading({
  name,
  workspace,
}: {
  name: string;
  workspace: RemoteWorkspace | undefined;
}) {
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
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5"
      data-testid="remote-workspace"
    >
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate font-semibold text-app-micro text-foreground">{name}</span>
      {stands && (
        <span className="min-w-0 shrink truncate font-mono text-app-micro text-muted-foreground">
          {stands}
        </span>
      )}
    </span>
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

export function RemoteSessionRow({
  session,
  where = null,
  onOpen,
}: {
  session: RemoteSession;
  /** Where the agent view's panels have it, which its mark tells; none where they do not. */
  where?: PanelPlace | null;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const group = GROUP_OF[session.state];
  const Icon =
    session.kind === "claude" ? ClaudeIcon : session.kind === "codex" ? CodexIcon : SquareTerminal;
  const state = t(`agentView.remote.state.${session.state}`);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={where === "shown" || undefined}
      className={cn(
        "relative flex min-w-0 flex-col rounded-(--radius-control) px-2 py-1 text-left",
        where === "shown" ? PANEL_SHOWN_BG : "hover:bg-[var(--state-hover-bg)]",
      )}
      title={session.last ? `${session.title}\n${session.last}` : session.title}
      data-testid="remote-session-row"
    >
      {where && (
        <PanelMark where={where} className="top-1 bottom-1" testId="remote-session-panel" />
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <StateGlyph state={GROUP_STATE[group]} className={GROUP_TINT[group]} />
        <span className="sr-only">{state}</span>
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="truncate text-app-ui-sm text-foreground">{session.title}</span>
      </span>
      {(session.waiting || session.last) && (
        <span
          className={cn(
            "truncate pl-4.5 text-app-micro",
            session.waiting ? "text-(--state-warning-fg)" : "text-muted-foreground",
          )}
        >
          {session.waiting?.text ?? session.last}
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
        "flex max-w-24 shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-app-micro text-muted-foreground",
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
 * state while it is not idle.
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
  const group = target.state ? GROUP_OF[target.state] : "idle";
  return (
    <>
      {showDevice && <DeviceChip name={target.deviceName} />}
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{target.title}</span>
      {target.state && group !== "idle" && (
        <span
          role="img"
          aria-label={t(`agentView.remote.state.${target.state}`)}
          className="inline-flex"
        >
          <StateGlyph state={GROUP_STATE[group]} className={GROUP_TINT[group]} />
        </span>
      )}
    </>
  );
}
