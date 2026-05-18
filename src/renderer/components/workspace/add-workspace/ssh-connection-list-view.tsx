import { AlertCircle, ChevronRight, LoaderCircle, Plus, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import { ipcCall, ipcCallResult } from "../../../ipc/client";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { formatProfileSubtitle } from "./ssh-helpers";
import type { SshBrowseSession, SshConnectionListViewProps } from "./types";

// ---------------------------------------------------------------------------
// SshConnectionListView — T4 implementation
// SSH server list: saved profiles + always-last New Connection row.
// Empty list shows EmptyState above the New Connection row.
// ---------------------------------------------------------------------------

export function SshConnectionListView({
  onNewConnection,
  onConnected,
}: SshConnectionListViewProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorHuman, setErrorHuman] = useState<string | null>(null);

  const loadProfiles = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    ipcCall("connectionProfile", "list", undefined)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
      const result = await ipcCallResult("ssh", "openBrowseSession", {
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: profile.authMode as "interactive" | "key-only",
      });
      if (!result.ok) {
        // User cancelled the SSH auth prompt — silent stop, no error banner.
        if (result.kind === "cancelled") return;
        setErrorId(profile.id);
        setErrorHuman(result.message);
        return;
      }
      // Update usage record
      await ipcCall("connectionProfile", "save", {
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
    }
  }

  async function toggleFavorite(
    profile: ConnectionProfile,
    event: React.MouseEvent,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("connectionProfile", "setFavorite", {
        id: profile.id,
        favorite: !profile.favorite,
      });
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
      await ipcCall("connectionProfile", "remove", { id: profile.id });
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
      <Skeleton label="Loading connections…" className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Empty state — shown above New Connection row when no profiles */}
      {!hasContent ? (
        <EmptyState
          tone="status"
          icon={<Server className="size-6" aria-hidden="true" />}
          title="No saved connections"
          description="Add a connection to browse its folders."
          className="py-6"
        />
      ) : null}

      {/* Favorites section */}
      {favorites.length > 0 ? (
        <section aria-label="Favorites">
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase text-muted-foreground">Favorites</span>
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
        <section aria-label="Recent" className={favorites.length > 0 ? "mt-3" : undefined}>
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase text-muted-foreground">Recent</span>
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
          <span className="min-w-0 truncate">New Connection…</span>
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
              {connecting ? "Connecting…" : subtitle}
            </span>
          </span>
        </button>

        {/* Chevron + action buttons — siblings of the row button (see comment above) */}
        <span className="flex shrink-0 items-center gap-0.5 pr-2">
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
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
              aria-label="Remove connection"
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
        <div
          className="mx-2 mb-1 flex items-start gap-2 rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-2 py-1.5"
          role="alert"
        >
          <AlertCircle
            className="mt-0.5 size-3.5 shrink-0 text-[var(--state-error-fg)]"
            aria-hidden="true"
          />
          <span className="min-w-0 text-app-micro text-[var(--state-error-fg)]">{errorHuman}</span>
        </div>
      ) : null}
    </li>
  );
}
