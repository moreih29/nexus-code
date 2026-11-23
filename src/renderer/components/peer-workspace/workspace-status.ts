/**
 * Where a workspace on another computer stands, as a local workspace's
 * sidebar card and task menu tell it: the most urgent of its sessions'
 * states as a Claude status, for the local glyph, and the last thing one
 * of them said. Read from that computer's session listing.
 */

import type { RemoteSession } from "../../../../packages/remote-protocol/src/rpc";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { plainPreview } from "../../services/agent-sessions/preview";
import { STATUS_PRIORITY } from "../../state/stores/claude-status";

/** How long the card's message line is, as the local card cuts it. */
const PREVIEW_CHARS = 50;

/** A session's state as the local glyph reads a Claude status. */
export function peerSessionStatus(session: RemoteSession): ClaudeStatus {
  if (session.failed && session.state !== "ended") return "error";
  switch (session.state) {
    case "needs-you":
      return session.waiting?.kind === "permission" ? "permissionPending" : "needsInput";
    case "running":
      return "running";
    case "new-result":
      return "completed";
    default:
      return "idle";
  }
}

/** The most urgent state of the sessions in `workspaceIds`; null with none to tell. */
export function peerWorkspaceStatus(
  sessions: readonly RemoteSession[],
  workspaceIds: ReadonlySet<string>,
): ClaudeStatus | null {
  let shown: ClaudeStatus | null = null;
  for (const session of sessions) {
    if (!workspaceIds.has(session.workspaceId)) continue;
    const status = peerSessionStatus(session);
    if (status !== "idle" && (shown === null || STATUS_PRIORITY[status] > STATUS_PRIORITY[shown]))
      shown = status;
  }
  return shown;
}

/** The last thing a session in `workspaceIds` said, the latest first, in a short line. */
export function peerWorkspacePreview(
  sessions: readonly RemoteSession[],
  workspaceIds: ReadonlySet<string>,
): string | null {
  let latest: RemoteSession | undefined;
  for (const session of sessions) {
    if (!workspaceIds.has(session.workspaceId) || !session.last) continue;
    if (!latest || (session.since ?? 0) > (latest.since ?? 0)) latest = session;
  }
  if (!latest?.last) return null;
  const line = plainPreview(latest.last);
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
}
