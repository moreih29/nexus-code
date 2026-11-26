import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
import { useNow } from "../../hooks/use-now";
import { remoteDisplayName } from "../../services/remote/display-name";
import { type PeerProfileUsage, watchPeerProfileUsage } from "../../services/remote/profile-usage";
import { peerRejoins } from "../../services/remote/room";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { UsageMeterRow, usageMeterKey } from "../chat/usage-meter-row";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { showToast } from "../ui/toast";
import { peerProfileName } from "./remote-profile-chip";
import { profileUsageView } from "./remote-usage";

export function RemoteProfilesUsageDialog({
  peer,
  online,
  served,
  onClose,
}: {
  peer: RoomPeer;
  online: boolean;
  served: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<PeerProfileUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshingRejoin, setRefreshingRejoin] = useState<number | null>(null);
  const watch = useRef<ReturnType<typeof watchPeerProfileUsage> | null>(null);
  const now = useNow(true, 60_000);
  const enabled = online && served;
  const { id } = peer;
  const deviceName = remoteDisplayName(peer.name);
  const rejoins = peerRejoins(peer);
  const refreshing = enabled && refreshingRejoin === rejoins;

  useEffect(() => {
    if (!enabled) return;
    setFailed(false);
    watch.current = watchPeerProfileUsage(
      id,
      (reply, refresh) => {
        if (reply) setProfiles(reply);
        setFailed(reply === null);
        if (!reply && refresh) {
          showToast({ kind: "error", message: t("agentView.remote.usage.refreshFailed") });
        }
      },
      (active) => setRefreshingRejoin(active ? rejoins : null),
    );
    return () => {
      watch.current?.stop();
      watch.current = null;
      setRefreshingRejoin(null);
    };
  }, [enabled, id, rejoins, t]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogHeader
        title={t("agentView.remote.usage.title")}
        description={deviceName}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={refreshing}
            disabled={!enabled || refreshing}
            onClick={() => void watch.current?.refresh()}
          >
            {t("agentView.remote.usage.refresh")}
          </Button>
        }
        close
      />
      <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto" aria-busy={refreshing}>
        {!online && <p role="status">{t("agentView.remote.offlineTag")}</p>}
        {online && !served ? (
          <p role="status">{t("agentView.remote.usage.updateNeeded", { device: deviceName })}</p>
        ) : profiles ? (
          profiles.length ? (
            profiles.map((profile) => (
              <ProfileUsageCard
                key={`${profile.agent}/${profile.id}`}
                profile={profile}
                now={now}
              />
            ))
          ) : (
            <p role="status">{t("agentView.remote.usage.empty")}</p>
          )
        ) : online ? (
          <p role="status">
            {t(failed ? "agentView.remote.unavailable" : "agentView.remote.loading")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ProfileUsageCard({ profile, now }: { profile: PeerProfileUsage; now: number }) {
  const { t, i18n } = useTranslation();
  const { meters, note, checkedAt } = profileUsageView(profile, now);
  const scoped = meters.some((meter) => meter.kind === "weekly_scoped");
  const Icon = profile.agent === "claude" ? ClaudeIcon : CodexIcon;
  return (
    <article className="flex flex-col gap-2 rounded-(--radius-control) border border-border px-3 py-2">
      <h3 className="flex items-center gap-2 text-app-body-emphasis">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{peerProfileName(profile.name, t)}</span>
        <span className="text-app-micro text-muted-foreground">
          {profile.agent === "claude" ? "Claude" : "Codex"}
        </span>
      </h3>
      {note && (
        <p className="text-app-micro text-muted-foreground">
          {note === "stale" && checkedAt !== undefined
            ? t("agentView.remote.usage.checkedAt", {
                time: new Date(checkedAt).toLocaleString(i18n.language),
              })
            : t(`agentView.remote.usage.${note}`)}
        </p>
      )}
      {meters.map((meter) => (
        <UsageMeterRow
          key={usageMeterKey(meter)}
          meter={meter}
          scoped={scoped}
          stale={meter.stale}
        />
      ))}
    </article>
  );
}
