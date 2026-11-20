/**
 * The profile chip at the end of another computer's chat's usage line, as a
 * chat here has it: the profile it runs with, and the computer's other
 * profiles of its agent to go on in or start a new conversation in
 * (profiles.list, chat.profile). While a turn is under way or a request
 * waits, the choice stops the turn, as a chat's here does; a computer before
 * 0.13.0 refuses then, so the choice waits there.
 */

import type { TFunction } from "i18next";
import { Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey } from "../../services/agent-view/layout";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { ProfileDot } from "../agent-profiles/profile-badge";
import { Popover } from "../ui/popover";
import { showToast } from "../ui/toast";

/**
 * A profile of that computer's as this app names it: its unnamed default
 * profile comes as "default" (profiles.list) and reads as the default here.
 */
export function peerProfileName(name: string, t: TFunction): string {
  return name === "default" ? t("settings:profiles.default_name") : name;
}

import { tooltipProps } from "../ui/tooltip";

interface PeerProfile {
  id: string;
  name: string;
}

export function RemoteProfileChip({
  target,
  busy,
  moveNow,
  conversation,
  controls,
  compact = false,
}: {
  target: RemoteTarget & { kind: "claude" | "codex" };
  /** A turn is under way or a request waits. */
  busy: boolean;
  /** The computer moves the chat then, its turn stopping (panel `can.moveNow`); else it refuses. */
  moveNow: boolean;
  /** The chat has a conversation to go on with in another profile. */
  conversation: boolean;
  /** The computer lets this one control its chats. */
  controls: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [others, setOthers] = useState<PeerProfile[] | null>(null);
  const name = target.profile;
  if (!name) return null;
  const waits = busy && !moveNow;

  const load = () => {
    setOthers(null);
    void ipcCallResult("remote", "peerProfiles", {
      deviceId: target.deviceId,
      agent: target.kind,
    }).then((result) => {
      setOthers(result.ok ? result.value.profiles.filter((p) => p.name !== name) : []);
    });
  };
  const pick = (profile: PeerProfile, fresh: boolean) => {
    setOpen(false);
    void ipcCallResult("remote", "peerChatProfile", {
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      tabId: target.tabId,
      profile: profile.id,
      ...(fresh ? { fresh: true } : {}),
      ...(busy && moveNow ? { stop: true } : {}),
    }).then((result) => {
      if (!result.ok) {
        showToast({ kind: "error", message: result.message });
        return;
      }
      useRemoteViewStore.getState().setProfile(remoteSessionKey(target), result.value.to);
      if (!fresh)
        showToast({
          kind: "info",
          message: t("chat.profile.moved", { name: peerProfileName(result.value.to, t) }),
        });
    });
  };

  const chip = (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <ProfileDot color="gray" className="size-1.5" />
      {!compact && <span className="max-w-28 truncate">{peerProfileName(name, t)}</span>}
    </span>
  );
  if (!controls) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 px-1"
        data-testid="remote-profile-chip"
        {...(compact ? { "aria-label": name, ...tooltipProps(name) } : {})}
      >
        {chip}
      </span>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
      label={t("chat.profile.title")}
      side="top"
      align="end"
      className="w-72"
      testId="remote-profile-popover"
      trigger={
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1 hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          data-testid="remote-profile-chip"
          {...(compact ? { "aria-label": name, ...tooltipProps(name) } : {})}
        >
          {chip}
        </button>
      }
    >
      <div className="flex flex-col gap-2 px-2 py-1.5 text-app-ui-sm">
        <div className="flex items-center gap-1.5 text-app-body text-foreground">
          <ProfileDot color="gray" />
          <span className="truncate">{peerProfileName(name, t)}</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("chat.panel.env.computer")}</dt>
          <dd className="truncate">{target.deviceName}</dd>
        </dl>
        {others === null ? null : others.length > 0 ? (
          <div className="flex flex-col border-t border-border pt-1.5">
            <span className="pb-0.5 text-app-micro text-muted-foreground">
              {t(conversation ? "chat.profile.continueIn" : "chat.profile.switchTo")}
            </span>
            {waits ? (
              <span
                className="pb-0.5 text-app-micro text-(--state-warning-fg)"
                data-testid="remote-profile-busy"
              >
                {t("agentView.remote.profileBusy")}
              </span>
            ) : busy ? (
              <span
                className="flex items-center gap-1 pb-0.5 text-app-micro text-(--state-warning-fg)"
                data-testid="chat-profile-stops"
              >
                <Square className="size-2.5 fill-current" aria-hidden="true" />
                {t("chat.profile.stops")}
              </span>
            ) : null}
            {others.map((other) => (
              <div
                key={other.id}
                className="-mx-1 flex items-center rounded-(--radius-control) hover:bg-[var(--state-hover-bg)]"
              >
                <button
                  type="button"
                  disabled={waits}
                  // With no conversation yet there is nothing to go on with: a new one, as here.
                  onClick={() => pick(other, !conversation)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-left disabled:opacity-40"
                  data-testid="remote-profile-pick"
                >
                  <ProfileDot color="gray" />
                  <span className="truncate">{peerProfileName(other.name, t)}</span>
                </button>
                {conversation && (
                  <button
                    type="button"
                    disabled={waits}
                    onClick={() => pick(other, true)}
                    className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 text-app-micro whitespace-nowrap text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:opacity-40"
                    data-testid="remote-profile-new"
                  >
                    {t("chat.profile.newChat")}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Popover>
  );
}
