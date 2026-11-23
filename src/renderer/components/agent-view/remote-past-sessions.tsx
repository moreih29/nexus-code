import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentProfile, defaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../ipc/client";
import type { ListedSession } from "../../services/chat/sessions";
import { openRemoteSession, type RemoteTarget } from "../../state/stores/remote-view";
import { SessionPicker } from "../chat/session-list";
import { BannerDismissButton } from "../ui/banner";
import { showToast } from "../ui/toast";
import { RemoteSessionHostContext } from "./remote-session-host";

const LIMIT = 100;

function profileIdOf(name: string | undefined, agent: ChatAgent): string {
  return !name || name === "default" ? defaultProfileId(agent) : `remote:${name}`;
}

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

type PastSession = ListedSession & { tabId?: string };

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

function profileNameOf(profileId: string | undefined): string | undefined {
  return profileId?.startsWith("remote:") ? profileId.slice("remote:".length) : undefined;
}

export function useResumePast(
  target: RemoteTarget,
): (
  sessionId: string,
  title: string,
  profileId?: string,
  fail?: (message: string) => void,
) => void {
  const { t } = useTranslation();
  const open = useContext(RemoteSessionHostContext)?.openSession ?? openRemoteSession;
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
      open({
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
  query?: string;
  onClose?: () => void;
  exceptSessionId?: string;
}) {
  const { t } = useTranslation();
  const open = useContext(RemoteSessionHostContext)?.openSession ?? openRemoteSession;
  const listed = usePastSessions(target);
  const resume = useResumePast(target);
  const [failed, setFailed] = useState<string | null>(null);
  const agent: ChatAgent = target.kind === "codex" ? "codex" : "claude";
  const profiles = useMemo(
    () => profilesOf(listed ?? [], target.profile, agent),
    [listed, target.profile, agent],
  );
  const openIn = useMemo(
    () =>
      new Map((listed ?? []).flatMap((s) => (s.tabId ? [[s.sessionId, s.tabId] as const] : []))),
    [listed],
  );
  return (
    <>
      {failed && !onClose && (
        <div className="flex items-center gap-2 text-app-ui-sm text-[var(--state-error-fg)]">
          <span className="flex-1">{t("chat.sessions.resume_failed", { message: failed })}</span>
          <BannerDismissButton
            dismiss={{ label: t("action.dismiss"), onDismiss: () => setFailed(null) }}
          />
        </div>
      )}
      <SessionPicker
        agent={agent}
        listed={listed}
        openIn={openIn}
        onShowTab={(tabId, session) => {
          const { cwd: _cwd, state: _state, ...where } = target;
          open({ ...where, tabId, title: session.title });
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
