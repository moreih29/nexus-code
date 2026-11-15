// The agent view's list, below this computer's agents: the account's other
// computers in the room, each with its workspaces' sessions as it lists
// them (sessions.list), asked again every few seconds while the list is
// shown. A computer folds; the search box finds sessions by their title or
// last line, as it does this computer's.

import { ChevronDown, ChevronRight, Monitor, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteSession, SessionState } from "../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../shared/remote/room";
import type { RowGroup } from "../../services/agent-sessions/rows";
import { leafShowing, remoteSessionKey } from "../../services/agent-view/layout";
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
import { StateGlyph } from "../agent-list/session-status";
import { GROUP_STATE, GROUP_TINT } from "../agent-list/status-view";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** A remote session's state as this list's groups tell it. */
export const GROUP_OF: Record<SessionState, RowGroup> = {
  "needs-you": "attention",
  running: "running",
  "new-result": "done",
  idle: "idle",
  ended: "ended",
};

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
    <section className="mt-3 flex flex-col gap-0.5" data-testid="remote-sessions">
      <h3 className="px-2 pb-1 text-app-label uppercase text-muted-foreground">
        {t("agentView.remote.title")}
      </h3>
      {peers.map((peer) => (
        <PeerGroup key={peer.id} peer={peer} sessions={lists[peer.id]} query={query} />
      ))}
      {away.map((peer) => (
        <OfflinePeer key={peer.id} peer={peer} />
      ))}
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
  const Chevron = folded ? ChevronRight : ChevronDown;
  const list = sessions?.status === "ready" ? sessions.list : null;
  const shownSessions = list ? list.sessions.filter((s) => matches(s, query)) : [];
  const waiting = list?.sessions.filter((s) => s.state === "needs-you").length ?? 0;
  const names = new Map(list?.workspaces.map((w) => [w.id, w.name]) ?? []);
  const paths = new Map(list?.workspaces.map((w) => [w.id, w.path]) ?? []);
  const root = useAgentViewStore((s) => s.root);
  const open = useRemoteViewStore((s) => s.open);
  // The tabs of this computer's sessions take up their new titles.
  useEffect(() => {
    if (list) useRemoteViewStore.getState().refresh(peer.id, list);
  }, [peer.id, list]);
  const byWorkspace = new Map<string, RemoteSession[]>();
  for (const s of shownSessions) {
    byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s]);
  }

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
            {list.sessions.length}
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
          ) : shownSessions.length === 0 ? (
            <p className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("agentView.remote.empty")}
            </p>
          ) : (
            [...byWorkspace].map(([workspaceId, rows]) => (
              <div key={workspaceId} className="flex flex-col">
                <span className="truncate px-2 pt-1 text-app-micro text-muted-foreground">
                  {names.get(workspaceId) ?? workspaceId}
                </span>
                {rows.map((session) => (
                  <RemoteSessionRow
                    key={session.tabId}
                    session={session}
                    selected={
                      leafShowing(root, remoteSessionKey({ deviceId: peer.id, ...session })) !==
                      null
                    }
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
                      })
                    }
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function RemoteSessionRow({
  session,
  selected = false,
  onOpen,
}: {
  session: RemoteSession;
  selected?: boolean;
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
      aria-current={selected || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-(--radius-control) px-2 py-1 text-left hover:bg-[var(--state-hover-bg)]",
        selected && "bg-[var(--sidebar-item-selected-bg)]",
      )}
      title={session.last ? `${session.title}\n${session.last}` : session.title}
      data-testid="remote-session-row"
    >
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
