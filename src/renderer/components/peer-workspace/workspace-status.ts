import type { RemoteSession } from "../../../../packages/remote-protocol/src/rpc";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { plainPreview } from "../../services/agent-sessions/preview";
import { STATUS_PRIORITY } from "../../state/stores/claude-status";

const PREVIEW_CHARS = 50;

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
