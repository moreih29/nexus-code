import { ChevronRight, LoaderCircle, Plus, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import {
  listConnectionProfiles,
  openSshBrowseSession,
  removeConnectionProfile,
  saveConnectionProfile,
  setConnectionProfileFavorite,
} from "../../../services/workspace";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { BootstrapProgressBar } from "../bootstrap-progress-bar";
import { ErrorNotice } from "./error-notice";
import { formatProfileSubtitle } from "./ssh-helpers";
import type { SshBrowseSession, SshConnectionListViewProps } from "./types";
import { useBrowseProgress } from "./use-browse-progress";

// ---------------------------------------------------------------------------
// SshConnectionListView — T4 implementation
// SSH server list: saved profiles + always-last New Connection row.
// Empty list shows EmptyState above the New Connection row.
// ---------------------------------------------------------------------------

export function SshConnectionListView({
  onNewConnection,
  onConnected,
}: SshConnectionListViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorHuman, setErrorHuman] = useState<string | null>(null);
  // Agent-bootstrap progress for the in-flight connect (keyed by a client-minted
  // progressId, since no sessionId/workspaceId exists yet).
  const {
    progress: browseProgress,
    begin: beginProgress,
    clear: clearProgress,
  } = useBrowseProgress();

  const loadProfiles = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    listConnectionProfiles()
      .then((sorted) => {
        if (cancelled) return;
        setProfiles(sorted);
      })
      .catch(() => {
        if (cancelled) return;
        setProfiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return loadProfiles();
  }, [loadProfiles]);

  const favorites = profiles.filter((p) => p.favorite);
  const recents = profiles.filter((p) => !p.favorite);
  const hasContent = profiles.length > 0;
  const busy = connectingId !== null;

  async function connectProfile(profile: ConnectionProfile): Promise<void> {
    if (busy) return;
    setConnectingId(profile.id);
    setErrorId(null);
    setErrorHuman(null);
    try {
      // openBrowseSession is migrated to the IpcResult contract — auth
      // cancellation arrives as ipcErr("cancelled") so the router stays silent
      // and the renderer branches without showing an error banner.
      const result = await openSshBrowseSession({
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: profile.authMode as "interactive" | "key-only",
        progressId: beginProgress(),
      });
      if (!result.ok) {
        // User cancelled the SSH auth prompt — silent stop, no error banner.
        if (result.kind === "cancelled") return;
        setErrorId(profile.id);
        setErrorHuman(result.message);
        return;
      }
      // Update usage record
      await saveConnectionProfile({
        id: profile.id,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: profile.authMode as "interactive" | "key-only",
        label: profile.label ?? undefined,
      });
      const session: SshBrowseSession = {
        sessionId: result.value.sessionId,
        initialPath: result.value.initialPath,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        profileId: profile.id,
        connectionProfileId: profile.id,
      };
      onConnected(session);
    } finally {
      setConnectingId(null);
      clearProgress();
    }
  }

  async function toggleFavorite(
    profile: ConnectionProfile,
    event: React.MouseEvent,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await setConnectionProfileFavorite(profile.id, !profile.favorite);
      setProfiles((prev) =>
        prev.map((p) => (p.id === profile.id ? { ...p, favorite: !p.favorite } : p)),
      );
    } catch {
      // silent
    }
  }

  async function removeProfile(profile: ConnectionProfile, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await removeConnectionProfile(profile.id);
      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
      if (errorId === profile.id) {
        setErrorId(null);
        setErrorHuman(null);
      }
    } catch {
      // silent
    }
  }

  if (loading) {
    return (
      <Skeleton label={t("ssh.loading_connections")} className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Bootstrap progress — shown once the agent upload/verify begins for the
          profile being connected, instead of only the per-row spinner. */}
      {busy && browseProgress ? (
        <BootstrapProgressBar
          phase={browseProgress.phase}
          name={browseProgress.name}
          bytesDone={browseProgress.bytesDone}
          bytesTotal={browseProgress.bytesTotal}
          className="px-2 pb-1"
        />
      ) : null}

      {/* Empty state — shown above New Connection row when no profiles */}
      {!hasContent ? (
        <EmptyState
          tone="status"
          icon={<Server className="size-6" aria-hidden="true" />}
          title={t("ssh.no_saved")}
          description={t("ssh.no_saved_desc")}
          className="py-6"
        />
      ) : null}

      {/* Favorites section */}
      {favorites.length > 0 ? (
        <section aria-label={t("workspace.favorites")}>
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase text-muted-foreground">
              {t("workspace.favorites")}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {favorites.map((profile) => (
              <ConnectionProfileRow
                key={profile.id}
                profile={profile}
                connecting={connectingId === profile.id}
                disabled={busy}
                errorHuman={errorId === profile.id ? (errorHuman ?? undefined) : undefined}
                onConnect={() => void connectProfile(profile)}
                onToggleFavorite={(e) => void toggleFavorite(profile, e)}
                onRemove={(e) => void removeProfile(profile, e)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Recent section */}
      {recents.length > 0 ? (
        <section
          aria-label={t("workspace.recent")}
          className={favorites.length > 0 ? "mt-3" : undefined}
        >
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase text-muted-foreground">
              {t("workspace.recent")}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {recents.map((profile) => (
              <ConnectionProfileRow
                key={profile.id}
                profile={profile}
                connecting={connectingId === profile.id}
                disabled={busy}
                errorHuman={errorId === profile.id ? (errorHuman ?? undefined) : undefined}
                onConnect={() => void connectProfile(profile)}
                onToggleFavorite={(e) => void toggleFavorite(profile, e)}
                onRemove={(e) => void removeProfile(profile, e)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* New Connection action row — always last */}
      <div className={hasContent ? "mt-3 border-t border-border pt-3" : undefined}>
        <button
          type="button"
          disabled={busy}
          onClick={onNewConnection}
          className="flex w-full items-center gap-3 rounded-(--radius-control) px-2 py-2 text-left text-app-ui-sm text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) border border-dashed border-border">
            <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate">{t("ssh.new_connection")}</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionProfileRow — single SSH connection profile row
// ---------------------------------------------------------------------------

interface ConnectionProfileRowProps {
  readonly profile: ConnectionProfile;
  readonly connecting: boolean;
  readonly disabled: boolean;
  readonly errorHuman: string | undefined;
  readonly onConnect: () => void;
  readonly onToggleFavorite: (event: React.MouseEvent) => void;
  readonly onRemove: (event: React.MouseEvent) => void;
}

function ConnectionProfileRow({
  profile,
  connecting,
  disabled,
  errorHuman,
  onConnect,
  onToggleFavorite,
  onRemove,
}: ConnectionProfileRowProps): React.JSX.Element {
  const { t } = useTranslation();
  const displayName = profile.label ?? profile.host;
  const isFavorite = profile.favorite;
  const subtitle = formatProfileSubtitle(profile);
  const hasError = !!errorHuman;

  return (
    <li>
      {/* Row: primary connect-button + sibling action slot. The favorite/remove
          buttons are siblings (not descendants) of the row button — nesting a
          <button> inside a <button> is invalid HTML. */}
      <div
        className={[
          "group flex items-center rounded-(--radius-control) hover:bg-[var(--state-hover-bg)]",
          disabled ? "pointer-events-none opacity-50" : "",
          // Error state: left border as redundant visual channel
          hasError ? "border-l-2 border-[var(--state-error-border)]" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={onConnect}
          className={[
            "flex min-w-0 flex-1 items-center gap-3 rounded-(--radius-control) px-2 py-2 text-left outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            hasError ? "pl-[calc(0.5rem-2px)]" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {/* Leading icon: Server or connecting spinner */}
          {connecting ? (
            <span className="flex size-4 shrink-0 items-center justify-center">
              <LoaderCircle
                className="size-4 animate-spin text-[var(--state-loading-indicator)]"
                aria-hidden="true"
              />
            </span>
          ) : (
            <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}

          {/* Name + connection info */}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-app-ui-sm text-foreground">{displayName}</span>
            <span className="block truncate text-app-ui-sm text-muted-foreground">
              {connecting ? t("ssh.connecting") : subtitle}
            </span>
          </span>
        </button>

        {/* Chevron + action buttons — siblings of the row button (see comment above) */}
        <span className="flex shrink-0 items-center gap-0.5 pr-2">
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={
                isFavorite ? t("workspace.remove_from_favorites") : t("workspace.add_to_favorites")
              }
              onClick={onToggleFavorite}
              className="inline-flex size-11 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Star
                className="size-4"
                fill={isFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-label={t("ssh.remove_connection")}
              onClick={onRemove}
              className="inline-flex size-11 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-[var(--state-error-fg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </div>

      {/* Per-row error strip — below the row button, redundant encoding: icon + border + color */}
      {hasError ? (
        <ErrorNotice
          message={errorHuman}
          className="mx-2 mb-1 px-2 py-1.5"
          textClass="text-app-micro"
        />
      ) : null}
    </li>
  );
}
