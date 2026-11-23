import type { TFunction } from "i18next";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey } from "../../services/agent-view/layout";
import { refreshPeerSessions } from "../../services/remote/room";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { ProfileChipView } from "../agent-profiles/profile-chip-view";
import { showToast } from "../ui/toast";
import { RemoteSessionHostContext } from "./remote-session-host";

export function peerProfileName(name: string, t: TFunction): string {
  return name === "default" ? t("settings:profiles.default_name") : name;
}

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
  busy: boolean;
  moveNow: boolean;
  conversation: boolean;
  controls: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const host = useContext(RemoteSessionHostContext);
  const [open, setOpen] = useState(false);
  const [others, setOthers] = useState<PeerProfile[] | null>(null);
  const name = target.profile;
  if (!name) return null;

  const load = () => {
    setOthers(null);
    void ipcCallResult("remote", "peerProfiles", {
      deviceId: target.deviceId,
      agent: target.kind,
    }).then((result) => {
      setOthers(result.ok ? result.value.profiles.filter((p) => p.name !== name) : []);
    });
  };
  const pick = (id: string, fresh: boolean) => {
    void ipcCallResult("remote", "peerChatProfile", {
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      tabId: target.tabId,
      profile: id,
      ...(fresh ? { fresh: true } : {}),
      ...(busy && moveNow ? { stop: true } : {}),
    }).then((result) => {
      if (!result.ok) {
        showToast({ kind: "error", message: result.message });
        return;
      }
      if (host) refreshPeerSessions(target.deviceId);
      else useRemoteViewStore.getState().setProfile(remoteSessionKey(target), result.value.to);
      if (!fresh)
        showToast({
          kind: "info",
          message: t("chat.profile.moved", { name: peerProfileName(result.value.to, t) }),
        });
    });
  };

  return (
    <ProfileChipView
      name={peerProfileName(name, t)}
      color="gray"
      details={[{ label: t("chat.panel.env.computer"), value: target.deviceName }]}
      others={
        others?.map((other) => ({
          id: other.id,
          name: peerProfileName(other.name, t),
          color: "gray",
        })) ?? null
      }
      conversation={conversation}
      busy={busy ? (moveNow ? "stops" : "waits") : null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
      onPick={pick}
      controls={controls}
      compact={compact}
      testIdPrefix="remote-profile"
    />
  );
}
