/**
 * Another computer's chat's earlier sessions, as a chat here lists its
 * own: under its empty conversation, or above the composer for /resume.
 * They come from that computer (history.list); one picked goes on there
 * in a tab of its own (chat.resume), which opens here in this one's place.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentProfile, defaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../ipc/client";
import type { ListedSession } from "../../services/chat/sessions";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { SessionPicker } from "../chat/session-list";
import { showToast } from "../ui/toast";

/** Most sessions asked of that computer: a chat here lists about as many. */
const LIMIT = 100;

/** That computer's profile by its name, as the list marks its sessions; its default as the default. */
function profileIdOf(name: string | undefined, agent: ChatAgent): string {
  return !name || name === "default" ? defaultProfileId(agent) : `remote:${name}`;
}

/** That computer's profiles its sessions are kept by, and the chat's own, as the list shows them. */
function profilesOf(
  sessions: readonly ListedSession[],
  own: string | undefined,
  agent: ChatAgent,
): AgentProfile[] {
  const ids = [...new Set([profileIdOf(own, agent), ...sessions.map((s) => s.profileId)])];
  return ids.map((id) => ({
    id,
    agent,
    name: id.startsWith("remote:") ? id.slice("remote:".length) : "",
    color: "gray",
    dir: "",
  }));
}

/** Its earlier sessions, null until they come; an empty list when they cannot. */
export function usePastSessions(
  target: Pick<RemoteTarget, "deviceId" | "workspaceId" | "kind">,
): ListedSession[] | null {
  const [listed, setListed] = useState<ListedSession[] | null>(null);
  const { deviceId, workspaceId, kind } = target;
  const agent: ChatAgent = kind === "codex" ? "codex" : "claude";
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "peerHistory", {
      deviceId,
      workspaceId,
      agent,
      limit: LIMIT,
    }).then((result) => {
      if (!live) return;
      setListed(
        result.ok
          ? result.value.sessions.map((session) => ({
              sessionId: session.sessionId,
              title: session.title,
              lastModified: session.at,
              ...(session.bytes !== undefined ? { size: session.bytes } : {}),
              profileId: profileIdOf(session.profile, agent),
            }))
          : [],
      );
    });
    return () => {
      live = false;
    };
  }, [deviceId, workspaceId, agent]);
  return listed;
}

/** Goes on with one of them on that computer, and shows its tab here. */
export function useResumePast(target: RemoteTarget): (sessionId: string, title: string) => void {
  const { t } = useTranslation();
  return (sessionId, title) => {
    void ipcCallResult("remote", "peerChatResume", {
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      agent: target.kind === "codex" ? "codex" : "claude",
      sessionId,
    }).then((result) => {
      if (!result.ok) {
        showToast({
          kind: "error",
          message: t("chat.sessions.resume_failed", { message: result.message }),
        });
        return;
      }
      useRemoteViewStore.getState().open({
        ...target,
        tabId: result.value.tabId,
        title,
        state: "idle",
      });
    });
  };
}

export function RemoteSessionList({
  target,
  query,
  onClose,
  exceptSessionId,
}: {
  target: RemoteTarget;
  /** Words a session's title has (/resume's). */
  query?: string;
  /** Shown open, with a button that closes it (/resume); folded under an empty conversation. */
  onClose?: () => void;
  /** The chat's own session, left out. */
  exceptSessionId?: string;
}) {
  const listed = usePastSessions(target);
  const resume = useResumePast(target);
  const agent: ChatAgent = target.kind === "codex" ? "codex" : "claude";
  const profiles = useMemo(
    () => profilesOf(listed ?? [], target.profile, agent),
    [listed, target.profile, agent],
  );
  return (
    <SessionPicker
      agent={agent}
      listed={listed}
      openIn={NO_TABS}
      workspaceId={`remote:${target.deviceId}`}
      tabId={target.tabId}
      profileId={profileIdOf(target.profile, agent)}
      profiles={profiles}
      onResume={(sessionId, _profile, title) => {
        onClose?.();
        resume(sessionId, title);
      }}
      {...(query !== undefined ? { query } : {})}
      {...(onClose ? { onClose } : {})}
      {...(exceptSessionId ? { exceptSessionId } : {})}
    />
  );
}

const NO_TABS: ReadonlyMap<string, string> = new Map();
