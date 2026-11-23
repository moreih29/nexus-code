import { useEffect, useState } from "react";
import { createLogger } from "../../../../shared/log/renderer";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import type { CallReturn } from "../../../ipc/types";
import { removeConversationAttachments } from "../attach-retention";
import type { ListedSession } from "../sessions";
import { historyModel } from "./history";

const log = createLogger("chat-sessions");

export type ClaudeSession = CallReturn<"chat", "sessions">[number] & {
  /** The Claude profile whose folder keeps it. */
  profileId: string;
};

/**
 * The folder's sessions in each of the profiles' folders, newest first;
 * null until they are read, or when none could be.
 */
export function useClaudeSessions(
  workspaceId: string,
  cwd: string,
  enabled: boolean,
  profileIds: readonly string[],
): readonly ClaudeSession[] | null {
  const [sessions, setSessions] = useState<readonly ClaudeSession[] | null>(null);
  const key = profileIds.join("\n");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ids = key.split("\n");
    void Promise.all(
      ids.map((profileId) =>
        ipcCallResult("chat", "sessions", { workspaceId, cwd, profileId })
          .then((result) => unwrapIpcResult(result).map((session) => ({ ...session, profileId })))
          .catch((err: Error) => {
            log.warn(`sessions of ${cwd} (${profileId}) not read: ${err.message}`);
            return null;
          }),
      ),
    ).then((lists) => {
      if (!live) return;
      if (lists.every((list) => list === null)) return;
      const seen = new Set<string>();
      const merged = lists
        .flatMap((list) => list ?? [])
        .sort((a, b) => b.lastModified - a.lastModified)
        .filter((session) => !seen.has(session.sessionId) && seen.add(session.sessionId));
      setSessions(merged);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, cwd, enabled, key]);
  return sessions;
}

/**
 * Deletes a Claude session of the folder: its transcript and what it kept
 * under its id, in the profile's folder that keeps it. One already gone is
 * as good as deleted. The files attached to its messages go too, but those
 * an open tab uses; its transcript is read first, as nothing is left to
 * read after. One that cannot be read leaves them to the prune of unused
 * ones.
 */
export async function deleteClaudeSession(
  workspaceId: string,
  cwd: string,
  session: Pick<ListedSession, "sessionId" | "profileId">,
): Promise<void> {
  const { sessionId, profileId } = session;
  const transcript = await ipcCallResult("chat", "transcript", {
    workspaceId,
    sessionId,
    ...(profileId ? { profileId } : {}),
  }).catch(() => null);
  unwrapIpcResult(
    await ipcCallResult("chat", "deleteSession", { workspaceId, cwd, sessionId, profileId }),
  );
  if (!transcript?.ok || !transcript.value.found) return;
  const { items } = historyModel(transcript.value.lines);
  await removeConversationAttachments(workspaceId, items, cwd).catch((error: Error) =>
    log.warn(`removing session ${sessionId}'s attachments: ${error.message}`),
  );
}
