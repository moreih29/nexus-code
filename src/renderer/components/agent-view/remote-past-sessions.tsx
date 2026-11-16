/**
 * Another computer's chat's earlier sessions, as a chat here lists its
 * own: under its empty conversation, or above the composer for /resume.
 * They come from that computer (history.list), each with its branch and
 * the tab it is open in there; one picked goes on in this chat there
 * (chat.resume's tabId, 0.11.0), or the tab it is open in shows here. A
 * computer before 0.11.0 opens it in a tab of its own, which shows here
 * in this one's place.
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

/** A session listed, with the tab it is open in there. */
type PastSession = ListedSession & { tabId?: string };

/** Its earlier sessions, null until they come; an empty list when they cannot. */
export function usePastSessions(
  target: Pick<RemoteTarget, "deviceId" | "workspaceId" | "kind">,
): PastSession[] | null {
  const [listed, setListed] = useState<PastSession[] | null>(null);
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
              ...(session.firstPrompt ? { firstPrompt: session.firstPrompt } : {}),
              ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
              ...(session.tabId ? { tabId: session.tabId } : {}),
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

/** That computer's profile's name a session's profile id names; none for its default. */
function profileNameOf(profileId: string | undefined): string | undefined {
  return profileId?.startsWith("remote:") ? profileId.slice("remote:".length) : undefined;
}

/**
 * Goes on with one of them in this chat on that computer, in the profile
 * that keeps it, and shows its tab here. What went wrong goes to `fail`,
 * a toast unless given.
 */
export function useResumePast(
  target: RemoteTarget,
): (
  sessionId: string,
  title: string,
  profileId?: string,
  fail?: (message: string) => void,
) => void {
  const { t } = useTranslation();
  return (sessionId, title, profileId, fail) => {
    void ipcCallResult("remote", "peerChatResume", {
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      agent: target.kind === "codex" ? "codex" : "claude",
      sessionId,
      tabId: target.tabId,
    }).then((result) => {
      if (!result.ok) {
        if (fail) fail(result.message);
        else {
          showToast({
            kind: "error",
            message: t("chat.sessions.resume_failed", { message: result.message }),
          });
        }
        return;
      }
      const { profile: _was, ...rest } = target;
      const profile = profileId === undefined ? target.profile : profileNameOf(profileId);
      useRemoteViewStore.getState().open({
        ...rest,
        ...(profile ? { profile } : {}),
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
  const { t } = useTranslation();
  const listed = usePastSessions(target);
  const resume = useResumePast(target);
  // Under the empty conversation a failure shows there, as a chat here's; from /resume, as a toast.
  const [failed, setFailed] = useState<string | null>(null);
  const agent: ChatAgent = target.kind === "codex" ? "codex" : "claude";
  const profiles = useMemo(
    () => profilesOf(listed ?? [], target.profile, agent),
    [listed, target.profile, agent],
  );
  // The tabs there that have one open, as a chat here marks its own.
  const openIn = useMemo(
    () =>
      new Map((listed ?? []).flatMap((s) => (s.tabId ? [[s.sessionId, s.tabId] as const] : []))),
    [listed],
  );
  return (
    <>
      {failed && !onClose && (
        <div className="text-app-ui-sm text-[var(--state-error-fg)]">
          {t("chat.sessions.resume_failed", { message: failed })}
        </div>
      )}
      <SessionPicker
        agent={agent}
        listed={listed}
        openIn={openIn}
        onShowTab={(tabId, session) => {
          // Another tab: its folder and state come with that computer's next list.
          const { cwd: _cwd, state: _state, ...where } = target;
          useRemoteViewStore.getState().open({ ...where, tabId, title: session.title });
        }}
        workspaceId={`remote:${target.deviceId}`}
        tabId={target.tabId}
        profileId={profileIdOf(target.profile, agent)}
        profiles={profiles}
        onResume={(sessionId, profileId, title) => {
          setFailed(null);
          onClose?.();
          resume(sessionId, title, profileId, onClose ? undefined : setFailed);
        }}
        {...(query !== undefined ? { query } : {})}
        {...(onClose ? { onClose } : {})}
        {...(exceptSessionId ? { exceptSessionId } : {})}
      />
    </>
  );
}
